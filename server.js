const express = require('express');
const path = require('path');
const fs = require('fs');
const registrationService = require('./services/registration');

function readConfig() {
  const config = { PORT: '3032', HOST: '127.0.0.1', DEFAULT_CONCURRENCY: '2' };
  const file = path.join(__dirname, 'config.txt');
  if (!fs.existsSync(file)) return config;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (match && match[2]) config[match[1]] = match[2];
  }
  return config;
}

const config = readConfig();
const app = express();
const PORT = Number(process.env.PORT || config.PORT || 3032);
const HOST = process.env.HOST || config.HOST || '127.0.0.1';

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function isRegistrationAccount(account) {
  if (!account?.email || !account?.emailServiceUrl) return false;
  try {
    const url = new URL(account.emailServiceUrl);
    return account.email.includes('@') && ['http:', 'https:'].includes(url.protocol);
  } catch (error) {
    return false;
  }
}

function duplicateAccountLines(accounts) {
  const seenEmails = new Map();
  const seenLinks = new Map();
  const duplicateLines = new Set();
  accounts.forEach((account, index) => {
    const line = index + 1;
    const email = String(account.email).trim().toLowerCase();
    const link = String(account.emailServiceUrl).trim().replace(/\/$/, '');
    if (seenEmails.has(email)) {
      duplicateLines.add(seenEmails.get(email));
      duplicateLines.add(line);
    } else seenEmails.set(email, line);
    if (seenLinks.has(link)) {
      duplicateLines.add(seenLinks.get(link));
      duplicateLines.add(line);
    } else seenLinks.set(link, line);
  });
  return [...duplicateLines].sort((a, b) => a - b);
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'chatgpt-register-only', timestamp: new Date().toISOString() });
});

app.get('/api/accounts', (req, res) => {
  res.json({ success: true, data: registrationService.getAccounts() });
});

app.post('/api/register', async (req, res) => {
  try {
    const { accounts, concurrency } = req.body || {};
    if (!Array.isArray(accounts) || accounts.length === 0) {
      return res.status(400).json({ success: false, error: '请提供要注册的邮箱列表' });
    }
    if (accounts.length > 1000 || accounts.some(account => !isRegistrationAccount(account))) {
      return res.status(400).json({ success: false, error: '每行必须是有效的“邮箱----验证码收件链接”格式' });
    }
    const duplicateLines = duplicateAccountLines(accounts);
    if (duplicateLines.length) {
      return res.status(400).json({ success: false, error: `检测到重复邮箱或接码链接，重复行：${duplicateLines.join('、')}`, duplicateLines });
    }
    const requestedConcurrency = concurrency == null || concurrency === ''
      ? Number(config.DEFAULT_CONCURRENCY || 2)
      : Number(concurrency);
    if (requestedConcurrency != null &&
        (!Number.isInteger(requestedConcurrency) || requestedConcurrency < 1 || requestedConcurrency > 10)) {
      return res.status(400).json({ success: false, error: '注册并发数必须是 1-10 的整数' });
    }
    const jobId = await registrationService.startBatchRegistration(accounts, requestedConcurrency);
    const job = registrationService.getJob(jobId);
    res.status(202).json({ success: true, data: { jobId, total: job?.total || accounts.length } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/register/:jobId', (req, res) => {
  const job = registrationService.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: '注册任务不存在' });
  res.json({ success: true, data: job });
});

app.post('/api/register/:jobId/control', async (req, res) => {
  try {
    const action = req.body?.action;
    let job;
    if (action === 'pause') job = registrationService.setJobPaused(req.params.jobId, true);
    else if (action === 'resume') job = registrationService.setJobPaused(req.params.jobId, false);
    else if (action === 'force-pause') job = await registrationService.forcePauseJob(req.params.jobId);
    else return res.status(400).json({ success: false, error: '不支持的任务控制操作' });
    if (!job) return res.status(404).json({ success: false, error: '注册任务不存在' });
    res.json({ success: true, data: job });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/export', (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=registration_sessions_${Date.now()}.json`);
  res.json(registrationService.getAccounts());
});

app.listen(PORT, HOST, () => console.log(`纯注册服务已启动: http://${HOST}:${PORT}`));
