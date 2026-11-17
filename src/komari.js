// Komari 监控接入：用云电脑内部探针的 uptime 推算真实开机时间。
// 为什么用它：面板通过 teleai 接口只能拿到实例 status（运行/关机），
// 拿不到"本次开机多久"。Komari 的 agent 跑在云电脑里，直接读系统 uptime，
// 是外部可获取的最准确来源（不受面板重启、状态跳变影响）。
//
// API：GET {base}/api/v1/nodes  →  { count, nodes: [{ name, online, live: { time, uptime } }] }
// 开机时间 = live.time - live.uptime

const TIMEOUT_MS = 12000;

function normalizeBase(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  return s.replace(/\/+$/, '');
}

async function fetchJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'Accept': 'application/json', 'User-Agent': 'teleagent-multi/1.0' },
      cache: 'no-store'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// 拉取全部节点，返回 Map<name, { online, uptime, time, bootAt }>
async function fetchNodes(baseUrl, timeoutMs) {
  const base = normalizeBase(baseUrl);
  if (!base) return { nodes: new Map(), error: '未配置 Komari 地址' };
  const url = `${base}/api/v1/nodes`;
  try {
    const j = await fetchJson(url, timeoutMs);
    const arr = Array.isArray(j && j.nodes) ? j.nodes : [];
    const map = new Map();
    for (const n of arr) {
      const name = String(n && n.name || '').trim();
      if (!name) continue;
      const live = n.live || {};
      const up = Number(live.uptime);
      const t = live.time ? new Date(live.time).getTime() : NaN;
      map.set(name, {
        online: !!(n.online && live.online !== false),
        uptime: Number.isFinite(up) && up >= 0 ? Math.floor(up) : null,
        reportedAt: Number.isNaN(t) ? null : t,
        bootAt: (Number.isFinite(up) && !Number.isNaN(t)) ? new Date(t - up * 1000) : null,
        os: n.os || '',
        raw: n
      });
    }
    return { nodes: map, error: '' };
  } catch (e) {
    return { nodes: new Map(), error: `Komari 请求失败: ${e.message}` };
  }
}

// 按账号名匹配节点。账号名可能是 "7513"、"13339387513a"、"7513-xxx" 等，
// 逐个尝试：完全相等 → 前缀匹配 → 包含匹配。
function matchNode(nodes, accountName, account) {
  const candidates = [];
  const push = (v) => { const s = String(v || '').trim(); if (s && !candidates.includes(s)) candidates.push(s); };
  push(accountName);
  push(account && account.name);
  push(account && account.account);
  // 从 account 里提取数字片段（如 13339387513a → 7513）
  for (const c of [accountName, account && account.account, account && account.name]) {
    const m = String(c || '').match(/(\d{3,})/);
    if (m) push(m[1]);
  }
  const entries = [...nodes.entries()];
  // 1) 完全相等（大小写不敏感）
  for (const c of candidates) {
    const hit = entries.find(([k]) => k.toLowerCase() === c.toLowerCase());
    if (hit) return { key: hit[0], ...hit[1] };
  }
  // 2) 前缀 / 包含
  for (const c of candidates) {
    if (c.length < 3) continue;
    const lc = c.toLowerCase();
    const hit = entries.find(([k]) => k.toLowerCase().includes(lc) || lc.includes(k.toLowerCase()));
    if (hit) return { key: hit[0], ...hit[1] };
  }
  return null;
}

// 主入口：拿到某账号的开机信息
async function getBootInfo(baseUrl, accountName, account, timeoutMs) {
  const { nodes, error } = await fetchNodes(baseUrl, timeoutMs);
  if (error) return { ok: false, error, source: 'komari' };
  if (nodes.size === 0) return { ok: false, error: 'Komari 返回空节点列表', source: 'komari' };
  const hit = matchNode(nodes, accountName, account);
  if (!hit) {
    return { ok: false, error: `Komari 中未找到匹配「${accountName}」的节点（现有: ${[...nodes.keys()].join(', ')}）`, source: 'komari', nodeNames: [...nodes.keys()] };
  }
  if (hit.uptime == null || !hit.bootAt) {
    return { ok: false, error: `节点「${hit.key}」无 uptime 数据`, source: 'komari' };
  }
  return {
    ok: true,
    source: 'komari',
    node: hit.key,
    online: hit.online,
    bootAt: hit.bootAt,
    uptime: hit.uptime,
    reportedAt: hit.reportedAt,
    os: hit.os
  };
}

module.exports = { normalizeBase, fetchNodes, matchNode, getBootInfo, TIMEOUT_MS };
