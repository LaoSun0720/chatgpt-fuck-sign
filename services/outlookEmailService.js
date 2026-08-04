const { spawn } = require('child_process');
const path = require('path');

class OutlookEmailService {
  constructor() {
    this.scriptPath = path.join(__dirname, '..', 'scripts', 'outlook_otp.py');
  }

  isOutlookAccount(account = {}) {
    return Boolean(account.clientId && account.refreshToken);
  }

  _validate(account) {
    if (!account?.email || !account?.clientId || !account?.refreshToken) {
      throw new Error('Outlook 取码需要 email、client_id 和 refresh_token');
    }
  }

  async waitForVerificationCode(account, options = {}) {
    this._validate(account);
    const configuredTimeout = Number(options.maxWaitMs ?? process.env.EMAIL_POLL_TIMEOUT_MS ?? 0);
    const payload = {
      email: account.email,
      client_id: account.clientId,
      refresh_token: account.refreshToken,
      not_before: options.notBefore ? new Date(options.notBefore).getTime() / 1000 : Date.now() / 1000,
      timeout_sec: configuredTimeout > 0 ? Math.ceil(configuredTimeout / 1000) : 0,
      poll_interval_sec: Math.max(1, Math.ceil(Number(options.intervalMs) || 5000) / 1000)
    };

    const pythonBin = process.env.PYTHON_BIN || 'python';
    return new Promise((resolve, reject) => {
      const child = spawn(pythonBin, ['-u', this.scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      let pollAttempt = 0;
      let pollCallbackRunning = false;
      const pollTimer = typeof options.onPoll === 'function'
        ? setInterval(async () => {
          if (settled || pollCallbackRunning) return;
          pollCallbackRunning = true;
          try {
            pollAttempt += 1;
            await options.onPoll(pollAttempt);
          } catch (error) {
            // Mail polling continues even if an optional UI/progress callback fails.
          } finally {
            pollCallbackRunning = false;
          }
        }, payload.poll_interval_sec * 1000)
        : null;
      const finish = (error, code) => {
        if (settled) return;
        settled = true;
        if (pollTimer) clearInterval(pollTimer);
        if (error) return reject(error);
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
        let response = null;
        try { response = JSON.parse(lines.at(-1) || '{}'); } catch (parseError) {}
        if (code === 0 && response?.ok && /^\d{6}$/.test(response.code || '')) {
          return resolve(response.code);
        }
        reject(new Error(response?.error || stderr.trim() || `Outlook 取码进程退出: ${code}`));
      };

      child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
      child.once('error', error => finish(new Error(`无法启动 Python Outlook 取码器: ${error.message}`)));
      child.once('close', code => finish(null, code));
      child.stdin.end(JSON.stringify(payload));
    });
  }
}

module.exports = new OutlookEmailService();
