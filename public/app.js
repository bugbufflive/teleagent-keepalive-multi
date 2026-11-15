/* 多账号控制台前端：只做渲染 + 提交，业务逻辑都在服务端 */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const api = async (url, opts) => {
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
};
const post = (url, body) => api(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {})
});

const PHASE_TEXT = {
  idle: '待机', online: '在线保活', connecting: '连接中', error: '异常',
  paused: '让位中', disabled: '已停用', nologin: '未登录'
};
const PHASE_CLASS = { online: 'ok', error: 'err', paused: 'warn', connecting: 'warn', nologin: 'warn' };
const STATUS_TEXT = { 3: '已关机', 4: '运行中', 5: '排队中', 100: '运行中' };

const S = { accounts: [], notify: {}, selectedId: localStorage.getItem('ta.selected') || '', accSig: '' };

let toastTimer = null;
function toast(msg, bad) {
  const el = $('toast');
  el.textContent = msg;
  el.style.borderColor = bad ? 'var(--err)' : 'var(--line)';
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

const fmtTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('zh-CN', { hour12: false });
};

const sel = () => S.accounts.find((a) => a.id === S.selectedId) || null;

// ---------------- 列表 ----------------

function renderList() {
  const box = $('accList');
  if (!S.accounts.length) {
    box.innerHTML = '<p class="empty">还没有账号，点右上角「+ 新增账号」</p>';
    $('accCount').textContent = '';
    return;
  }
  $('accCount').textContent = `${S.accounts.length} 个`;
  box.innerHTML = S.accounts.map((a) => {
    const active = a.id === S.selectedId ? ' active' : '';
    const cls = PHASE_CLASS[a.phase] || '';
    const cookie = a.cookieDaysLeft != null ? `${a.cookieDaysLeft} 天` : (a.hasCookie ? '已配置' : '无');
    const ins = a.instanceStatus != null ? (STATUS_TEXT[a.instanceStatus] || a.instanceStatus) : '—';
    return `
      <div class="acc-item${active}" data-id="${esc(a.id)}">
        <div class="acc-top">
          <span class="dot ${cls}"></span>
          <b class="acc-name">${esc(a.name)}</b>
          <button class="mini ${a.enabled ? 'on' : ''}" data-toggle="${esc(a.id)}" title="启用/停用">${a.enabled ? '已启用' : '已停用'}</button>
        </div>
        <div class="acc-sub">${esc(a.account || 'Cookie 登录')} · ${esc(PHASE_TEXT[a.phase] || a.phase)}</div>
        <div class="acc-meta">
          <span>登录态 <b>${esc(cookie)}</b></span>
          <span>实例 <b>${esc(ins)}</b></span>
          <span>循环 <b>${a.cycles || 0}</b></span>
        </div>
      </div>`;
  }).join('');
}

// ---------------- 详情 ----------------

let authPanesReady = false;
function setAuthPane(mode) {
  document.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.auth === mode));
  $('paneCookie').classList.toggle('hidden', mode !== 'cookie');
  $('panePassword').classList.toggle('hidden', mode !== 'password');
  authPanesReady = true;
}

function renderDetail(force = false) {
  const a = sel();
  const has = !!a;
  $('detailBody').classList.toggle('hidden', !has);
  $('btnEnabled').disabled = !has;
  if (!has) {
    $('dName').textContent = '未选择账号';
    $('dPhase').textContent = '-';
    $('dPhase').className = 'badge';
    $('dStats').innerHTML = '';
    document.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
    return;
  }

  $('dName').textContent = a.name || a.account || a.id;
  $('dPhase').textContent = PHASE_TEXT[a.phase] || a.phase;
  $('dPhase').className = 'badge ' + (PHASE_CLASS[a.phase] || '');

  const cookie = a.cookieDaysLeft != null ? `${a.cookieDaysLeft} 天` : (a.hasCookie ? '已配置' : '无');
  const ins = a.instanceStatus != null ? (STATUS_TEXT[a.instanceStatus] || `状态 ${a.instanceStatus}`) : '未取到';
  $('dStats').innerHTML = `
    <span class="stat"><i>账号</i><b>${esc(a.account || '—')}</b></span>
    <span class="stat"><i>登录态</i><b>${esc(cookie)}</b></span>
    <span class="stat"><i>实例</i><b>${esc(ins)}</b></span>
    <span class="stat"><i>最近换票</i><b>${fmtTime(a.lastTicketAt)}</b></span>
    <span class="stat"><i>循环</i><b>${a.cycles || 0} 次</b></span>
    ${a.lastError ? `<span class="stat err"><i>最近错误</i><b>${esc(a.lastError).slice(0, 60)}</b></span>` : ''}
  `;

  setToggle($('btnEnabled'), a.enabled, '已启用保活', '已停用保活');

  const put = (id, val) => {
    const el = $(id);
    if (!el) return;
    if (document.activeElement === el && !force) return;
    el.value = val == null ? '' : val;
  };
  put('mode', a.mode || 'ticket');
  put('refreshSec', a.refreshSec || 300);
  put('instanceId', a.instanceId || '');
  put('pauseMin', a.pauseMin || 10);
  put('name', a.name || '');
  put('account', a.account || '');
  put('reloginDays', a.reloginDays || 7);

  if (!(document.activeElement === $('autoRelogin') && !force)) $('autoRelogin').checked = a.autoRelogin !== false;
  if (!(document.activeElement === $('wecomWebhook') && !force)) {
    $('wecomWebhook').placeholder = a.notify && a.notify.ownWebhook ? '已配置（留空保存则清除）' : '留空则用全局通知配置';
    if (force) $('wecomWebhook').value = '';
  }

  if (force || !authPanesReady) {
    setAuthPane(a.authMode || 'cookie');
    $('password').value = '';
  }

  $('loginHint').textContent = a.hasPassword
    ? `已保存密码密文${a.lastLoginAt ? '，最近登录：' + new Date(a.lastLoginAt).toLocaleString('zh-CN') : ''}`
    : '尚未保存密码，填账号密码后点「登录并保存」';
  $('detailHint').textContent = a.phase === 'paused' && a.pausedUntil
    ? `让位中，预计 ${new Date(a.pausedUntil).toLocaleTimeString('zh-CN', { hour12: false })} 恢复`
    : '';
}

function renderSummary() {
  const total = S.accounts.length;
  const online = S.accounts.filter((a) => a.phase === 'online').length;
  const err = S.accounts.filter((a) => a.phase === 'error' || a.phase === 'nologin').length;
  const on = S.accounts.filter((a) => a.enabled).length;
  $('sumBadge').textContent = `账号 ${total} · 启用 ${on} · 在线 ${online}${err ? ` · 异常 ${err}` : ''}`;
  const dot = $('dot');
  dot.className = 'dot ' + (err ? 'error' : online ? 'online' : '');
  $('pills').innerHTML = '';
}

function renderLogAccounts() {
  const sig = S.accounts.map((a) => a.id + a.name).join('|');
  if (sig === S.accSig) return;
  S.accSig = sig;
  const cur = $('logAccount').value;
  $('logAccount').innerHTML = '<option value="">全部账号</option>' +
    S.accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
  if ([...$('logAccount').options].some((o) => o.value === cur)) $('logAccount').value = cur;
}

function setToggle(btn, on, onText, offText) {
  btn.classList.toggle('on', !!on);
  btn.textContent = on ? onText : offText;
}

// ---------------- 数据拉取 ----------------

async function refreshState() {
  try {
    const r = await api('/api/state');
    S.accounts = r.data.accounts || [];
    S.notify = r.data.notify || {};
    if (!sel() && S.accounts.length) {
      const keep = S.selectedId;
      S.selectedId = S.accounts.some((a) => a.id === keep) ? keep : S.accounts[0].id;
      localStorage.setItem('ta.selected', S.selectedId);
      renderDetail(true);
    }
    renderSummary();
    renderList();
    renderLogAccounts();
    renderDetail(false);
  } catch (e) {
    $('sumBadge').textContent = '连接失败';
    $('dot').className = 'dot error';
  }
}

let lastLogSig = '';
async function refreshLogs() {
  try {
    const limit = Number($('logLimit').value) || 200;
    const filter = $('logFilter').value;
    const acct = $('logAccount').value;
    const r = await api(`/api/logs?limit=${limit}${acct ? `&account=${encodeURIComponent(acct)}` : ''}`);
    const rows = (r.data || []).filter((x) => filter === 'all' || x.level === filter);
    const sig = rows.map((x) => x.t + x.level + x.msg.length).join(',');
    if (sig === lastLogSig) return;
    lastLogSig = sig;
    const box = $('logs');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.innerHTML = rows.map((x) => {
      const tag = x.acct ? `<span class="l-acct">[${esc(x.acct)}]</span> ` : '';
      return `<span class="l-${x.level}">[${x.time}] ${tag}${esc(x.msg)}</span>`;
    }).join('\n');
    if ($('autoScroll').checked && (atBottom || box.scrollTop === 0)) box.scrollTop = box.scrollHeight;
  } catch (e) { /* 静默 */ }
}

// ---------------- 交互 ----------------

$('accList').addEventListener('click', async (e) => {
  const toggle = e.target.closest('[data-toggle]');
  if (toggle) {
    e.stopPropagation();
    const id = toggle.dataset.toggle;
    const a = S.accounts.find((x) => x.id === id);
    toggle.disabled = true;
    try {
      await post(`/api/accounts/${encodeURIComponent(id)}/config`, { enabled: !(a && a.enabled) });
      await refreshState();
      toast(a && a.enabled ? '已停用' : '已启用');
    } catch (err) { toast(err.message, true); }
    finally { toggle.disabled = false; }
    return;
  }
  const item = e.target.closest('.acc-item');
  if (item) selectAccount(item.dataset.id);
});

function selectAccount(id) {
  if (S.selectedId === id) return;
  S.selectedId = id;
  localStorage.setItem('ta.selected', id);
  renderList();
  renderDetail(true);
  lastLogSig = '';
  refreshLogs();
}

$('btnEnabled').addEventListener('click', async () => {
  const a = sel();
  if (!a) return;
  $('btnEnabled').disabled = true;
  try {
    await post(`/api/accounts/${encodeURIComponent(a.id)}/config`, { enabled: !a.enabled });
    await refreshState();
    toast(a.enabled ? '已停用保活' : '已启用保活');
  } catch (e) { toast(e.message, true); }
  finally { $('btnEnabled').disabled = false; }
});

document.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', async () => {
  const a = sel();
  if (!a) return;
  const mode = b.dataset.auth;
  setAuthPane(mode);
  try {
    await post(`/api/accounts/${encodeURIComponent(a.id)}/config`, { authMode: mode });
    toast(mode === 'password' ? '已切到账号密码登录' : '已切到 Cookie 登录');
    refreshState();
  } catch (e) { toast(e.message, true); }
}));

$('saveCookie').addEventListener('click', async () => {
  const a = sel();
  if (!a) return toast('先选一个账号', true);
  const cookie = $('cookie').value.trim();
  if (!cookie) return toast('Cookie 不能为空', true);
  try {
    await post(`/api/accounts/${encodeURIComponent(a.id)}/config`, { cookie, authMode: 'cookie' });
    $('cookie').value = '';
    toast('Cookie 已保存，循环已重载');
    refreshState();
  } catch (e) { toast(e.message, true); }
});

$('doLogin').addEventListener('click', async () => {
  const a = sel();
  if (!a) return toast('先选一个账号', true);
  const account = $('account').value.trim();
  const password = $('password').value;
  if (!account) return toast('先填账号', true);
  if (!password && !a.hasPassword) return toast('先填密码', true);
  const btn = $('doLogin');
  btn.disabled = true;
  btn.textContent = '登录中…（含滑块）';
  try {
    await post(`/api/accounts/${encodeURIComponent(a.id)}/login`, { account, password });
    $('password').value = '';
    toast('登录成功，登录态已写入');
    refreshState();
  } catch (e) {
    toast('登录失败：' + e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '登录并保存';
  }
});

$('saveKeep').addEventListener('click', async () => {
  const a = sel();
  if (!a) return toast('先选一个账号', true);
  try {
    await post(`/api/accounts/${encodeURIComponent(a.id)}/config`, {
      name: $('name').value.trim() || a.name,
      mode: $('mode').value,
      refreshSec: Number($('refreshSec').value),
      instanceId: $('instanceId').value.trim(),
      pauseMin: Number($('pauseMin').value),
      autoRelogin: $('autoRelogin').checked,
      reloginDays: Number($('reloginDays').value),
      wecomWebhook: $('wecomWebhook').value.trim()
    });
    $('wecomWebhook').value = '';
    toast('设置已保存');
    refreshState();
  } catch (e) { toast(e.message, true); }
});

$('restart').addEventListener('click', async () => {
  const a = sel();
  if (!a) return toast('先选一个账号', true);
  try { await post(`/api/accounts/${encodeURIComponent(a.id)}/restart`); toast('已重载该账号循环'); refreshState(); }
  catch (e) { toast(e.message, true); }
});

$('desktop').addEventListener('click', async () => {
  const a = sel();
  if (!a) return toast('先选一个账号', true);
  try {
    const r = await post(`/api/accounts/${encodeURIComponent(a.id)}/desktop-url`);
    window.open(r.url, '_blank');
    toast(r.pauseMin > 0 ? `已生成入口，保活让位 ${r.pauseMin} 分钟` : '已生成入口，保活持续中');
    refreshState();
  } catch (e) { toast(e.message, true); }
});

$('delAccount').addEventListener('click', async () => {
  const a = sel();
  if (!a) return;
  if (!confirm(`确定删除账号「${a.name}」？该账号的登录态和设置会被移除（云电脑本身不受影响）。`)) return;
  try {
    await post(`/api/accounts/${encodeURIComponent(a.id)}/delete`);
    S.selectedId = '';
    localStorage.removeItem('ta.selected');
    toast('已删除');
    refreshState();
  } catch (e) { toast(e.message, true); }
});

// ---------------- 弹窗 ----------------

function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(b.dataset.close)));
document.querySelectorAll('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); }));

$('btnAdd').addEventListener('click', () => {
  $('addName').value = '';
  $('addAccount').value = '';
  $('addPassword').value = '';
  $('addCookie').value = '';
  openModal('modalAdd');
});

$('addSubmit').addEventListener('click', async () => {
  const name = $('addName').value.trim();
  const account = $('addAccount').value.trim();
  const password = $('addPassword').value;
  const cookie = $('addCookie').value.trim();
  if (!account && !cookie) return toast('填账号密码，或者贴一条 Cookie', true);
  const btn = $('addSubmit');
  btn.disabled = true;
  btn.textContent = '创建中…';
  try {
    const r = await post('/api/accounts', { name: name || account, account, password, cookie });
    if (r.success === false) toast(r.error || '登录失败，账号已创建', true);
    else toast('账号已创建');
    closeModal('modalAdd');
    if (r.data && r.data.id) S.selectedId = r.data.id;
    localStorage.setItem('ta.selected', S.selectedId);
    await refreshState();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '创建';
  }
});

$('btnNotify').addEventListener('click', () => {
  const n = S.notify || {};
  $('notifyEnabled').checked = n.enabled !== false;
  $('notifyRecover').checked = n.notifyRecover !== false;
  $('cooldownMin').value = n.cooldownMin || 30;
  $('gWecomWebhook').value = '';
  $('gWecomWebhook').placeholder = n.wecomWebhook ? `已配置：${n.wecomWebhook.slice(0, 52)}…` : 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...';
  openModal('modalNotify');
});

$('saveNotify').addEventListener('click', async () => {
  try {
    await post('/api/notify', {
      enabled: $('notifyEnabled').checked,
      notifyRecover: $('notifyRecover').checked,
      cooldownMin: Number($('cooldownMin').value),
      wecomWebhook: $('gWecomWebhook').value.trim()
    });
    toast('通知配置已保存');
    closeModal('modalNotify');
    refreshState();
  } catch (e) { toast(e.message, true); }
});

$('testNotify').addEventListener('click', async () => {
  try {
    const a = sel();
    await post('/api/notify/test', { account: a ? a.id : '' });
    toast('测试消息已发送');
  } catch (e) { toast('推送失败：' + e.message, true); }
});

$('logFilter').addEventListener('change', () => { lastLogSig = ''; refreshLogs(); });
$('logLimit').addEventListener('change', () => { lastLogSig = ''; refreshLogs(); });
$('logAccount').addEventListener('change', () => { lastLogSig = ''; refreshLogs(); });

refreshState();
refreshLogs();
setInterval(refreshState, 4000);
setInterval(refreshLogs, 3000);
