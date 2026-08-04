/**
 * 浏览器管理服务
 * 维护一个共享 Chrome，并为每个账号创建独立 BrowserContext。
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());

class BrowserService {
  constructor() {
    this.browser = null;
    this.isRunning = false;
    this.contexts = new Set();
    this.launchPromise = null;
    this.activeLeases = 0;
  }

  _getChromePath() {
    const paths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`
    ];
    for (const candidate of paths) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch (e) {}
    }
    return null;
  }

  _isBrowserConnected(browser = this.browser) {
    if (!browser) return false;
    try {
      if (typeof browser.connected === 'boolean') return browser.connected;
      if (typeof browser.isConnected === 'function') return browser.isConnected();
    } catch (e) {
      return false;
    }
    return this.isRunning;
  }

  _forgetBrowser(browser, reason) {
    if (browser && this.browser !== browser) return;
    if (reason) console.warn(`[浏览器] ${reason}`);
    this.browser = null;
    this.isRunning = false;
    this.contexts.clear();
  }

  _isConnectionError(error) {
    return /(?:connection closed|connection_closed|target closed|session closed|browser has disconnected|protocol error|socket hang up|econnreset)/i
      .test(error?.message || '');
  }

  isConnectionError(error) {
    return this._isConnectionError(error);
  }

  /** 启动浏览器。并发调用时只会真正启动一次。 */
  async launch(headless = false) {
    if (this._isBrowserConnected()) {
      this.isRunning = true;
      console.log('[浏览器] 使用现有浏览器实例');
      return this.browser;
    }

    if (this.browser) this._forgetBrowser(this.browser, '检测到旧浏览器连接已断开，准备重新启动');
    if (this.launchPromise) return this.launchPromise;

    this.launchPromise = (async () => {
      console.log('[浏览器] 正在启动浏览器...');
      const chromePath = this._getChromePath();
      const launchOptions = {
        headless: headless ? 'new' : false,
        timeout: 60000,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--window-size=1280,900',
          '--lang=zh-CN',
          '--disable-blink-features=AutomationControlled'
        ],
        defaultViewport: { width: 1280, height: 900 }
      };

      if (chromePath) {
        launchOptions.executablePath = chromePath;
        console.log(`[浏览器] 使用指定 Chrome 路径: ${chromePath}`);
      }

      const browser = await puppeteer.launch(launchOptions);
      this.browser = browser;
      this.isRunning = true;
      this.contexts.clear();
      browser.once('disconnected', () => {
        this._forgetBrowser(browser, 'Chrome 已断开；下个操作会自动重新启动');
      });
      console.log('[浏览器] 浏览器已启动');
      return browser;
    })();

    try {
      return await this.launchPromise;
    } finally {
      this.launchPromise = null;
    }
  }

  async acquire(headless = false) {
    const browser = await this.launch(headless);
    this.activeLeases += 1;
    return browser;
  }

  release() {
    this.activeLeases = Math.max(0, this.activeLeases - 1);
    console.log(`[浏览器] 任务已释放，活动任务 ${this.activeLeases} 个；共享浏览器保持运行`);
  }

  /** 创建独立环境；连接刚断开时自动重启并重试一次。 */
  async createContext() {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const browser = await this.launch(false);
      try {
        let context;
        if (typeof browser.createBrowserContext === 'function') {
          context = await browser.createBrowserContext();
        } else if (typeof browser.createIncognitoBrowserContext === 'function') {
          context = await browser.createIncognitoBrowserContext();
        } else {
          throw new Error('当前 Puppeteer 版本不支持创建浏览器上下文');
        }
        this.contexts.add(context);
        console.log(`[浏览器] 创建独立浏览器上下文 (活动记录 ${this.contexts.size} 个)`);
        return context;
      } catch (error) {
        lastError = error;
        if (attempt === 0 && this._isConnectionError(error)) {
          this._forgetBrowser(browser, `创建独立环境时连接断开，自动重启后重试: ${error.message}`);
          continue;
        }
        throw error;
      }
    }
    throw lastError || new Error('创建浏览器上下文失败');
  }

  async createDefaultContext() {
    return this.createContext();
  }

  async closeContext(context) {
    if (!context) return;
    try {
      await context.close();
    } catch (error) {
      if (!this._isConnectionError(error)) throw error;
    } finally {
      this.contexts.delete(context);
    }
  }

  async createPage(context) {
    if (!context) context = await this.createDefaultContext();
    const page = await context.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    );
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {}, loadTimes: function() {}, csi: function() {}, app: {} };
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = parameters => (
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters)
      );
    });
    page.setDefaultTimeout(60000);
    page.setDefaultNavigationTimeout(60000);
    return page;
  }

  async closeContexts() {
    const contexts = [...this.contexts];
    await Promise.all(contexts.map(context => this.closeContext(context).catch(() => {})));
    console.log('[浏览器] 所有独立浏览器上下文已关闭');
  }

  /** 仅服务进程退出或明确管理操作时调用。 */
  async close() {
    const browser = this.browser;
    await this.closeContexts();
    this._forgetBrowser(browser);
    this.activeLeases = 0;
    if (browser && this._isBrowserConnected(browser)) {
      try {
        await browser.close();
        console.log('[浏览器] 浏览器已关闭');
      } catch (error) {
        if (!this._isConnectionError(error)) console.error('[浏览器] 关闭浏览器时出错:', error.message);
      }
    }
  }
}

module.exports = new BrowserService();
