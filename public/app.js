const state = { jobId: null, running: false, timer: null, accounts: [], renderedLogs: new Set(), controlInFlight: false };
const $ = id => document.getElementById(id);
const terminal = new Set(['completed', 'no_trial', 'failed']);

function parseAccounts(value) {
  return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    const separator = line.indexOf('----');
    if (separator <= 0) return null;
    const email = line.slice(0, separator).trim();
    const emailServiceUrl = line.slice(separator + 4).trim();
    try {
      const url = new URL(emailServiceUrl);
      return email.includes('@') && ['http:', 'https:'].includes(url.protocol)
        ? { email, emailServiceUrl, mailType: 'web' } : null;
    } catch (error) { return null; }
  }).filter(Boolean);
}

function duplicateAccountLines(accounts) {
  const emails = new Map();
  const links = new Map();
  const duplicates = new Set();
  accounts.forEach((account, index) => {
    const line = index + 1;
    const email = account.email.trim().toLowerCase();
    const link = account.emailServiceUrl.trim().replace(/\/$/, '');
    if (emails.has(email)) { duplicates.add(emails.get(email)); duplicates.add(line); }
    else emails.set(email, line);
    if (links.has(link)) { duplicates.add(links.get(link)); duplicates.add(line); }
    else links.set(link, line);
  });
  return [...duplicates].sort((a, b) => a - b);
}

function updateInputCheck() {
  const lines = $('accountsInput').value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const accounts = parseAccounts($('accountsInput').value);
  const duplicateLines = duplicateAccountLines(accounts);
  $('parsedCount').textContent = `${accounts.length}/${lines.length} 个账号`;
  const warning = $('duplicateWarning');
  warning.hidden = !duplicateLines.length;
  warning.textContent = duplicateLines.length ? `重复邮箱或链接：第 ${duplicateLines.join('、')} 行` : '';
  $('startButton').disabled = state.running || duplicateLines.length > 0;
}

function statusLabel(status) {
  return ({ pending: '等待中', queued: '排队中', running: '注册中', completed: '成功', no_trial: '无免费试用', failed: '失败' })[status] || status || '未知';
}

function toast(message) {
  $('toast').textContent = message;
  $('toast').classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $('toast').classList.remove('show'), 2800);
}

async function copyText(value) {
  try { await navigator.clipboard.writeText(value); } catch (error) {
    const input = document.createElement('textarea'); input.value = value; input.style.position = 'fixed'; input.style.opacity = '0';
    document.body.appendChild(input); input.select(); document.execCommand('copy'); input.remove();
  }
}

function renderSummary() {
  const statuses = state.accounts.map(account => account.status || 'pending');
  $('totalCount').textContent = statuses.length;
  $('runningCount').textContent = statuses.filter(status => ['pending', 'queued', 'running'].includes(status)).length;
  $('successCount').textContent = statuses.filter(status => ['completed', 'no_trial'].includes(status)).length;
  $('failedCount').textContent = statuses.filter(status => status === 'failed').length;
}

function addCopyButton(cell, label, value, message) {
  const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.disabled = !value;
  button.addEventListener('click', async () => { await copyText(value); toast(message); }); cell.appendChild(button);
}

function renderResults() {
  renderSummary();
  const body = $('resultsBody'); body.replaceChildren();
  $('emptyState').hidden = state.accounts.length > 0; $('resultsTable').hidden = state.accounts.length === 0;
  for (const account of state.accounts) {
    const row = document.createElement('tr');
    const identity = document.createElement('td');
    const email = document.createElement('div'); email.textContent = account.email || '-'; identity.appendChild(email);
    if (account.emailServiceUrl) { const link = document.createElement('a'); link.className = 'mail-link'; link.href = account.emailServiceUrl; link.target = '_blank'; link.rel = 'noreferrer'; link.textContent = account.emailServiceUrl; identity.appendChild(link); }
    const status = document.createElement('td'); const badge = document.createElement('span'); badge.className = `status ${account.status || 'pending'}`; badge.textContent = statusLabel(account.status); status.appendChild(badge);
    if (account.error) { const error = document.createElement('div'); error.className = 'error'; error.textContent = account.error; status.appendChild(error); }
    const password = document.createElement('td'); password.textContent = account.password || '-'; if (account.password) addCopyButton(password, '复制', account.password, 'Password 已复制');
    const session = document.createElement('td'); const sessionValue = account.sessionContent || (account.sessionData ? JSON.stringify(account.sessionData) : ''); addCopyButton(session, '复制完整 Session', sessionValue, '完整 Session 已复制');
    row.append(identity, status, password, session); body.appendChild(row);
  }
}

function renderLogs(accounts) {
  const container = $('logs');
  for (const account of accounts) for (const item of account.logs || []) {
    const key = `${account.email}|${item.time}|${item.message}`; if (state.renderedLogs.has(key)) continue;
    state.renderedLogs.add(key); const line = document.createElement('div'); line.className = 'log-line'; line.textContent = `[${new Date(item.time).toLocaleTimeString('zh-CN', { hour12: false })}] ${account.email}  ${item.message}`; container.appendChild(line);
  }
  container.scrollTop = container.scrollHeight;
}

function stopPolling() {
  if (state.timer) clearInterval(state.timer); state.timer = null; state.running = false;
  $('startButton').disabled = false; $('startButton').textContent = '开始注册'; $('pauseButton').disabled = true; $('forcePauseButton').disabled = true;
}

async function pollJob() {
  if (!state.jobId) return;
  try {
    const response = await fetch(`/api/register/${encodeURIComponent(state.jobId)}`, { cache: 'no-store' }); const payload = await response.json();
    if (!payload.success) throw new Error(payload.error || '任务状态读取失败');
    const job = payload.data; state.accounts = job.accounts || []; renderResults(); renderLogs(state.accounts);
    const done = state.accounts.filter(account => terminal.has(account.status)).length; const total = job.total || state.accounts.length;
    $('progressFill').style.width = `${total ? Math.round(done / total * 100) : 0}%`; $('progressNumbers').textContent = `${done}/${total}`;
    $('progressText').textContent = ({ running: '正在注册', paused: '已暂停领取新邮箱，在途账号继续完成', completed: '注册任务已完成', failed: '注册任务失败' })[job.status] || job.status; $('jobStatus').textContent = $('progressText').textContent;
    $('pauseButton').textContent = job.status === 'paused' ? '继续' : '暂停';
    if (['completed', 'failed', 'force-paused'].includes(job.status)) { stopPolling(); toast(`注册完成：成功 ${state.accounts.filter(a => a.status === 'completed').length}，无试用 ${state.accounts.filter(a => a.status === 'no_trial').length}，失败 ${state.accounts.filter(a => a.status === 'failed').length}`); }
  } catch (error) { stopPolling(); toast(error.message); }
}

async function startRegistration() {
  if (state.running) return;
  const lines = $('accountsInput').value.split(/\r?\n/).map(line => line.trim()).filter(Boolean); const accounts = parseAccounts($('accountsInput').value); const concurrency = Number($('concurrencyInput').value);
  if (!lines.length) return toast('请输入邮箱和验证码链接'); if (accounts.length !== lines.length) return toast('存在无效行，格式必须是“邮箱----验证码收件链接”');
  const duplicateLines = duplicateAccountLines(accounts); if (duplicateLines.length) return toast(`检测到重复邮箱或链接：第 ${duplicateLines.join('、')} 行`);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) return toast('注册并发数必须是 1-10 的整数');
  state.running = true; state.accounts = accounts.map(account => ({ ...account, status: 'pending', logs: [] })); state.renderedLogs.clear(); $('logs').replaceChildren(); $('logs').classList.add('show'); $('progressArea').classList.add('show'); $('progressFill').style.width = '0%'; $('progressNumbers').textContent = `0/${accounts.length}`; $('progressText').textContent = '正在启动'; $('jobStatus').textContent = '启动中'; $('startButton').disabled = true; $('startButton').textContent = '注册中'; $('pauseButton').disabled = false; $('forcePauseButton').disabled = false; renderResults();
  try { const response = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accounts, concurrency }) }); const payload = await response.json(); if (!payload.success) throw new Error(payload.error || '注册任务启动失败'); state.jobId = payload.data.jobId; await pollJob(); if (state.running) state.timer = setInterval(pollJob, 1000); } catch (error) { stopPolling(); toast(error.message); }
}

async function controlJob(action) {
  if (!state.jobId || state.controlInFlight) return; state.controlInFlight = true; $('pauseButton').disabled = true; $('forcePauseButton').disabled = true;
  try { const response = await fetch(`/api/register/${encodeURIComponent(state.jobId)}/control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) }); const payload = await response.json(); if (!payload.success) throw new Error(payload.error || '任务控制失败'); await pollJob(); } catch (error) { toast(error.message); } finally { state.controlInFlight = false; if (state.running) { $('pauseButton').disabled = false; $('forcePauseButton').disabled = false; } }
}

async function refresh() { if (state.jobId) await pollJob(); else { const response = await fetch('/api/accounts'); const payload = await response.json(); state.accounts = payload.data || []; renderResults(); } toast('已刷新'); }
function exportResults() { window.location.href = '/api/export'; }

$('accountsInput').addEventListener('input', updateInputCheck);
$('startButton').addEventListener('click', startRegistration); $('pauseButton').addEventListener('click', () => controlJob($('pauseButton').textContent === '继续' ? 'resume' : 'pause')); $('forcePauseButton').addEventListener('click', () => controlJob('force-pause')); $('refreshButton').addEventListener('click', refresh); $('exportButton').addEventListener('click', exportResults);
renderResults(); updateInputCheck(); refresh();
