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

const S = { accounts: [], notify: {}, selectedId: localStorage.getItem('ta.selected') || '', accSig: '', tpl: { events: [], headTemplate: '' }, tplId: '', dirty: new Set(), dirtyAcct: '' };

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

// 把运行时长（秒）格式化为中文可读：3天2小时 / 5小时20分 / 12分34秒 / 45秒
const fmtUptime = (sec) => {
  sec = Number(sec) || 0;
  if (sec <= 0) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d) return `${d}天${h}小时`;
  if (h) return `${h}小时${m}分`;
  if (m) return `${m}分${s}秒`;
  return `${s}秒`;
};

// 云电脑运行时长：带上限预警（上限时长由账号配置 instanceLimitMin 决定，默认60分钟）
// estimated=开机时间估算值（前面加 ~）
const fmtInstRuntime = (a) => {
  const sec = a.instanceRuntimeSec || 0;
  if (!a.instanceStartAt || sec <= 0) return '<span class="dim">未运行</span>';
  const prefix = a.instanceEstStart ? '~' : '';
  const warn = a.instanceWarn ? ' inst-warn' : '';
  const limit = a.instanceLimitSec || 0;
  let tip = '';
  if (limit > 0) {
    const left = limit - sec;
    tip = left > 0
      ? `距 ${fmtUptime(limit)} 上限还有 ${fmtUptime(left)}`
      : `已达 ${fmtUptime(limit)} 上限，可能随时被强制关机`;
  } else {
    tip = '未设置时长上限';
  }
  return `<span class="inst-run${warn}" title="${tip}">${prefix}${fmtUptime(sec)}</span>`;
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
  const pts = a.points == null ? '—' : Number(a.points).toLocaleString('zh-CN');
  return `
      <div class="acc-item${active}" data-id="${esc(a.id)}">
        <div class="acc-top">
          <span class="dot ${cls}"></span>
          <b class="acc-name">${esc(a.name)}</b>
          <button class="mini ${a.enabled ? 'on' : ''}" data-toggle="${esc(a.id)}" title="启用/停用">${a.enabled ? '已启用' : '已停用'}</button>
        </div>
        <div class="acc-sub">${esc(a.account || 'Cookie 登录')} · ${esc(PHASE_TEXT[a.phase] || a.phase)}</div>
        <div class="acc-meta">
          <span>积分 <b>${esc(pts)}</b></span>
          <span>登录态 <b>${esc(cookie)}</b></span>
          <span>实例 <b>${esc(ins)}</b></span>
          <span>循环 <b>${a.cycles || 0}</b></span>
          ${a.instanceStartAt && a.instanceRuntimeSec > 0 ? `<span>云电脑运行 <b>${fmtInstRuntime(a)}</b></span>` : ''}
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

  // 切换账号时清掉「未保存改动」标记
  const acctKey = has ? a.id : '';
  if (acctKey !== S.dirtyAcct) {
    S.dirty = new Set();
    S.dirtyAcct = acctKey;
  }
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
  const pts = a.points == null ? '—' : Number(a.points).toLocaleString('zh-CN');
  const claimState = a.pointsTodayClaimed == null ? '未知' : (a.pointsTodayClaimed ? '已领' : '未领');
  $('dStats').innerHTML = `
    <span class="stat"><i>账号</i><b>${esc(a.account || '—')}</b></span>
    <span class="stat"><i>剩余积分</i><b>${esc(pts)}</b></span>
    <span class="stat"><i>今日领取</i><b>${esc(claimState)}</b></span>
    <span class="stat"><i>登录态</i><b>${esc(cookie)}</b></span>
    <span class="stat"><i>实例</i><b>${esc(ins)}</b></span>
    <span class="stat"><i>最近换票</i><b>${fmtTime(a.lastTicketAt)}</b></span>
    <span class="stat"><i>云电脑运行</i><b>${fmtInstRuntime(a)}</b></span>
    <span class="stat"><i>循环</i><b>${a.cycles || 0} 次</b></span>
    ${a.pointsError ? `<span class="stat err"><i>积分错误</i><b>${esc(a.pointsError).slice(0, 50)}</b></span>` : ''}
    ${a.lastError ? `<span class="stat err"><i>最近错误</i><b>${esc(a.lastError).slice(0, 60)}</b></span>` : ''}
  `;

  setToggle($('btnEnabled'), a.enabled, '已启用保活', '已停用保活');

  const put = (id, val) => {
    const el = $(id);
    if (!el) return;
    // 用户改过但还没保存的字段，不被自动刷新覆盖
    if (S.dirty.has(id)) return;
    if (document.activeElement === el && !force) return;
    el.value = val == null ? '' : val;
  };
  // 勾选框同理：脏标记优先于焦点判断
  const putCheck = (id, on) => {
    if (S.dirty.has(id)) return;
    if (document.activeElement === $(id) && !force) return;
    $(id).checked = !!on;
  };
  put('mode', a.mode || 'ticket');
  put('refreshSec', a.refreshSec || 120);
  put('sessionSec', a.sessionSec || 3600);
  put('gapSec', a.gapSec || 10);
  put('pingSec', a.pingSec || 5);
  put('instanceLimitMin', a.instanceLimitMin == null ? 60 : a.instanceLimitMin);
  put('instanceWarnMin', a.instanceWarnMin == null ? 50 : a.instanceWarnMin);
  put('instanceId', a.instanceId || '');
  put('pauseMin', a.pauseMin || 10);
  put('name', a.name || '');
  put('account', a.account || '');
  put('reloginDays', a.reloginDays || 20);

  putCheck('pointsAutoClaim', a.pointsAutoClaim !== false);
  putCheck('pointsDailyReport', a.pointsDailyReport === true);
  put('pointsDailyReportAt', a.pointsDailyReportAt || '09:00');

  const pl = [];
  if (a.pointsDaily) pl.push(`每日可领 ${a.pointsDaily} 分`);
  if (a.pointsDays) pl.push(`本期已领 ${a.pointsDays} 天 · 累计 ${a.pointsTotal} 分`);
  if (a.pointsClaimAt) pl.push(`上次领取 ${new Date(a.pointsClaimAt).toLocaleString('zh-CN', { hour12: false })}`);
  if (a.pointsExpireDays != null) pl.push(`最早到期 ${a.pointsExpireDays} 天后`);
  if (a.pointsAt) pl.push(`余额更新于 ${fmtTime(a.pointsAt)}`);
  if (a.pointsDailyReport) pl.push(`每天 ${a.pointsDailyReportAt || '09:00'} 推送积分播报`);
  if (a.pointsReportAt) pl.push(`上次播报 ${new Date(a.pointsReportAt).toLocaleString('zh-CN', { hour12: false })}`);
  $('pointsHint').textContent = pl.length ? pl.join(' · ') : '尚未读取积分，点「刷新积分」或等保活循环自动获取';

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
  // 未保存改动提示优先级最高，放在最后覆盖
  updateDirtyHint();
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
      sessionSec: Number($('sessionSec').value),
      gapSec: Number($('gapSec').value),
      pingSec: Number($('pingSec').value),
      instanceLimitMin: Number($('instanceLimitMin').value),
      instanceWarnMin: Number($('instanceWarnMin').value),
      instanceId: $('instanceId').value.trim(),
      pauseMin: Number($('pauseMin').value),
      autoRelogin: $('autoRelogin').checked,
      reloginDays: Number($('reloginDays').value),
      pointsAutoClaim: $('pointsAutoClaim').checked,
      pointsDailyReport: $('pointsDailyReport').checked,
      pointsDailyReportAt: $('pointsDailyReportAt').value || '09:00',
      wecomWebhook: $('wecomWebhook').value.trim()
    });
    $('wecomWebhook').value = '';
    S.dirty.clear();
    toast('设置已保存');
    refreshState();
    updateDirtyHint();
  } catch (e) { toast(e.message, true); }
});

$('claimPoints').addEventListener('click', async () => {
  const a = sel();
  if (!a) return toast('先选一个账号', true);
  const btn = $('claimPoints');
  btn.disabled = true;
  btn.textContent = '领取中…';
  try {
    const r = await post(`/api/accounts/${encodeURIComponent(a.id)}/points-claim`);
    toast(r.already
      ? '今日已领过，无需重复领取'
      : `领取成功${r.gained ? ' +' + r.gained : ''}，剩余 ${r.balance == null ? '未知' : r.balance}`);
    await refreshState();
  } catch (e) {
    toast('领取失败：' + e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '立即领取';
  }
});

$('refreshPoints').addEventListener('click', async () => {
  const a = sel();
  if (!a) return toast('先选一个账号', true);
  const btn = $('refreshPoints');
  btn.disabled = true;
  btn.textContent = '刷新中…';
  try {
    await post(`/api/accounts/${encodeURIComponent(a.id)}/points`);
    toast('积分已刷新');
    await refreshState();
  } catch (e) {
    toast('刷新失败：' + e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '刷新积分';
  }
});

$('reportPoints').addEventListener('click', async () => {
  const a = sel();
  if (!a) return toast('先选一个账号', true);
  const btn = $('reportPoints');
  btn.disabled = true;
  btn.textContent = '发送中…';
  try {
    await post(`/api/accounts/${encodeURIComponent(a.id)}/points-report`);
    toast('积分播报已发送');
    await refreshState();
  } catch (e) {
    toast('播报失败：' + e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '立即播报';
  }
});

$('restart').addEventListener('click', async () => {  const a = sel();  if (!a) return toast('先选一个账号', true);
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

// ---------------- 通知模板管理 ----------------

const tplEvent = (id) => (S.tpl.events || []).find((e) => e.id === id) || null;

function renderTplList() {
  const box = $('tplList');
  if (!S.tpl.events.length) {
    box.innerHTML = '<p class="empty">加载中…</p>';
    return;
  }
  box.innerHTML = S.tpl.events.map((e) => {
    const active = e.id === S.tplId ? ' active' : '';
    const modified = e.current.title !== e.defaults.title || e.current.body !== e.defaults.body;
    return `
      <div class="tpl-item${active}" data-id="${esc(e.id)}">
        <div class="tpl-item-top">
          <b>${esc(e.label)}</b>
          ${modified ? '<span class="tpl-dot" title="已自定义">●</span>' : ''}
        </div>
        <div class="tpl-item-sub">${esc(e.desc)}</div>
      </div>`;
  }).join('');
}

function renderTplVars(ev) {
  $('tplVars').innerHTML = (ev.vars || [])
    .map((v) => `<button class="chip" data-var="${esc(v)}">{{${esc(v)}}}</button>`)
    .join('');
}

async function loadTemplates() {
  const r = await api('/api/notify/templates');
  S.tpl = r.data || { events: [], headTemplate: '' };
  $('tplHead').value = S.tpl.headTemplate || '';
  renderTplList();
  if (!S.tplId && S.tpl.events.length) S.tplId = S.tpl.events[0].id;
  selectTpl(S.tplId);
}

/** 选中的事件写进编辑器 */
function selectTpl(id) {
  const ev = tplEvent(id);
  S.tplId = id;
  renderTplList();
  if (!ev) {
    $('tplEmpty').classList.remove('hidden');
    $('tplBody').classList.add('hidden');
    return;
  }
  $('tplEmpty').classList.add('hidden');
  $('tplBody').classList.remove('hidden');
  $('tplLabel').textContent = ev.label;
  $('tplDesc').textContent = ev.desc;
  $('tplTitle').value = ev.current.title;
  $('tplContent').value = ev.current.body;
  renderTplVars(ev);
  updateTplPreview();
}

/** 本地渲染预览：不请求后端，敲字即时出效果 */
function renderLocal(text, vars) {
  return String(text || '').replace(/\{\{\s*([^}]+?)\s*\}\}/g, (m, name) => {
    const k = String(name).trim();
    return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k] == null ? '' : vars[k]) : '';
  });
}

/** 前缀和标题的拼接规则要和后端一致 */
function composeLocal(head, title) {
  const h = String(head || '').trim();
  const t = String(title || '');
  if (!h) return t;
  if (!t) return h;
  return /[】\]）)>\*#]$/.test(h) ? `${h}${t}` : `${h}\n${t}`;
}

let tplPreviewTimer = null;
function updateTplPreview() {
  const ev = tplEvent(S.tplId);
  if (!ev) return;
  const vars = ev.sample || {};
  const title = renderLocal($('tplTitle').value, vars);
  const body = renderLocal($('tplContent').value, vars);
  const head = renderLocal($('tplHead').value || S.tpl.headTemplate, vars);
  $('tplPreview').textContent = `${composeLocal(head, title)}\n${body}`;
  // 找出模板里用到但该事件不支持的变量
  const used = [...new Set([...String($('tplTitle').value).matchAll(/\{\{\s*([^}]+?)\s*\}\}/g),
    ...String($('tplContent').value).matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1].trim()))];
  const bad = used.filter((v) => !(ev.vars || []).includes(v));
  $('tplUnknown').textContent = bad.length ? `未知变量：${bad.join('、')}` : '';
  $('tplUnknown').style.color = bad.length ? 'var(--warn)' : '';
}

$('tplTitle').addEventListener('input', updateTplPreview);
$('tplContent').addEventListener('input', updateTplPreview);
$('tplHead').addEventListener('input', updateTplPreview);

$('tplVars').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-var]');
  if (!chip) return;
  const token = chip.dataset.var;
  const ta = $('tplContent');
  const start = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
  const end = ta.selectionEnd == null ? ta.value.length : ta.selectionEnd;
  ta.value = ta.value.slice(0, start) + `{{${token}}}` + ta.value.slice(end);
  ta.focus();
  ta.selectionStart = ta.selectionEnd = start + token.length + 4;
  updateTplPreview();
});

$('tplList').addEventListener('click', (e) => {
  const item = e.target.closest('.tpl-item');
  if (item) selectTpl(item.dataset.id);
});

$('openTemplates').addEventListener('click', async () => {
  closeModal('modalNotify');
  openModal('modalTpl');
  try {
    await loadTemplates();
  } catch (err) {
    toast('模板加载失败：' + err.message, true);
  }
});

$('tplSave').addEventListener('click', async () => {
  const ev = tplEvent(S.tplId);
  if (!ev) return;
  try {
    await post('/api/notify/templates', {
      id: ev.id,
      title: $('tplTitle').value,
      body: $('tplContent').value
    });
    toast(`「${ev.label}」模板已保存`);
    await loadTemplates();
    selectTpl(ev.id);
    refreshState();
  } catch (e) { toast(e.message, true); }
});

$('tplReset').addEventListener('click', async () => {
  const ev = tplEvent(S.tplId);
  if (!ev) return;
  if (!confirm(`把「${ev.label}」恢复成默认模板？`)) return;
  try {
    await post('/api/notify/templates', { id: ev.id, title: ev.defaults.title, body: ev.defaults.body });
    toast('已恢复默认');
    await loadTemplates();
    selectTpl(ev.id);
    refreshState();
  } catch (e) { toast(e.message, true); }
});

$('tplResetAll').addEventListener('click', async () => {
  if (!confirm('把所有通知模板和标题前缀都恢复成默认？')) return;
  try {
    await post('/api/notify/templates/reset', {});
    toast('已全部恢复默认');
    await loadTemplates();
    refreshState();
  } catch (e) { toast(e.message, true); }
});

$('tplTest').addEventListener('click', async () => {
  const ev = tplEvent(S.tplId);
  if (!ev) return;
  try {
    await post('/api/notify/templates/test', { id: ev.id });
    toast('测试消息已发送');
  } catch (e) { toast('推送失败：' + e.message, true); }
});

// 标题前缀单独保存（和模板正文分开）
$('tplHead').addEventListener('change', async () => {
  try {
    await post('/api/notify/templates', { headTemplate: $('tplHead').value.trim() });
    toast('标题前缀已保存');
    await loadTemplates();
  } catch (e) { toast(e.message, true); }
});

// ---------------- 未保存改动追踪 ----------------
// 面板每 4 秒自动刷新一次，用户刚勾选/改过的字段不能被服务端的旧值冲掉。
// 这里记录哪些字段被用户动过，保存成功后再清空。

const DIRTY_FIELDS = [
  'mode', 'refreshSec', 'sessionSec', 'gapSec', 'pingSec', 'instanceLimitMin', 'instanceWarnMin', 'instanceId', 'pauseMin', 'name', 'account', 'reloginDays',
  'pointsAutoClaim', 'pointsDailyReport', 'pointsDailyReportAt',
  'autoRelogin', 'wecomWebhook', 'cookie'
];

DIRTY_FIELDS.forEach((id) => {
  const el = $(id);
  if (!el) return;
  const mark = () => {
    S.dirty.add(id);
    updateDirtyHint();
  };
  el.addEventListener('input', mark);
  el.addEventListener('change', mark);
});

// 有未保存改动时给个提示，避免用户以为已经存上了
function updateDirtyHint() {
  const n = S.dirty.size;
  const hint = $('detailHint');
  if (!hint) return;
  if (n > 0) {
    hint.textContent = `有 ${n} 项改动未保存，记得点「保存设置」`;
    hint.style.color = 'var(--warn)';
  } else {
    hint.textContent = '';
    hint.style.color = '';
  }
}

refreshState();
refreshLogs();
setInterval(refreshState, 4000);
setInterval(refreshLogs, 3000);
