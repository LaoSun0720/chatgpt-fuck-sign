/**
 * 邮箱验证码服务
 * 只接受点击注册按钮之后收到的新邮件，避免误用旧验证码。
 */

const axios = require('axios');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class EmailService {
  extractEmail(emailServiceUrl) {
    try {
      return new URL(emailServiceUrl).pathname.split('/')[3] || null;
    } catch (e) {
      return null;
    }
  }

  extractPath(emailServiceUrl) {
    try {
      return new URL(emailServiceUrl).pathname.split('/')[2] || null;
    } catch (e) {
      return null;
    }
  }

  _generateUrls(emailServiceUrl) {
    const urls = [emailServiceUrl];
    try {
      const url = new URL(emailServiceUrl);
      const pathParts = url.pathname.split('/');
      if (pathParts[1] === 'show' && pathParts.length >= 4) {
        const allMessagesUrl = new URL(url.href);
        allMessagesUrl.searchParams.set('n', '10');
        urls.push(allMessagesUrl.href);
        return [...new Set(urls)];
      }
      if (pathParts.length >= 4) {
        const basePath = pathParts[2];
        const email = pathParts[3];
        urls.push(`${url.origin}/messages/${basePath}/${email}/Spam`);
        urls.push(`${url.origin}/messages/${basePath}/${email}/Junk`);
        urls.push(`${url.origin}/messages/${basePath}/${email}/JunkEmail`);
        urls.push(`${url.origin}/messages/${basePath}/${email}?folder=Spam`);
        urls.push(`${url.origin}/messages/${basePath}/${email}?folder=Junk`);
      }
    } catch (e) {}
    return [...new Set(urls)];
  }

  _extractMessageLinks(html, baseUrl) {
    const links = [];
    const linkRegex = /<a\b([^>]*?)href=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = linkRegex.exec(html)) !== null) {
      const href = match[2].trim();
      const innerText = this._extractText(match[4]);
      if (!(
        href.includes('/message/') || href.includes('/messages/') ||
        href.includes('/read/') || href.includes('/view/') ||
        href.includes('id=') || href.includes('msg=') ||
        (innerText && innerText.length > 5)
      )) continue;

      let fullUrl;
      try {
        fullUrl = new URL(href, baseUrl).href;
      } catch (e) {
        continue;
      }

      // 邮件列表的时间经常位于链接同一行，而不在 a 标签内部。
      const nearbyHtml = html.slice(Math.max(0, match.index - 300), linkRegex.lastIndex + 300);
      links.push({
        url: fullUrl,
        title: innerText,
        timestamp: this.extractMessageTimestamp(nearbyHtml)
      });
    }

    const seen = new Set();
    return links.filter(link => {
      if (seen.has(link.url)) return false;
      seen.add(link.url);
      return true;
    });
  }

  async _fetchPage(url) {
    try {
      const response = await axios.get(url, {
        timeout: 15000,
        headers: {
          Accept: 'text/html,application/json,*/*',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        params: { _mail_poll: Date.now() }
      });
      return { success: true, data: response.data, url };
    } catch (error) {
      return { success: false, error: error.message, url };
    }
  }

  _extractText(html) {
    return String(html || '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&#39;/gi, "'")
      .replace(/&quot;/gi, '"')
      .replace(/\s+/g, ' ')
      .trim();
  }

  extractVerificationCode(textContent) {
    if (!textContent) return null;
    const patterns = [
      /(?:code|验证码|代码)[:\s]*(\d{6})/i,
      /(\d{6})[\s\S]{0,10}(?:登录|login|验证)/i,
      /(?:您的临时代码|临时登录代码)[:\s]*(\d{6})/i,
      /(?:你的|您的)[\s\S]{0,10}(?:临时|验证)[\s\S]{0,10}(?:代码|密码)[:\s]*(\d{6})/i,
      /(\d{6})(?:\s*是\s*你的|是\s*您的)/i,
      /(?:ChatGPT|OpenAI|chat[.\s]?gpt)[\s\S]{0,30}(\d{6})/i,
      /(\d{6})[\s\S]{0,20}(?:ChatGPT|OpenAI)/i
    ];

    for (const pattern of patterns) {
      const match = String(textContent).match(pattern);
      if (match && /^\d{6}$/.test(match[1])) return match[1];
    }

    const contextualMatches = String(textContent).match(/\b(\d{6})\b/g);
    if (contextualMatches && /(?:code|验证|登录|login|注册|sign|临时|ChatGPT|OpenAI)/i.test(textContent)) {
      return contextualMatches[0];
    }
    return null;
  }

  extractVerificationCodes(textContent) {
    const text = this._extractText(textContent);
    if (!/(?:code|验证|登录|login|注册|sign|临时|ChatGPT|OpenAI)/i.test(text)) return [];
    return [...new Set(text.match(/\b\d{6}\b/g) || [])];
  }

  _parseTimestamp(value) {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (value > 1e12) return value;
      if (value > 1e9) return value * 1000;
      return null;
    }
    if (typeof value !== 'string') return null;

    const raw = value.trim();
    if (!raw || /^\d{6}$/.test(raw)) return null;
    if (/^\d{10,13}$/.test(raw)) return this._parseTimestamp(Number(raw));

    let normalized = raw
      .replace(/[年/]/g, '-')
      .replace(/月/g, '-')
      .replace(/日/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (/^\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}(:\d{2})?$/.test(normalized)) {
      normalized = normalized.replace(' ', 'T');
    }

    const parsed = Date.parse(normalized);
    if (!Number.isFinite(parsed)) return null;
    const now = Date.now();
    // 排除模板年份、生日等明显不是邮件收件时间的值。
    if (parsed < now - 5 * 365 * 24 * 60 * 60 * 1000 || parsed > now + 24 * 60 * 60 * 1000) return null;
    return parsed;
  }

  extractMessageTimestamp(content) {
    const candidates = [];
    const add = value => {
      const parsed = this._parseTimestamp(value);
      if (parsed) candidates.push(parsed);
    };

    const walk = (value, keyHint = '', depth = 0) => {
      if (depth > 8 || value == null) return;
      if (Array.isArray(value)) {
        value.forEach(item => walk(item, keyHint, depth + 1));
        return;
      }
      if (typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
          if (/(?:received|sent|created|delivered|date|time|timestamp)/i.test(key)) add(child);
          walk(child, key, depth + 1);
        }
        return;
      }
      if (/(?:received|sent|created|delivered|date|time|timestamp)/i.test(keyHint)) add(value);
    };

    if (content && typeof content === 'object') {
      walk(content);
    } else {
      const raw = String(content || '');
      try {
        const parsedJson = JSON.parse(raw);
        walk(parsedJson);
      } catch (e) {}

      const attributeRegex = /(?:datetime|data-(?:timestamp|date|time)|content)=["']([^"']+)["']/gi;
      let match;
      while ((match = attributeRegex.exec(raw)) !== null) add(match[1]);

      const text = this._extractText(raw);
      const labelledRegex = /(?:received(?: at)?|sent(?: at)?|date|time|收件时间|发送时间|日期|时间)\s*[:：]?\s*([A-Za-z]{3},?\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:GMT|UTC|[+-]\d{4})?|\d{4}[年/.\-]\d{1,2}[月/.\-]\d{1,2}日?(?:[ T]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?)/gi;
      while ((match = labelledRegex.exec(text)) !== null) add(match[1]);

      const isoRegex = /\b(20\d{2}-\d{1,2}-\d{1,2}[T ]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\b/g;
      while ((match = isoRegex.exec(text)) !== null) add(match[1]);

      const numericDateRegex = /\b(\d{1,2}\/\d{1,2}\/20\d{2},?\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)\b/gi;
      while ((match = numericDateRegex.exec(text)) !== null) add(match[1]);
    }

    return candidates.length ? Math.max(...candidates) : null;
  }

  _messageIdentity(data, fallbackUrl) {
    if (data && typeof data === 'object') {
      const id = data.id || data.messageId || data.message_id || data.uid;
      if (id != null) return `id:${id}`;
    }
    return fallbackUrl;
  }

  _isEligibleMessage(timestamp, identity, notBefore, knownMessages) {
    if (!notBefore) return true;
    if (knownMessages && identity && knownMessages.has(identity)) return false;
    if (timestamp) return timestamp > notBefore;
    // 某些邮箱页面不暴露收件时间，此时只接受提交后新增的邮件 ID/URL。
    return Boolean(knownMessages && identity && !knownMessages.has(identity));
  }

  async captureMailboxState(emailServiceUrl) {
    const knownMessages = new Set();
    const knownCodes = new Set();
    const detailUrls = new Set();
    await Promise.all(this._generateUrls(emailServiceUrl).map(async url => {
      const pageResult = await this._fetchPage(url);
      if (!pageResult.success) return;
      knownMessages.add(url);
      if (typeof pageResult.data === 'string') {
        for (const code of this.extractVerificationCodes(pageResult.data)) knownCodes.add(code);
        for (const link of this._extractMessageLinks(pageResult.data, url)) {
          knownMessages.add(link.url);
          detailUrls.add(link.url);
        }
      } else {
        const collectIds = (value, depth = 0) => {
          if (!value || depth > 8) return;
          if (Array.isArray(value)) return value.forEach(item => collectIds(item, depth + 1));
          if (typeof value !== 'object') return;
          const identity = this._messageIdentity(value, null);
          if (identity) knownMessages.add(identity);
          Object.values(value).forEach(item => collectIds(item, depth + 1));
        };
        collectIds(pageResult.data);
        for (const item of this._jsonMessageCandidates(pageResult.data, url)) {
          knownCodes.add(item.code);
        }
      }
    }));

    // Some mailbox links expose message bodies through a stable `?all=1` URL.
    // Record the existing codes there so polling cannot reuse an older OTP.
    await Promise.all([...detailUrls].map(async url => {
      const pageResult = await this._fetchPage(url);
      if (!pageResult.success) return;
      if (typeof pageResult.data === 'string') {
        for (const code of this.extractVerificationCodes(pageResult.data)) knownCodes.add(code);
      } else {
        for (const item of this._jsonMessageCandidates(pageResult.data, url)) {
          knownCodes.add(item.code);
        }
      }
    }));

    return { knownMessages, knownCodes };
  }

  async captureMailboxSnapshot(emailServiceUrl) {
    return (await this.captureMailboxState(emailServiceUrl)).knownMessages;
  }

  captureMailboxSnapshotFromHtml(html, baseUrl) {
    const knownMessages = new Set([baseUrl]);
    for (const link of this._extractMessageLinks(String(html || ''), baseUrl)) {
      knownMessages.add(link.url);
    }
    return knownMessages;
  }

  _jsonMessageCandidates(data, fallbackUrl) {
    const candidates = [];
    const walk = (value, depth = 0) => {
      if (!value || depth > 8) return;
      if (Array.isArray(value)) return value.forEach(item => walk(item, depth + 1));
      if (typeof value !== 'object') return;

      const directFields = Object.fromEntries(Object.entries(value).filter(([, child]) =>
        child == null || ['string', 'number', 'boolean'].includes(typeof child)
      ));
      const text = JSON.stringify(directFields);
      const code = this.extractVerificationCode(text);
      const timestamp = this.extractMessageTimestamp(value);
      if (code && (timestamp || depth > 0)) {
        candidates.push({
          code,
          timestamp,
          identity: this._messageIdentity(value, fallbackUrl)
        });
      }
      Object.values(value).forEach(item => walk(item, depth + 1));
    };
    walk(data);
    return candidates.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  }

  /**
   * @param {string} emailServiceUrl
   * @param {object|number} optionsOrAttempts 新接口为 options；数字参数兼容旧调用。
   * @returns {Promise<string|null>}
   */
  async waitForVerificationCode(emailServiceUrl, optionsOrAttempts = {}, legacyIntervalMs = 5000) {
    const options = typeof optionsOrAttempts === 'number'
      ? { maxAttempts: optionsOrAttempts, intervalMs: legacyIntervalMs }
      : optionsOrAttempts;
    const intervalMs = Math.max(1000, Number(options.intervalMs) || 5000);
    const maxAttempts = Number.isFinite(options.maxAttempts) ? options.maxAttempts : Infinity;
    const maxWaitMs = Math.max(0, Number(options.maxWaitMs) || 0);
    const notBefore = options.notBefore ? new Date(options.notBefore).getTime() : null;
    const knownMessages = options.knownMessages instanceof Set
      ? options.knownMessages
      : new Set(options.knownMessages || []);
    const knownCodes = options.knownCodes instanceof Set
      ? options.knownCodes
      : new Set(options.knownCodes || []);
    const urlsToTry = this._generateUrls(emailServiceUrl);
    const startedAt = Date.now();

    console.log(`[邮箱服务] 开始轮询新验证码，邮件必须晚于: ${notBefore ? new Date(notBefore).toISOString() : '未限制'}`);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let refreshedInboxHtml = null;
      if (typeof options.beforePoll === 'function') {
        try {
          refreshedInboxHtml = await options.beforePoll(attempt + 1);
        } catch (error) {
          console.log(`[邮箱服务] 刷新邮箱页面失败: ${error.message}`);
        }
      }

      for (const url of urlsToTry) {
        const pageResult = url === emailServiceUrl && typeof refreshedInboxHtml === 'string'
          ? { success: true, data: refreshedInboxHtml, url }
          : await this._fetchPage(url);
        if (!pageResult.success) continue;

        if (typeof pageResult.data !== 'string') {
          const candidates = this._jsonMessageCandidates(pageResult.data, url);
          const found = candidates.find(item => !knownCodes.has(item.code) && this._isEligibleMessage(
            item.timestamp, item.identity, notBefore, knownMessages
          ));
          if (found) {
            console.log(`[邮箱服务] 获取到新验证码，邮件时间: ${found.timestamp ? new Date(found.timestamp).toISOString() : '邮箱未提供，按新邮件 ID 判断'}`);
            return found.code;
          }
          continue;
        }

        const html = pageResult.data;
        const messageLinks = this._extractMessageLinks(html, url);
        if (messageLinks.length) {
          for (const link of messageLinks) {
            // 列表中已经明确显示为旧邮件时，无需再请求正文。
            if (notBefore && link.timestamp && link.timestamp <= notBefore) continue;

            const msgResult = await this._fetchPage(link.url);
            if (!msgResult.success) continue;
            const timestamp = this.extractMessageTimestamp(msgResult.data) || link.timestamp;
            const codes = typeof msgResult.data === 'string'
              ? this.extractVerificationCodes(msgResult.data)
              : this._jsonMessageCandidates(msgResult.data, link.url).map(item => item.code);
            const code = codes.find(candidate => !knownCodes.has(candidate));
            if (!code) continue;

            // Stable aggregate URLs such as `?all=1` exist before registration but
            // their content changes. A code absent from the initial snapshot is new.
            const eligible = this._isEligibleMessage(timestamp, link.url, notBefore, knownMessages) ||
              (knownMessages.has(link.url) && !knownCodes.has(code));
            if (!eligible) continue;
            if (code && !knownCodes.has(code)) {
              console.log(`[邮箱服务] 获取到新验证码，邮件时间: ${timestamp ? new Date(timestamp).toISOString() : '邮箱未提供，按新邮件 URL 判断'}`);
              return code;
            }
          }
        }

        // 有些邮箱刷新后直接在列表显示验证码，没有可打开的邮件详情链接。
        if (url === emailServiceUrl) {
          const newCode = this.extractVerificationCodes(html).find(code => !knownCodes.has(code));
          if (newCode) {
            console.log('[邮箱服务] 从刷新后的邮箱页面获取到新验证码');
            return newCode;
          }
        } else if (!messageLinks.length) {
          const timestamp = this.extractMessageTimestamp(html);
          if (this._isEligibleMessage(timestamp, url, notBefore, knownMessages)) {
            const code = this.extractVerificationCode(this._extractText(html));
            if (code && !knownCodes.has(code)) return code;
          }
        }
      }

      if (typeof options.onPoll === 'function') await options.onPoll(attempt + 1);
      if (attempt + 1 >= maxAttempts || (maxWaitMs && Date.now() - startedAt >= maxWaitMs)) break;
      await sleep(intervalMs);
    }

    return null;
  }
}

module.exports = new EmailService();
