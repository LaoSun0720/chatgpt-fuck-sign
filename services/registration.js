/**
 * ChatGPT 注册自动化服务
 * 使用 Puppeteer 自动化注册流程
 * 
 * 注册流程（Auth0 OAuth 重定向）:
 * 1. 打开 ChatGPT 登录页
 * 2. 点击 Sign up → 自动跳转到 auth0.openai.com
 * 3. 在 auth0 页面输入邮箱
 * 4. 兼容 Password → 验证码 或 验证码 → Password
 * 5. 自动跳转回 ChatGPT → 获取 Session Token
 */

const browserService = require('./browser');
const emailService = require('./emailService');
const outlookEmailService = require('./outlookEmailService');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// 代替 page.waitForTimeout (Puppeteer 新版已移除)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 生成随机密码
function generatePassword(length = 16) {
  const groups = [
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    'abcdefghijklmnopqrstuvwxyz',
    '0123456789',
    '!@#$%^&*'
  ];
  const chars = groups.join('');
  const password = groups.map(group => group[crypto.randomInt(group.length)]);
  while (password.length < Math.max(12, length)) {
    password.push(chars[crypto.randomInt(chars.length)]);
  }
  for (let i = password.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [password[i], password[j]] = [password[j], password[i]];
  }
  return password.join('');
}

const ACCOUNTS_FILE = path.join(__dirname, '..', 'accounts.json');

class RegistrationService {
  constructor() {
    this.accounts = [];
    this.jobs = new Map();
    this._loadAccounts();
  }

  _loadAccounts() {
    try {
      if (fs.existsSync(ACCOUNTS_FILE)) {
        const data = fs.readFileSync(ACCOUNTS_FILE, 'utf-8');
        this.accounts = JSON.parse(data);
        console.log(`[注册服务] 已加载 ${this.accounts.length} 个已保存账户`);
      }
    } catch (e) {
      this.accounts = [];
    }
  }

  _saveAccounts() {
    try {
      fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(this.accounts, null, 2), 'utf-8');
      console.log(`[注册服务] 已保存 ${this.accounts.length} 个账户`);
      return true;
    } catch (e) {
      console.error('[注册服务] 保存账户失败:', e.message);
      return false;
    }
  }

  _storeAccountResult(result, required = false) {
    this.accounts = this.accounts.filter(account => account.email !== result.email);
    this.accounts.push(result);
    const saved = this._saveAccounts();
    if (required && !saved) throw new Error(`Session 持久化失败: ${result.email}`);
    return saved;
  }

  _createAccountRuntime(email, emailServiceUrl, context) {
    return {
      id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'),
      email,
      emailServiceUrl,
      context,
      chatPage: null,
      mailPage: null,
      sessionPage: null,
      verificationRequestedAt: null,
      knownMessages: new Set(),
      knownCodes: new Set(),
      sessionPersisted: false,
      cleanedUp: false,
      lifecycle: ['created']
    };
  }

  _attachRuntime(result, runtime) {
    if (!runtime) return;
    result.runtimeId = runtime.id;
    Object.defineProperty(result, 'runtime', {
      value: runtime,
      enumerable: false,
      configurable: true
    });
  }

  _assertRuntimePage(runtime, role) {
    const page = role === 'mail' ? runtime?.mailPage : runtime?.chatPage;
    if (!runtime || !page || (typeof page.isClosed === 'function' && page.isClosed())) {
      throw new Error(`${runtime?.email || '未知账号'} 的 ${role === 'mail' ? '邮箱' : 'ChatGPT'} 页面已关闭`);
    }
    const otherPage = role === 'mail' ? runtime.chatPage : runtime.mailPage;
    if (otherPage && page === otherPage) {
      throw new Error(`${runtime.email} 的 ChatGPT 页面与邮箱页面发生串页`);
    }
    if (typeof page.browserContext === 'function' && page.browserContext() !== runtime.context) {
      throw new Error(`${runtime.email} 的 ${role === 'mail' ? '邮箱' : 'ChatGPT'} 页面不属于该账号 Context`);
    }
    if (typeof page.url === 'function') {
      try {
        const actualHost = new URL(page.url()).hostname.toLowerCase();
        const mailHost = new URL(runtime.emailServiceUrl).hostname.toLowerCase();
        if (role === 'mail' && actualHost !== mailHost) {
          throw new Error(`${runtime.email} 的邮箱页面地址不匹配: ${actualHost}`);
        }
        if (role === 'chat' && actualHost === mailHost) {
          throw new Error(`${runtime.email} 的 ChatGPT 页面错误地指向了邮箱站点`);
        }
      } catch (error) {
        if (/页面地址不匹配|错误地指向/.test(error.message)) throw error;
      }
    }
    return page;
  }

  async _focusChatPage(runtime, stage) {
    const page = this._assertRuntimePage(runtime, 'chat');
    await page.bringToFront();
    runtime.lifecycle.push(`chat_focused:${stage || 'unspecified'}`);
    if (stage) console.log(`[${runtime.email}] 已切回对应 ChatGPT 页面: ${stage}`);
    return page;
  }

  async cleanupRuntime(runtime, closeContext = true) {
    if (!runtime || runtime.cleanedUp) return;
    runtime.cleanedUp = true;
    runtime.lifecycle.push('cleanup_started');
    for (const page of [runtime.sessionPage, runtime.mailPage, runtime.chatPage]) {
      if (!page || (typeof page.isClosed === 'function' && page.isClosed())) continue;
      try { await page.close(); } catch (e) {}
    }
    if (closeContext && runtime.context) {
      try { await browserService.closeContext(runtime.context); } catch (e) {}
    }
  }

  getAccounts() {
    return this.accounts;
  }

  getJob(jobId) {
    return this.jobs.get(jobId) || null;
  }

  getTerminalAccount(email) {
    const normalized = String(email || '').trim().toLowerCase();
    const account = this.accounts.find(account =>
      String(account.email || '').trim().toLowerCase() === normalized
    ) || null;
    if (!account) return null;

    if (account.status === 'completed' || account.status === 'no_trial') return account;

    // 旧版本把“无免费试用”记成失败；这是正常终态，避免再次注册。
    if (account.status === 'failed' && account.hasFreeTrial === false &&
        /未检测到.*免费试用/.test(String(account.error || ''))) {
      return { ...account, status: 'no_trial', error: null };
    }

    // A failed registration is never reusable state. It must enter the browser again,
    // regardless of the previous failure reason.
    return null;
  }

  _isChatHomeUrl(value) {
    try {
      const url = new URL(value);
      return (url.hostname === 'chatgpt.com' || url.hostname === 'chat.openai.com') &&
        !url.pathname.startsWith('/auth') && !url.pathname.startsWith('/login');
    } catch (error) {
      return false;
    }
  }

  setJobPaused(jobId, paused) {
    const job = this.getJob(jobId);
    if (!job) return null;
    if (!['running', 'paused'].includes(job.status)) return job;
    job.paused = Boolean(paused);
    job.status = job.paused ? 'paused' : 'running';
    job.updatedAt = new Date().toISOString();
    return job;
  }

  async forcePauseJob(jobId) {
    const job = this.getJob(jobId);
    if (!job) return null;
    if (['completed', 'failed', 'force-paused'].includes(job.status)) return job;
    job.forcePauseRequested = true;
    job.paused = false;
    job.status = 'force-pausing';
    job.updatedAt = new Date().toISOString();
    await browserService.close();
    return job;
  }

  /**
   * 等待页面加载，等待特定元素出现
   */
  async _waitForElement(page, selectors, timeout = 15000, visible = true) {
    const start = Date.now();
    const endTime = Date.now() + timeout;
    while (Date.now() < endTime) {
      for (const selector of selectors) {
        try {
          if (selector.startsWith('//')) {
            const [el] = await page.$x(selector);
            if (el) {
              if (!visible) return el;
              const box = await el.boundingBox();
              if (box) return el;
            }
          } else {
            const el = await page.$(selector);
            if (el) {
              if (!visible) return el;
              const box = await el.boundingBox();
              if (box) return el;
            }
          }
        } catch (e) { continue; }
      }
      await sleep(500);
    }
    return null;
  }

  /**
   * 等待页面 URL 变化到匹配某个模式
   */
  async _waitForUrlPattern(page, patterns, timeout = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const currentUrl = page.url();
      for (const pattern of patterns) {
        if (currentUrl.includes(pattern)) return currentUrl;
      }
      await sleep(500);
    }
    return null;
  }

  /**
   * 在页面中可靠地输入文本（逐个字符输入，模拟真人）
   */
  async _typeText(page, element, text, delay = 50) {
    await element.click();
    await sleep(300);
    // 先清空
    await element.evaluate(el => el.value = '');
    await sleep(200);
    // 逐字输入
    for (const char of text) {
      await element.type(char, { delay: Math.floor(delay * (0.5 + Math.random())) });
    }
  }

  /**
   * 尝试找到所有可见的输入框
   */
  async _findVisibleInput(page, type) {
    try {
      const inputs = await page.$$('input');
      for (const input of inputs) {
        const visible = await input.evaluate(el => {
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        });
        if (!visible) continue;
        const inputType = await input.evaluate(el => el.type);
        const inputId = await input.evaluate(el => el.id);
        const inputName = await input.evaluate(el => el.name);
        const inputPlaceholder = await input.evaluate(el => (el.placeholder || '').toLowerCase());
        if (type === 'email') {
          if (inputType === 'email' || inputName === 'email' || inputId === 'email' || 
              inputPlaceholder.includes('email') || inputPlaceholder.includes('邮箱')) {
            return input;
          }
        } else if (type === 'password') {
          if (inputType === 'password' || inputName === 'password' || inputId === 'password') {
            return input;
          }
        }
      }
      // 只有调用方明确请求 generic 时才兜底，避免把邮箱写进验证码框。
      if (type !== 'generic') return null;
      for (const input of inputs) {
        const visible = await input.evaluate(el => {
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        });
        if (visible) {
          const inputType = await input.evaluate(el => el.type);
          if (inputType === 'text' || inputType === 'email' || inputType === '') {
            return input;
          }
        }
      }
    } catch (e) {}
    return null;
  }

  async _findButtonByText(page, texts, timeout = 10000) {
    const expected = texts.map(text => text.toLowerCase());
    const endTime = Date.now() + timeout;
    while (Date.now() < endTime) {
      try {
        const handles = await page.$$('button, a, input[type="submit"], [role="button"]');
        for (const handle of handles) {
          const match = await handle.evaluate((element, values) => {
            const style = window.getComputedStyle(element);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
            const label = (element.innerText || element.value || element.getAttribute('aria-label') || '')
              .trim().toLowerCase();
            return values.some(value => label === value || label.includes(value));
          }, expected);
          if (match && await handle.boundingBox()) return handle;
        }
      } catch (e) {}
      await sleep(300);
    }
    return null;
  }

  async _fillEmail(page, email, timeout = 15000) {
    const selectors = [
      'input[type="email"]',
      'input[name="email"]',
      'input[name="username"]',
      'input[placeholder*="email" i]',
      'input[placeholder*="邮箱" i]',
      '#email',
      '#username',
      'input[autocomplete="email"]'
    ];
    const input = await this._waitForElement(page, selectors, timeout) || await this._findVisibleInput(page, 'email');
    if (!input) return false;
    const currentValue = await input.evaluate(element => element.value || '');
    if (currentValue.trim().toLowerCase() !== email.trim().toLowerCase()) {
      await this._typeText(page, input, email);
    }
    return true;
  }

  async _isVerificationPage(page) {
    try {
      return await page.evaluate(() => {
        const text = (document.body?.innerText || '').toLowerCase();
        const codeInput = document.querySelector(
          'input[autocomplete="one-time-code"], input[name="code"], input[name="otp"], input[inputmode="numeric"]'
        );
        return Boolean(codeInput) || /verification code|verify your email|验证码|验证你的邮箱/.test(text);
      });
    } catch (e) {
      return false;
    }
  }

  async _waitForRegistrationCheckpoint(page, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await this._findVisibleInput(page, 'password')) return 'password';
      if (await this._isVerificationPage(page)) return 'verification';
      if (await this._isAboutYouPage(page)) return 'about_you';
      if (this._isChatHomeUrl(page.url())) return 'chat_home';
      await sleep(250);
    }
    return 'unknown';
  }

  async _submitPasswordPage(page, password, progress, timeout = 5000) {
    const passwordInputSelectors = [
      'input[type="password"]',
      'input[name="password"]',
      'input[placeholder*="password" i]',
      '#password'
    ];
    const passwordInput = await this._waitForElement(page, passwordInputSelectors, timeout) ||
      await this._findVisibleInput(page, 'password');
    if (!passwordInput) return false;

    progress('检测到 Password 页面，设置并记录随机密码...');
    await this._typeText(page, passwordInput, password);
    await sleep(500);
    const submitButton = await this._waitForElement(page, ['button[type="submit"]'], 1500) ||
      await this._findButtonByText(page, ['Continue', '继续', 'Next', '下一步'], 2500);
    if (submitButton) await submitButton.click();
    else await page.keyboard.press('Enter');
    progress('✓ 随机密码已填写并提交');
    await sleep(1000);
    return true;
  }

  async _isAboutYouPage(page) {
    try {
      return await page.evaluate(() => {
        const text = (document.body?.innerText || '').toLowerCase();
        const hasProfileInput = Boolean(document.querySelector([
          'input[name="name"]', 'input[name="full_name"]', 'input[name="firstName"]',
          'input[name="age"]', 'input[name="birthday"]', 'input[name="birthdate"]',
          'input[name="dob"]', 'input[type="date"]', 'input[autocomplete="name"]'
        ].join(',')));
        return /about you|tell us about you|关于你|个人信息/.test(text) || hasProfileInput;
      });
    } catch (e) {
      return false;
    }
  }

  async _waitForFreeTrialOffer(page, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        const found = await page.evaluate(() => {
          const elements = Array.from(document.querySelectorAll('button, a, [role="button"]'));
          return elements.some(element => {
            const style = window.getComputedStyle(element);
            const visible = style.display !== 'none' && style.visibility !== 'hidden' &&
              element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
            const text = (element.innerText || element.textContent || '').trim().toLowerCase();
            return visible && /免费试用|free trial|try for free/.test(text);
          });
        });
        if (found) return true;
      } catch (e) {}
      await sleep(500);
    }
    return false;
  }

  async _readSessionEndpoint(page, context, expectedEmail, progress, timeout = 60000) {
    const endpoint = 'https://chatgpt.com/api/auth/session';
    const deadline = Date.now() + timeout;
    let lastError = null;

    while (Date.now() < deadline) {
      try {
        const response = await page.goto(endpoint, {
          waitUntil: 'domcontentloaded',
          timeout: 30000
        });
        const bodyText = await page.$eval('body', element => element.innerText);
        let sessionData = null;
        try {
          sessionData = JSON.parse(bodyText);
        } catch (e) {
          sessionData = await response.json();
        }

        const actualEmail = String(sessionData?.user?.email || '').trim().toLowerCase();
        if (!sessionData?.user) throw new Error('Session 接口尚未返回登录用户');
        if (expectedEmail && actualEmail !== String(expectedEmail).trim().toLowerCase()) {
          throw new Error(`Session 邮箱不匹配: ${actualEmail || '空'}`);
        }

        const cookies = typeof context.cookies === 'function'
          ? await context.cookies()
          : await page.cookies();
        const sessionCookies = cookies.filter(cookie => {
          const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
          return (domain === 'chatgpt.com' || domain.endsWith('.chatgpt.com')) &&
            /(?:session|auth|access.?token)/i.test(cookie.name) &&
            !/(?:csrf|callback|state)/i.test(cookie.name);
        });
        const accessToken = sessionData.accessToken || sessionData.user?.accessToken || null;
        const sessionCookie = sessionCookies[0] || null;
        progress(`✓ 已读取 /api/auth/session 完整内容: ${actualEmail}`);
        return {
          sessionData,
          sessionToken: accessToken || sessionCookie?.value || null,
          accessToken,
          sessionCookie,
          sessionContent: bodyText,
          sessionValues: { api: sessionData, raw: bodyText, cookies: sessionCookies }
        };
      } catch (error) {
        lastError = error;
        await sleep(2000);
      }
    }

    throw new Error(`60 秒内未能读取完整 Session: ${lastError?.message || '未知错误'}`);
  }

  async _setInputValue(element, value) {
    await element.evaluate((input, nextValue) => {
      const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      descriptor.set.call(input, nextValue);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
    }, value);
  }

  async _fillAgeOrBirthDate(page, progress) {
    const currentYear = new Date().getFullYear();
    const age = 20 + Math.floor(Math.random() * 15);
    const year = currentYear - age;
    const month = 1 + Math.floor(Math.random() * 12);
    const day = 1 + Math.floor(Math.random() * 28);
    const mm = String(month).padStart(2, '0');
    const dd = String(day).padStart(2, '0');

    const ageInput = await this._waitForElement(page, [
      'input[name="age"]',
      'input[name="userAge"]',
      'input[placeholder*="age" i]',
      'input[placeholder*="年龄" i]',
      'input[id*="age" i]'
    ], 1500);
    if (ageInput) {
      await this._typeText(page, ageInput, String(age));
      progress(`✓ 年龄已填写: ${age}`);
      return true;
    }

    const dateInput = await this._waitForElement(page, [
      'input[name="birthday"]',
      'input[name="birthdate"]',
      'input[name="dob"]',
      'input[name="date_of_birth"]',
      'input[type="date"]',
      'input[placeholder*="birth" i]',
      'input[placeholder*="MM/DD/YYYY" i]',
      'input[placeholder*="DD/MM/YYYY" i]',
      'input[placeholder*="YYYY-MM-DD" i]',
      'input[placeholder*="出生" i]',
      '#birthday',
      '#birthdate'
    ], 1500);
    if (dateInput) {
      const metadata = await dateInput.evaluate(element => ({
        type: element.type,
        placeholder: element.placeholder || '',
        lang: element.lang || document.documentElement.lang || ''
      }));
      let value = `${mm}/${dd}/${year}`;
      if (metadata.type === 'date' || /yyyy[-/]mm[-/]dd/i.test(metadata.placeholder)) {
        value = `${year}-${mm}-${dd}`;
      } else if (/dd[-/]mm[-/]yyyy/i.test(metadata.placeholder) || /^zh/i.test(metadata.lang)) {
        value = `${dd}/${mm}/${year}`;
      }
      try {
        await this._setInputValue(dateInput, value);
      } catch (e) {
        await this._typeText(page, dateInput, value);
      }
      progress(`✓ 出生日期已填写: ${value}`);
      return true;
    }

    // React Aria 等日期组件通常使用三个 spinbutton，而不是普通 input。
    const [monthSegment, daySegment, yearSegment] = await Promise.all([
      this._waitForElement(page, [
        '[role="spinbutton"][aria-label*="month" i]', '[aria-label*="月"]',
        '[contenteditable="true"][data-placeholder="MM"]'
      ], 800),
      this._waitForElement(page, [
        '[role="spinbutton"][aria-label*="day" i]', '[aria-label*="日"]',
        '[contenteditable="true"][data-placeholder="DD"]'
      ], 800),
      this._waitForElement(page, [
        '[role="spinbutton"][aria-label*="year" i]', '[aria-label*="年"]',
        '[contenteditable="true"][data-placeholder="YYYY"]'
      ], 800)
    ]);
    if (monthSegment && daySegment && yearSegment) {
      for (const [segment, value] of [
        [monthSegment, String(month)], [daySegment, String(day)], [yearSegment, String(year)]
      ]) {
        await segment.click({ clickCount: 3 });
        await page.keyboard.down('Control');
        try {
          await page.keyboard.press('A');
        } finally {
          await page.keyboard.up('Control');
        }
        await segment.type(value, { delay: 60 });
      }
      progress(`✓ 分段出生日期已填写: ${mm}/${dd}/${year}`);
      return true;
    }

    // 不支持键盘输入的自定义组件再用原生事件注入兜底。
    const segmentResult = await page.evaluate(({ year, month, day }) => {
      const findSegment = patterns => Array.from(document.querySelectorAll(
        '[role="spinbutton"], [contenteditable="true"], input'
      )).find(element => {
        const description = [
          element.getAttribute('aria-label'), element.getAttribute('data-placeholder'),
          element.getAttribute('name'), element.getAttribute('id'), element.getAttribute('placeholder')
        ].filter(Boolean).join(' ').toLowerCase();
        return patterns.some(pattern => description.includes(pattern));
      });
      const values = [
        [findSegment(['month', '月', 'mm']), String(month)],
        [findSegment(['day', '日', 'dd']), String(day)],
        [findSegment(['year', '年', 'yyyy']), String(year)]
      ];
      if (values.some(([element]) => !element)) return false;
      for (const [element, value] of values) {
        element.focus();
        if (element instanceof HTMLInputElement) {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(element, value);
        } else {
          element.textContent = value;
        }
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    }, { year, month, day }).catch(() => false);
    if (segmentResult) {
      progress(`✓ 分段出生日期已填写: ${mm}/${dd}/${year}`);
      return true;
    }

    const selects = await page.$$('select');
    if (selects.length) {
      const selectData = await Promise.all(selects.map(async select => ({
        select,
        meta: await select.evaluate(element => [
          element.name, element.id, element.getAttribute('aria-label')
        ].filter(Boolean).join(' ').toLowerCase()),
        options: await select.evaluate(element => Array.from(element.options).map(option => option.value))
      })));
      const choose = async (patterns, preferred) => {
        const item = selectData.find(entry => patterns.some(pattern => entry.meta.includes(pattern))) ||
          selectData.find(entry => entry.options.includes(String(preferred)));
        if (!item) return false;
        await item.select(String(preferred));
        selectData.splice(selectData.indexOf(item), 1);
        return true;
      };
      const selected = await choose(['month', '月'], month) &&
        await choose(['day', '日'], day) &&
        await choose(['year', '年'], year);
      if (selected) {
        progress(`✓ 下拉出生日期已选择: ${mm}/${dd}/${year}`);
        return true;
      }
      if (selects.length === 1 && await selects[0].evaluate((element, value) =>
        Array.from(element.options).some(option => option.value === value), String(age))) {
        await selects[0].select(String(age));
        progress(`✓ 年龄已选择: ${age}`);
        return true;
      }
    }
    return false;
  }

  async _fillPersonalInfo(page, progress) {
    if (this._isChatHomeUrl(page.url())) return true;
    const firstNames = [
      'James', 'Michael', 'Robert', 'John', 'David', 'William', 'Richard', 'Joseph', 'Thomas', 'Charles',
      'Christopher', 'Daniel', 'Matthew', 'Anthony', 'Mark', 'Donald', 'Steven', 'Andrew', 'Paul', 'Joshua',
      'Mary', 'Patricia', 'Jennifer', 'Linda', 'Elizabeth', 'Barbara', 'Susan', 'Jessica', 'Sarah', 'Karen',
      'Nancy', 'Lisa', 'Betty', 'Margaret', 'Sandra', 'Ashley', 'Kimberly', 'Emily', 'Donna', 'Michelle',
      'Amanda', 'Melissa', 'Deborah', 'Stephanie', 'Rebecca', 'Laura', 'Helen', 'Samantha', 'Olivia', 'Sophia'
    ];
    const lastNames = [
      'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez',
      'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin',
      'Lee', 'Perez', 'Thompson', 'White', 'Harris', 'Sanchez', 'Clark', 'Ramirez', 'Lewis', 'Robinson',
      'Walker', 'Young', 'Allen', 'King', 'Wright', 'Scott', 'Torres', 'Nguyen', 'Hill', 'Flores',
      'Green', 'Adams', 'Nelson', 'Baker', 'Hall', 'Rivera', 'Campbell', 'Mitchell', 'Carter', 'Roberts'
    ];
    const firstName = firstNames[Math.floor(Math.random() * firstNames.length)];
    const lastName = lastNames[Math.floor(Math.random() * lastNames.length)];
    const middleInitial = String.fromCharCode(65 + Math.floor(Math.random() * 26));
    const fullName = Math.random() < 0.35
      ? `${firstName} ${middleInitial}. ${lastName}`
      : `${firstName} ${lastName}`;

    const fullNameInput = await this._waitForElement(page, [
      'input[name="name"]', 'input[name="full_name"]', 'input[name="fullname"]',
      'input[autocomplete="name"]', 'input[placeholder="Full name" i]',
      'input[placeholder*="姓名" i]', '#name'
    ], 2500);
    let filled = false;
    if (fullNameInput) {
      await this._typeText(page, fullNameInput, fullName);
      progress(`✓ 姓名已填写: ${fullName}`);
      filled = true;
    } else {
      const [firstNameInput, lastNameInput] = await Promise.all([
        this._waitForElement(page, [
          'input[name="firstName"]', 'input[name="first_name"]',
          'input[autocomplete="given-name"]', 'input[placeholder*="first name" i]', '#firstName'
        ], 1200),
        this._waitForElement(page, [
          'input[name="lastName"]', 'input[name="last_name"]',
          'input[autocomplete="family-name"]', 'input[placeholder*="last name" i]', '#lastName'
        ], 1200)
      ]);
      if (firstNameInput) {
        await this._typeText(page, firstNameInput, firstName);
        if (lastNameInput) await this._typeText(page, lastNameInput, lastName);
        progress(`✓ 姓名已填写: ${firstName} ${lastName}`);
        filled = true;
      }
    }

    // 年龄页可能没有姓名框，所以必须独立检测。
    filled = await this._fillAgeOrBirthDate(page, progress) || filled;
    if (!filled) {
      // About You may finish navigating while selectors are being inspected.
      return this._isChatHomeUrl(page.url());
    }

    const submitButton = await this._waitForElement(page, ['button[type="submit"]'], 2000) ||
      await this._findButtonByText(page, ['Continue', '继续', 'Agree', '同意', 'Next', '下一步', 'Done', '完成'], 3000);
    if (submitButton) await submitButton.click();
    else await page.keyboard.press('Enter');
    progress('✓ 个人信息已提交');
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !this._isChatHomeUrl(page.url())) {
      await sleep(500);
    }
    return true;
  }

  async _getSession(page, context, getCapturedSession, progress, timeout = 60000, runtime = null) {
    const endTime = Date.now() + timeout;
    let mismatchReported = false;
    while (Date.now() < endTime) {
      let sessionData = getCapturedSession();
      if (!sessionData && page.url().includes('chatgpt.com')) {
        try {
          sessionData = await page.evaluate(async () => {
            const response = await fetch('/api/auth/session', { cache: 'no-store', credentials: 'include' });
            if (!response.ok) return null;
            return response.json();
          });
        } catch (e) {}
      }
      const sessionEmail = String(sessionData?.user?.email || '').trim().toLowerCase();
      const expectedEmail = String(runtime?.email || '').trim().toLowerCase();
      if (sessionEmail && expectedEmail && sessionEmail !== expectedEmail) {
        if (!mismatchReported) {
          progress(`⚠ Session 邮箱不匹配，忽略 ${sessionEmail}，继续等待 ${expectedEmail}`);
          mismatchReported = true;
        }
        sessionData = null;
      }

      let cookies = [];
      try {
        cookies = typeof context.cookies === 'function' ? await context.cookies() : await page.cookies();
      } catch (e) {}
      const sessionCookies = cookies.filter(cookie => {
        const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
        const isOpenAiDomain = domain === 'chatgpt.com' || domain.endsWith('.chatgpt.com') ||
          domain === 'openai.com' || domain.endsWith('.openai.com');
        return isOpenAiDomain && /(?:session|auth|access.?token)/i.test(cookie.name) &&
          !/(?:csrf|callback|state)/i.test(cookie.name);
      });
      let storage = { localStorage: {}, sessionStorage: {} };
      try {
        storage = await page.evaluate(() => {
          const collect = source => Object.fromEntries(Object.keys(source)
            .filter(key => /(?:session|auth|access.?token)/i.test(key))
            .map(key => [key, source.getItem(key)]));
          return { localStorage: collect(localStorage), sessionStorage: collect(sessionStorage) };
        });
      } catch (e) {}
      const sessionCookie = sessionCookies[0] || null;
      const storageValues = [
        ...Object.values(storage.localStorage || {}),
        ...Object.values(storage.sessionStorage || {})
      ];
      let storageToken = storageValues.find(value => typeof value === 'string' && value.split('.').length === 3) || null;
      if (!storageToken) {
        for (const value of storageValues) {
          try {
            const parsed = JSON.parse(value);
            storageToken = parsed?.accessToken || parsed?.access_token || null;
            if (storageToken) break;
          } catch (e) {}
        }
      }
      const apiToken = sessionData?.accessToken || sessionData?.user?.accessToken || null;
      const sessionToken = apiToken || storageToken || sessionCookie?.value || null;
      if (sessionToken) {
        const source = apiToken ? 'accessToken' : storageToken ? 'browser storage' : sessionCookie.name;
        progress(`✓ Session 获取成功: ${source}`);
        return {
          sessionData,
          sessionToken,
          accessToken: apiToken || storageToken || null,
          sessionCookie,
          sessionValues: { api: sessionData, cookies: sessionCookies, storage }
        };
      }
      await sleep(2000);
    }
    return {
      sessionData: getCapturedSession(),
      sessionToken: null,
      accessToken: null,
      sessionCookie: null,
      sessionValues: { api: getCapturedSession(), cookies: [], storage: {} }
    };
  }

  /**
   * 注册单个 ChatGPT 账号
   * @param {string} email - 邮箱地址
   * @param {string} emailServiceUrl - 邮箱服务URL（用于获取验证码）
   * @param {Function} onProgress - 进度回调
   * @param {Object} [context] - 可选的 Puppeteer BrowserContext，不传则自动创建
   */
  async registerAccount(email, emailServiceUrl, onProgress, context, mailOptions = {}) {
    const password = generatePassword();
    const result = {
      email,
      emailServiceUrl,
      password,
      sessionToken: null,
      sessionData: null,
      accessToken: null,
      sessionCookie: null,
      sessionValues: null,
      passwordSet: false,
      status: 'pending',
      error: null,
      timestamp: new Date().toISOString()
    };

    const progress = (msg) => {
      console.log(`[${email}] ${msg}`);
      if (onProgress) onProgress(msg);
    };

    let page = null;
    let ownContext = false;
    let runtime = null;

    try {
      // 如果没有传入 context，则创建一个新的默认上下文
      if (!context) {
        context = await browserService.createDefaultContext();
        ownContext = true;
      }
      runtime = this._createAccountRuntime(email, emailServiceUrl, context);
      this._attachRuntime(result, runtime);
      page = await browserService.createPage(context);
      runtime.chatPage = page;
      const useOutlookImap = outlookEmailService.isOutlookAccount(mailOptions);

      // ====== Step 1: 直接打开注册模式 ======
      progress('Step 1/5: 打开 ChatGPT 注册页面...');
      await page.goto('https://chatgpt.com/auth/login?show=signup', {
        waitUntil: 'networkidle2',
        timeout: 60000
      });
      await sleep(3000);

      // 请求验证码前记录已有邮件和验证码，之后只接受新出现的验证码。
      // 快照必须在填写邮箱之前完成，避免填写后等待邮箱网络请求，保证随后立即点击注册。
      let knownMessages = new Set();
      let knownCodes = new Set();
      if (useOutlookImap) {
        progress('✓ 使用 Outlook OAuth2 + IMAP 自动取码，不打开邮箱网页');
      } else {
        try {
          const mailboxState = await emailService.captureMailboxState(emailServiceUrl);
          knownMessages = mailboxState.knownMessages;
          knownCodes = mailboxState.knownCodes;
          progress('✓ 已识别邮箱收件链接，将在后台取码，不打开新标签页');
        } catch (error) {
          progress(`⚠ 获取旧邮件快照失败，仍会继续后台轮询: ${error.message}`);
        }
      }
      runtime.knownMessages = knownMessages;
      runtime.knownCodes = knownCodes;
      progress(`已记录 ${knownMessages.size} 个旧邮件标识、${knownCodes.size} 个旧验证码`);

      // ====== Step 2: 邮箱只输入一次，然后立即提交 ======
      progress('Step 2/5: 输入邮箱并立即开始注册...');
      const emailFilled = await this._fillEmail(page, email, 15000);
      if (!emailFilled) throw new Error('注册页面未找到邮箱输入框');
      progress('✓ 邮箱已输入，立即点击注册');

      const signupButton = await this._waitForElement(page, ['button[type="submit"]'], 4000) ||
        await this._findButtonByText(page, ['Continue', 'Sign up', 'Create account', '继续', '注册'], 6000);
      if (signupButton) await signupButton.click();
      else await page.keyboard.press('Enter');

      const verificationRequestedAt = new Date();
      runtime.verificationRequestedAt = verificationRequestedAt;
      result.verificationRequestedAt = verificationRequestedAt.toISOString();
      progress(`✓ 注册请求已提交: ${result.verificationRequestedAt}`);

      const firstCheckpoint = await this._waitForRegistrationCheckpoint(page, 10000);
      if (firstCheckpoint === 'password') {
        result.passwordSet = await this._submitPasswordPage(page, password, progress, 1000);
        if (!result.passwordSet) throw new Error('检测到 Password 页面，但未能填写随机密码');
        progress('✓ Password 步骤完成，开始等待验证码');
      } else if (firstCheckpoint === 'verification') {
        progress('✓ 已进入验证码页面，开始等待验证码');
      } else {
        progress(`当前注册页面状态: ${firstCheckpoint}，继续等待验证码`);
      }

      // ====== Step 4: 只获取提交时间之后的新验证码 ======
      progress('Step 3/5: 等待新验证码...');
      const configuredTimeout = Number(process.env.EMAIL_POLL_TIMEOUT_MS || 0);
      let resendTriggered = false;
      const verificationOptions = {
        notBefore: verificationRequestedAt,
        knownMessages,
        knownCodes,
        intervalMs: 1000,
        maxWaitMs: configuredTimeout,
        onPoll: async attempt => {
          const elapsedMs = Date.now() - verificationRequestedAt.getTime();
          if (!result.passwordSet) {
            if (await this._findVisibleInput(page, 'password')) {
              page = await this._focusChatPage(runtime, '填写 Password');
              result.passwordSet = await this._submitPasswordPage(page, password, progress, 1000);
              if (result.passwordSet) progress('✓ 等待验证码期间已完成 Password 步骤');
            }
          }
          if (attempt <= 7 || attempt % 10 === 0) {
            progress(`仍在等待新验证码... (${Math.floor(elapsedMs / 1000)}秒)`);
          }
          if (!resendTriggered && elapsedMs >= 17000) {
            page = await this._focusChatPage(runtime, '重新发送验证码');
            const resendButton = await this._findButtonByText(
              page, ['Resend', 'Send again', 'Resend code', '重新发送'], 3000
            );
            if (resendButton) {
              await resendButton.click();
              resendTriggered = true;
              progress('✓ 等待超过 17 秒，已重新发送一封验证码邮件');
            } else {
              progress('⚠ 等待超过 17 秒，但当前页面未找到重新发送按钮，将继续尝试');
            }
          }
        }
      };
      const verificationCode = useOutlookImap
        ? await outlookEmailService.waitForVerificationCode({
          email,
          clientId: mailOptions.clientId,
          refreshToken: mailOptions.refreshToken
        }, verificationOptions)
        : await emailService.waitForVerificationCode(emailServiceUrl, verificationOptions);

      if (!verificationCode) {
        throw new Error(`等待新验证码超时（${configuredTimeout}ms）`);
      }
      progress(`✓ 获取到提交后的新验证码: ${verificationCode}`);

      // ====== Step 5: 输入验证码并提交 ======
      progress('Step 4/5: 输入验证码...');
      page = await this._focusChatPage(runtime, '填写验证码');
      progress('✓ 已自动切回该账号的 ChatGPT 注册页');

      if (!result.passwordSet && await this._findVisibleInput(page, 'password')) {
        result.passwordSet = await this._submitPasswordPage(page, password, progress, 1000);
        if (!result.passwordSet) throw new Error('验证码已收到，但 Password 页面提交失败');
        const codeCheckpoint = await this._waitForRegistrationCheckpoint(page, 10000);
        if (codeCheckpoint !== 'verification') {
          throw new Error(`Password 已提交，但未进入验证码页面（当前状态: ${codeCheckpoint}）`);
        }
      }
      
      if (verificationCode) {
        const codeInputSelectors = [
          'input[type="text"]',
          'input[type="number"]',
          'input[inputmode="numeric"]',
          'input[autocomplete="one-time-code"]',
          'input[placeholder*="code" i]',
          'input[name="code"]',
          'input[name="otp"]',
          'input[data-testid*="code"]',
          'input:not([type="hidden"]):not([type="email"]):not([type="password"])'
        ];

        let codeInput = await this._waitForElement(page, codeInputSelectors, 10000);
        
        if (codeInput) {
          await this._typeText(page, codeInput, verificationCode, 80);
          progress('✓ 验证码已输入');
          await sleep(1000);
        } else {
          // 尝试 6 位分开的输入框
          try {
            const inputs = await page.$$('input');
            const visibleInputs = [];
            for (const input of inputs) {
              const visible = await input.evaluate(el => {
                const style = window.getComputedStyle(el);
                return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
              });
              if (visible) visibleInputs.push(input);
            }
            if (visibleInputs.length >= 6) {
              for (let i = 0; i < 6 && i < visibleInputs.length; i++) {
                await visibleInputs[i].click();
                await sleep(100);
                await visibleInputs[i].type(verificationCode[i], { delay: 80 });
              }
              progress('✓ 验证码已输入（6位分开）');
              await sleep(1000);
            }
          } catch (e) {
            progress(`⚠ 输入验证码失败: ${e.message}`);
          }
        }

        // ★ 关键修复：输入验证码后必须点击提交按钮
        progress('正在提交验证码...');
        const codeSubmitSelectors = [
          'button[type="submit"]',
          'button:has-text("Continue")',
          'button:has-text("继续")',
          'button:has-text("Verify")',
          'button:has-text("验证")',
          'button:has-text("Submit")',
          'button:has-text("提交")',
          'button:has-text("Confirm")',
          'button:has-text("确认")',
          'button:has-text("Next")',
          'button:has-text("下一步")',
          '//button[contains(text(), "Continue")]',
          '//button[contains(text(), "Verify")]',
          '//button[contains(text(), "Submit")]',
          '//button[contains(text(), "Confirm")]'
        ];

        let codeSubmitBtn = await this._waitForElement(page, codeSubmitSelectors, 5000);
        if (codeSubmitBtn) {
          await codeSubmitBtn.click();
          progress('✓ 验证码已提交');
        } else {
          // 尝试找页面上任何可点击的按钮
          try {
            const clicked = await page.evaluate(() => {
              const buttons = document.querySelectorAll('button, input[type="submit"], a[role="button"]');
              for (const btn of buttons) {
                const text = btn.textContent.toLowerCase().trim();
                if (text.includes('continue') || text.includes('verify') || text.includes('submit') || 
                    text.includes('confirm') || text.includes('next') || text.includes('继续') ||
                    text.includes('验证') || text.includes('提交') || text.includes('确认')) {
                  btn.click();
                  return text;
                }
              }
              return null;
            });
            if (clicked) {
              progress(`✓ 通过文本匹配点击了按钮: ${clicked}`);
            } else {
              await page.keyboard.press('Enter');
              progress('✓ 通过回车提交验证码');
            }
          } catch (e) {
            await page.keyboard.press('Enter');
            progress('✓ 通过回车提交验证码');
          }
        }
      }

      // 等待验证码验证通过和页面跳转
      progress('验证码已提交，等待约 1 秒进入 About You 或已有账号首页...');
      await sleep(1000);

      // 另一种页面顺序是“验证码 → Password → About You”。
      if (!result.passwordSet) {
        const postCodeCheckpoint = await this._waitForRegistrationCheckpoint(page, 10000);
        if (postCodeCheckpoint === 'password') {
          result.passwordSet = await this._submitPasswordPage(page, password, progress, 1000);
        }
      }
      if (result.passwordSet) await sleep(2000);

      if (this._isChatHomeUrl(page.url())) {
        progress('✓ 已有账号验证完成，已直接进入 ChatGPT，跳过姓名和年龄');
      }

      // ====== Step 5: 验证码提交约 1 秒后直接处理 About You ======
      progress(this._isChatHomeUrl(page.url())
        ? 'Step 5/5: 已有账号验证完成，跳过 About You...'
        : 'Step 5/5: 新账号填写 About You 姓名和年龄...');
      const personalInfoHandled = await this._fillPersonalInfo(page, progress);
      if (!personalInfoHandled && !this._isChatHomeUrl(page.url())) {
        throw new Error('About You 页面未能填写姓名或年龄');
      }

      // _fillPersonalInfo has already clicked Continue. The auth site can remain on
      // /about-you even though the profile was accepted, so open ChatGPT directly
      // instead of clicking the same form a second time or declaring failure.
      if (!this._isChatHomeUrl(page.url())) {
        progress('About You 已提交，正在直接打开 ChatGPT 首页确认...');
        await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(3000);
        if (!this._isChatHomeUrl(page.url())) {
          throw new Error(`About You 已提交，但页面未进入 ChatGPT 首页；当前 URL: ${page.url().substring(0, 100)}`);
        }
        progress('✓ 已进入 ChatGPT 首页');
      } else {
        progress('✓ About You 提交后已进入 ChatGPT 首页');
      }
      result.registrationCompleted = true;
      result.registrationCompletedAt = new Date().toISOString();
      progress('✓ 账号创建完成');

      // 旧版资料页兜底代码保留为兼容参考，但新状态机不会进入该分支。
      if (false && !personalInfoHandled) {
      
      const nameInputSelectors = [
        'input[name="name"]',
        'input[name="firstName"]',
        'input[name="full_name"]',
        'input[name="fullname"]',
        'input[placeholder*="name" i]',
        'input[placeholder*="姓名" i]',
        'input[autocomplete="name"]',
        'input[autocomplete="given-name"]',
        '#name',
        '#firstName'
      ];

      let nameInput = await this._waitForElement(page, nameInputSelectors, 8000);
      
      if (nameInput) {
        progress('检测到个人信息页面，正在填写姓名和出生日期...');
        
        // 生成随机姓名
        const firstNames = ['James', 'Michael', 'Robert', 'John', 'David', 'William', 'Richard', 'Joseph', 'Thomas', 'Charles',
                           'Mary', 'Patricia', 'Jennifer', 'Linda', 'Elizabeth', 'Barbara', 'Susan', 'Jessica', 'Sarah', 'Karen'];
        const lastNames = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez',
                          'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin'];
        const randomName = `${firstNames[Math.floor(Math.random() * firstNames.length)]} ${lastNames[Math.floor(Math.random() * lastNames.length)]}`;
        
        await this._typeText(page, nameInput, randomName);
        progress(`✓ 姓名已填写: ${randomName}`);
        await sleep(1000);

        // 查找出生日期输入框
        const birthdayInputSelectors = [
          'input[name="birthday"]',
          'input[name="birthdate"]',
          'input[name="dob"]',
          'input[name="date_of_birth"]',
          'input[type="date"]',
          'input[placeholder*="birth" i]',
          'input[placeholder*="birthday" i]',
          'input[placeholder*="MM/DD/YYYY"]',
          'input[placeholder*="出生" i]',
          '#birthday',
          '#birthdate'
        ];

        let birthdayInput = await this._waitForElement(page, birthdayInputSelectors, 5000);
        
        // 生成20-35岁之间的随机出生日期（复用）
        const currentYear = new Date().getFullYear();
        const birthYear = currentYear - 20 - Math.floor(Math.random() * 15); // 20-35岁
        const birthMonth = String(1 + Math.floor(Math.random() * 12)).padStart(2, '0');
        const birthDay = String(1 + Math.floor(Math.random() * 28)).padStart(2, '0');
        const randomAge = 20 + Math.floor(Math.random() * 15); // 20-35岁
        
        if (birthdayInput) {
          // 尝试多种日期格式
          const dateFormats = [
            `${birthMonth}/${birthDay}/${birthYear}`,    // MM/DD/YYYY
            `${birthYear}-${birthMonth}-${birthDay}`,    // YYYY-MM-DD
            `${birthDay}/${birthMonth}/${birthYear}`,    // DD/MM/YYYY
          ];

          let dateEntered = false;
          for (const dateStr of dateFormats) {
            try {
              await birthdayInput.click();
              await sleep(300);
              await birthdayInput.evaluate(el => el.value = '');
              await sleep(200);
              await birthdayInput.type(dateStr, { delay: 50 });
              await sleep(500);
              
              // 检查值是否被接受
              const enteredValue = await birthdayInput.evaluate(el => el.value);
              if (enteredValue) {
                dateEntered = true;
                progress(`✓ 出生日期已填写: ${dateStr}`);
                break;
              }
            } catch (e) {
              continue;
            }
          }

          if (!dateEntered) {
            // 如果 type 不行，尝试用 evaluate 直接设置值并触发事件
            try {
              const birthDateStr = `${birthMonth}/${birthDay}/${birthYear}`;
              await birthdayInput.evaluate((el, val) => {
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                nativeInputValueSetter.call(el, val);
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }, birthDateStr);
              progress(`✓ 出生日期已填写（JS注入）: ${birthDateStr}`);
            } catch (e) {
              progress(`⚠ 出生日期填写失败: ${e.message}`);
            }
          }
          await sleep(1000);
        } else {
          // 可能是年龄输入框（不是日期）
          progress('未找到日期输入框，尝试查找年龄输入框...');
          
          const ageInputSelectors = [
            'input[name="age"]',
            'input[name="userAge"]',
            'input[placeholder*="age" i]',
            'input[placeholder*="年龄" i]',
            'input[type="number"][name*="age" i]',
            '#age'
          ];
          
          let ageInput = await this._waitForElement(page, ageInputSelectors, 3000);
          
          if (ageInput) {
            // 直接填年龄数字
            await this._typeText(page, ageInput, String(randomAge));
            progress(`✓ 年龄已填写: ${randomAge}`);
            await sleep(1000);
          } else {
            // 也可能是分开的月/日/年下拉框
            progress('未找到年龄输入框，尝试下拉框选择...');
            try {
              const selects = await page.$$('select');
              if (selects.length >= 3) {
                const birthMonthNum = 1 + Math.floor(Math.random() * 12);
                await selects[0].select(String(birthMonthNum));
                await sleep(300);
                const birthDayNum = 1 + Math.floor(Math.random() * 28);
                await selects[1].select(String(birthDayNum));
                await sleep(300);
                const birthYearNum = birthYear;
                await selects[2].select(String(birthYearNum));
                progress(`✓ 出生日期已选择: ${birthMonthNum}/${birthDayNum}/${birthYearNum}`);
                await sleep(1000);
              } else if (selects.length === 1) {
                // 可能只有一个年龄选择下拉框
                try {
                  await selects[0].select(String(randomAge));
                  progress(`✓ 年龄已选择: ${randomAge}`);
                  await sleep(1000);
                } catch (e) {}
              }
            } catch (e) {
              progress(`⚠ 下拉框选择失败: ${e.message}`);
            }
          }
        }

        // 提交个人信息
        progress('正在提交个人信息...');
        const infoSubmitSelectors = [
          'button[type="submit"]',
          'button:has-text("Continue")',
          'button:has-text("继续")',
          'button:has-text("Agree")',
          'button:has-text("同意")',
          'button:has-text("Next")',
          'button:has-text("下一步")',
          'button:has-text("Done")',
          'button:has-text("完成")',
          'button:has-text("Finish")',
          '//button[contains(text(), "Continue")]',
          '//button[contains(text(), "Agree")]',
          '//button[contains(text(), "Done")]'
        ];

        let infoSubmitBtn = await this._waitForElement(page, infoSubmitSelectors, 5000);
        if (infoSubmitBtn) {
          await infoSubmitBtn.click();
          progress('✓ 个人信息已提交');
        } else {
          // 文本匹配兜底
          try {
            const clicked = await page.evaluate(() => {
              const buttons = document.querySelectorAll('button, a[role="button"]');
              for (const btn of buttons) {
                const text = btn.textContent.toLowerCase().trim();
                if (text.includes('continue') || text.includes('agree') || text.includes('done') || 
                    text.includes('finish') || text.includes('next') || text.includes('继续') ||
                    text.includes('同意') || text.includes('完成')) {
                  btn.click();
                  return text;
                }
              }
              return null;
            });
            if (clicked) {
              progress(`✓ 通过文本匹配点击: ${clicked}`);
            } else {
              await page.keyboard.press('Enter');
              progress('✓ 通过回车提交');
            }
          } catch (e) {
            await page.keyboard.press('Enter');
            progress('✓ 通过回车提交');
          }
        }
        await sleep(5000);
      } else {
        progress('未检测到个人信息页面，继续...');
      }
      }

      // ====== 注册完成：先检查免费试用，再读取 Session ======
      progress('等待注册完成并进入 ChatGPT 首页...');
      
      // 不能只匹配 chatgpt.com，否则 /auth/login 也会被误判成注册成功。
      let chatUrl = null;
      const chatDeadline = Date.now() + 60000;
      while (Date.now() < chatDeadline) {
        try {
          if (this._isChatHomeUrl(page.url())) {
            chatUrl = page.url();
            break;
          }
        } catch (e) {}
        await sleep(1000);
      }

      if (chatUrl) {
        progress('✓ 已进入聊天页面，注册成功！');
      } else {
        throw new Error('资料提交后未进入 ChatGPT 页面，拒绝关闭页面或重新注册提取 Session；当前 URL: ' + page.url().substring(0, 80));
      }

      progress('正在检查右上角是否出现“免费试用”...');
      const hasFreeTrial = await this._waitForFreeTrialOffer(page, 15000);
      result.hasFreeTrial = hasFreeTrial;
      if (!hasFreeTrial) {
        result.status = 'no_trial';
        result.error = null;
        result.completedAt = new Date().toISOString();
        this._storeAccountResult(result);
        progress('ℹ 账号注册完成，但没有免费试用；正常跳过提炼和扫码');
        return result;
      }
      progress('✓ 检测到“免费试用”，允许读取 Session');

      progress('检测通过，等待 3 秒让 Session 完整写入...');
      await sleep(3000);
      await this._focusChatPage(runtime, '保留首页并打开 Session 标签页');
      const sessionPage = await browserService.createPage(context);
      runtime.sessionPage = sessionPage;
      progress('正在同一账号环境的新标签页打开 /api/auth/session...');
      const session = await this._readSessionEndpoint(sessionPage, context, email, progress, 60000);
      result.sessionData = session.sessionData;
      result.sessionContent = session.sessionContent;
      result.sessionToken = session.sessionToken;
      result.accessToken = session.accessToken;
      result.sessionCookie = session.sessionCookie;
      result.sessionValues = session.sessionValues;
      if (!result.sessionData?.user) throw new Error('Session 页面未返回完整用户数据');
      runtime.lifecycle.push('session_extracted');
      result.status = 'completed';

      result.sessionPersistedAt = new Date().toISOString();
      this._storeAccountResult(result, true);
      runtime.sessionPersisted = true;
      runtime.lifecycle.push('session_persisted');
      progress(`✓ Session 已在关闭账号环境前持久化（runtime ${runtime.id.slice(0, 8)}）`);
      return result;

    } catch (err) {
      progress(`✗ 注册失败: ${err.message}`);
      result.status = 'failed';
      result.error = err.message;
      this._storeAccountResult(result);
      return result;
    } finally {
      // 外部传入的 Context 由流水线在提链/支付结束后清理，避免注册完成后过早关闭页面。
      if (ownContext && runtime) await this.cleanupRuntime(runtime, true);
    }
  }

  /**
   * 批量注册账号
   */
  async startBatchRegistration(accounts, requestedConcurrency) {
    const jobId = 'batch_' + Date.now();
    const uniqueInputs = [...new Map(accounts.map(input => [
      String(input.email || '').trim().toLowerCase(), input
    ])).values()];
    const jobAccounts = uniqueInputs.map(input => {
      const existing = this.getTerminalAccount(input.email);
      const account = {
        email: input.email,
        emailServiceUrl: input.emailServiceUrl || null,
        mailType: input.clientId && input.refreshToken ? 'outlook' : 'web',
        status: existing?.status || 'pending',
        result: existing || null,
        skipped: Boolean(existing),
        logs: existing ? [{
          time: new Date().toISOString(),
          message: `该邮箱已有终态记录（${existing.status}），本次跳过，不再重复注册`
        }] : []
      };
      Object.defineProperty(account, 'mailCredentials', {
        value: input.clientId && input.refreshToken
          ? { clientId: input.clientId, refreshToken: input.refreshToken }
          : {},
        enumerable: false
      });
      return account;
    });
    const job = {
      id: jobId,
      accounts: jobAccounts,
      total: jobAccounts.length,
      requestedTotal: accounts.length,
      requestedConcurrency: requestedConcurrency || null,
      status: 'running',
      paused: false,
      forcePauseRequested: false,
      startTime: new Date().toISOString(),
      results: []
    };
    Object.defineProperty(job, 'activeContexts', {
      value: new Set(),
      enumerable: false
    });

    this.jobs.set(jobId, job);

    // 异步执行
    this._executeBatch(job).catch(err => {
      console.error(`[批量注册] 异常:`, err);
      job.status = 'failed';
      job.error = err.message;
    });

    return jobId;
  }

  async _executeBatch(job) {
    let browserAcquired = false;
    try {
      job.results = job.accounts.map(account => account.result || null);
      const pendingTotal = job.accounts.filter(account => account.status === 'pending').length;
      if (pendingTotal === 0) {
        job.results = job.results.filter(Boolean);
        job.status = 'completed';
        job.endTime = new Date().toISOString();
        console.log(`[批量注册] ${job.total} 个邮箱均已有终态记录，本次未启动浏览器`);
        return;
      }

      const cpuCount = typeof os.availableParallelism === 'function'
        ? os.availableParallelism()
        : os.cpus().length;
      const configuredConcurrency = Number(job.requestedConcurrency || process.env.REGISTER_CONCURRENCY || 0);
      const concurrency = Math.max(1, Math.min(
        pendingTotal,
        10,
        configuredConcurrency > 0 ? configuredConcurrency : Math.min(10, Math.max(2, cpuCount))
      ));
      job.concurrency = concurrency;
      console.log(`[批量注册] 开始: ${job.total} 个账号，并发数 ${concurrency}`);

      // 先启动浏览器
      await browserService.acquire(false);
      browserAcquired = true;

      let nextIndex = 0;
      const runWorker = async workerId => {
        while (true) {
          while (job.paused && !job.forcePauseRequested) await sleep(250);
          if (job.forcePauseRequested) return;
          const i = nextIndex++;
          if (i >= job.accounts.length) return;
          const account = job.accounts[i];
          if (account.status !== 'pending') continue;
          console.log(`\n[批量注册] Worker ${workerId} 处理账号 ${i + 1}/${job.total}: ${account.email}`);
          let accountContext = null;

          try {
            account.status = 'running';
            let result = null;
            for (let registrationAttempt = 0; registrationAttempt < 2; registrationAttempt++) {
              if (job.forcePauseRequested) throw new Error('任务已强制暂停');
              accountContext = await browserService.createContext();
              job.activeContexts.add(accountContext);
              result = await this.registerAccount(
                account.email,
                account.emailServiceUrl,
                (msg) => {
                  account.logs.push({ time: new Date().toISOString(), message: msg });
                  console.log(`  [${account.email}] ${msg}`);
                },
                accountContext,
                account.mailCredentials
              );
              const shouldRetry = !job.forcePauseRequested && result.status !== 'completed' && registrationAttempt === 0 &&
                browserService.isConnectionError(new Error(result.error || ''));
              if (!shouldRetry) break;
              console.warn(`  [${account.email}] 浏览器连接中断，自动重启并重试一次`);
              if (result?.runtime) await this.cleanupRuntime(result.runtime, true).catch(() => {});
              else await browserService.closeContext(accountContext).catch(() => {});
              job.activeContexts.delete(accountContext);
              accountContext = null;
              await browserService.launch(false);
              await sleep(1000);
            }

            account.status = result.status;
            account.result = result;
            job.results[i] = result;
            console.log(`[批量注册] 账号 ${i + 1} ${result.status === 'completed' ? '✓ 成功' : '✗ 失败'}`);
          } catch (err) {
            console.error(`[批量注册] 账号 ${i + 1} 异常:`, err.message);
            account.status = 'failed';
            account.error = err.message;
          } finally {
            if (account.result?.runtime) await this.cleanupRuntime(account.result.runtime, true).catch(() => {});
            else if (accountContext) await browserService.closeContext(accountContext).catch(() => {});
            if (accountContext) job.activeContexts.delete(accountContext);
          }

          if (job.forcePauseRequested) return;
          // 每个 worker 自己错峰，避免所有账号同时提交请求。
          if (nextIndex < job.accounts.length) await sleep(1000 + Math.random() * 1500);
        }
      };

      await Promise.all(Array.from({ length: concurrency }, (_, index) => runWorker(index + 1)));

      if (job.forcePauseRequested) {
        for (const account of job.accounts) {
          if (account.status === 'pending' || account.status === 'running') {
            account.status = 'failed';
            account.error = '任务已强制暂停';
          }
        }
        job.status = 'force-paused';
        job.endTime = new Date().toISOString();
        return;
      }

      job.results = job.results.filter(Boolean);
      const success = job.results.filter(r => r.status === 'completed').length;
      console.log(`\n[批量注册] 完成: 成功 ${success}/${job.total}`);
      job.status = 'completed';
      job.endTime = new Date().toISOString();

    } catch (err) {
      console.error('[批量注册] 执行异常:', err);
      job.status = 'failed';
      job.error = err.message;
    } finally {
      if (browserAcquired) browserService.release();
    }
  }
}

module.exports = new RegistrationService();
