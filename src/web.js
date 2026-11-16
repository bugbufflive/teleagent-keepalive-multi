/**
 * 多账号 Web 控制台：静态页 + JSON API
 *
 *   GET  /                              控制台
 *   GET  /api/state                     全部账号状态 + 全局通知配置
 *   GET  /api/logs?limit=&account=      日志（account 传账号 id 可过滤）
 *   POST /api/accounts                  新增账号 {name, account, password, cookie, authMode}
 *   POST /api/accounts/:id/config       改该账号配置
 *   POST /api/accounts/:id/login        账号密码登录（含滑块）
 *   POST /api/accounts/:id/restart      重载该账号循环
 *   POST /api/accounts/:id/checkin      手动打卡
 *   POST /api/accounts/:id/points       刷新剩余积分 + 每日领取状态
 *   POST /api/accounts/:id/points-claim 手动领取每日积分
 *   POST /api/accounts/:id/desktop-url  取云电脑网页入口
 *   POST /api/accounts/:id/delete       删除账号
 *   POST /api/notify                    全局通知配置
 *   POST /api/notify/test               发测试消息（可带 account 用该账号的机器人）
 *   GET  /api/notify/templates          模板目录（事件、变量、默认值、当前值）
 *   POST /api/notify/templates          保存模板 {id, title, body} / {headTemplate}
 *   POST /api/notify/templates/reset    全部恢复默认
 *   POST /api/notify/templates/preview  预览渲染结果 {id, title, body, vars}
 *   POST /api/notify/templates/test     按模板发一条测试消息 {id}
 *
 * 若设置了环境变量 WEB_PASSWORD，则整站走 HTTP Basic 认证。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EVENT_MAP, EVENTS, DEFAULT_HEAD, render, renderHead, compose, catalog } = require('./template');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function sendJson(res, obj, code = 200) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': body.length });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { resolve({}); }
    });
  });
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function basicAuth(req, password, user) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [u, p] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
  return safeEqual(u, user) && safeEqual(p, password);
}

const STR_KEYS = ['name', 'mode', 'authMode', 'account', 'cookie', 'instanceId', 'deviceCode', 'osType', 'clientVersion', 'wecomWebhook', 'remark'];
const NUM_KEYS = ['deviceType', 'refreshSec', 'sessionSec', 'gapSec', 'pingSec', 'pauseMin', 'cookieAlertDays', 'reloginDays'];
const BOOL_KEYS = ['enabled', 'claim', 'autoRelogin', 'pointsAutoClaim'];

function pickConfig(body = {}) {
  const patch = {};
  for (const k of STR_KEYS) if (typeof body[k] === 'string') patch[k] = body[k].trim();
  for (const k of NUM_KEYS) if (body[k] !== undefined && body[k] !== '' && !Number.isNaN(Number(body[k]))) patch[k] = Number(body[k]);
  for (const k of BOOL_KEYS) if (typeof body[k] === 'boolean') patch[k] = body[k];
  return patch;
}

function createServer({ manager, store, logger, dataDir }) {
  const password = process.env.WEB_PASSWORD || '';
  const user = process.env.WEB_USER || 'admin';

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (password && !basicAuth(req, password, user)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="teleagent-keepalive"' });
      return res.end('auth required');
    }

    try {
      if (pathname === '/api/state') {
        return sendJson(res, {
          success: true,
          data: {
            accounts: manager.statusAll(),
            notify: store.notify(),
            version: 2,
            time: new Date().toISOString()
          }
        });
      }

      if (pathname === '/api/logs') {
        const limit = Math.min(logger.MAX, Math.max(20, Number(url.searchParams.get('limit')) || 120));
        const acctId = url.searchParams.get('account') || '';
        return sendJson(res, { success: true, data: logger.recent(limit, acctId), max: logger.MAX });
      }

      // ---------- 新增账号 ----------
      if (req.method === 'POST' && pathname === '/api/accounts') {
        const body = await readBody(req);
        const patch = pickConfig(body);
        const account = String(body.account || '').trim();
        const pwd = String(body.password || '');
        if (!patch.name && account) patch.name = account;
        if (!patch.name) return sendJson(res, { error: '给这个账号起个名字' }, 400);
        if (!account && !patch.cookie) return sendJson(res, { error: '要么填账号密码，要么贴 Cookie' }, 400);
        if (account) {
          patch.account = account;
          patch.authMode = 'password';
        }
        const acc = manager.create(patch);
        // 有密码就先真登录一次，登录失败不删账号，方便改密码重试
        if (account && pwd) {
          const k = manager.keeper(acc.id);
          try {
            await k.loginWith(account, pwd);
            return sendJson(res, { success: true, data: k.status() });
          } catch (e) {
            return sendJson(res, { success: false, error: `账号已创建，但登录失败：${e.message}`, data: k.status() }, 200);
          }
        }
        const k = manager.keeper(acc.id);
        return sendJson(res, { success: true, data: k ? k.status() : manager.placeholder(acc) });
      }

      // ---------- 单账号操作 ----------
      const m = pathname.match(/^\/api\/accounts\/([^/]+)(?:\/([a-z-]+))?$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        const action = m[2] || '';
        const acc = store.get(id);
        if (!acc) return sendJson(res, { error: '账号不存在' }, 404);
        const k = manager.keeper(id);

        if (req.method === 'POST' && action === 'config') {
          const patch = pickConfig(await readBody(req));
          if (patch.mode && !['ticket', 'claim'].includes(patch.mode)) return sendJson(res, { error: 'mode 只能是 ticket 或 claim' }, 400);
          if (patch.authMode && !['cookie', 'password'].includes(patch.authMode)) return sendJson(res, { error: 'authMode 只能是 cookie 或 password' }, 400);
          manager.update(id, patch);
          const keys = Object.keys(patch).filter((x) => x !== 'cookie' && x !== 'passwordEnc');
          logger.write(`配置已更新：${keys.join(', ') || '无'}${patch.cookie ? '（Cookie 已更新）' : ''}`, 'info', dataDir, { acct: acc.name, acctId: id });
          return sendJson(res, { success: true, data: k ? k.status() : manager.placeholder(acc) });
        }

        if (req.method === 'POST' && action === 'login') {
          const body = await readBody(req);
          const account = String(body.account || acc.account || '').trim();
          const pwd = String(body.password || '');
          if (!account) return sendJson(res, { error: '账号不能为空' }, 400);
          if (!pwd && !acc.passwordEnc) return sendJson(res, { error: '密码不能为空' }, 400);
          // 没填密码但有已存密文：直接走自动重登
          try {
            const r = pwd ? await k.loginWith(account, pwd) : await k.doLogin('手动触发');
            return sendJson(res, { success: true, expiresAt: r.expiresAt, data: k.status() });
          } catch (e) {
            logger.write(`[登录] 失败：${e.message}`, 'error', dataDir, { acct: acc.name, acctId: id });
            return sendJson(res, { error: e.message }, 400);
          }
        }

        if (req.method === 'POST' && action === 'restart') {
          manager.restart(id);
          logger.write('已手动重载保活循环', 'info', dataDir, { acct: acc.name, acctId: id });
          return sendJson(res, { success: true, data: k ? k.status() : null });
        }

        if (req.method === 'POST' && action === 'checkin') {
          return sendJson(res, { success: true, data: k.checkin(true) });
        }

        // 刷新剩余积分 + 每日领取状态
        if (req.method === 'POST' && action === 'points') {
          if (!k) return sendJson(res, { error: '该账号的保活实例未运行，先启用一次' }, 400);
          try {
            await k.refreshPoints();
            await k.pointTaskStatus();
            return sendJson(res, { success: true, data: k.status() });
          } catch (e) {
            return sendJson(res, { error: e.message }, 500);
          }
        }

        // 手动领取每日积分
        if (req.method === 'POST' && action === 'points-claim') {
          if (!k) return sendJson(res, { error: '该账号的保活实例未运行，先启用一次' }, 400);
          try {
            const r = await k.claimDailyPoints('手动');
            logger.write(r.already
              ? `[积分] 今日已领过，剩余 ${r.balance == null ? '未知' : r.balance}`
              : `[积分] 领取成功 +${r.gained == null ? '?' : r.gained}，剩余 ${r.balance == null ? '未知' : r.balance}`,
            r.already ? 'info' : 'success', dataDir, { acct: acc.name, acctId: id });
            return sendJson(res, { success: true, ...r, data: k.status() });
          } catch (e) {
            logger.write(`[积分] 领取失败：${e.message}`, 'error', dataDir, { acct: acc.name, acctId: id });
            return sendJson(res, { error: e.message }, 500);
          }
        }

        if (req.method === 'POST' && action === 'desktop-url') {
          const body = await readBody(req);
          try {
            const u = await k.freshConnectUrl();
            const pauseMin = acc.mode === 'claim' ? k.pauseFor(body.pauseMin) : 0;
            logger.write(pauseMin > 0 ? `已生成云电脑网页入口，保活让位 ${pauseMin} 分钟` : '已生成云电脑网页入口，保活程序持续中', 'info', dataDir, { acct: acc.name, acctId: id });
            return sendJson(res, { success: true, url: u, pauseMin });
          } catch (e) {
            return sendJson(res, { error: e.message }, 500);
          }
        }

        if (req.method === 'POST' && action === 'delete') {
          manager.remove(id);
          return sendJson(res, { success: true });
        }
      }

      // ---------- 全局通知 ----------
      if (req.method === 'POST' && pathname === '/api/notify') {
        const body = await readBody(req);
        const cur = store.notify();
        const next = { ...cur };
        if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
        if (typeof body.notifyRecover === 'boolean') next.notifyRecover = body.notifyRecover;
        if (typeof body.wecomWebhook === 'string' && body.wecomWebhook.trim()) next.wecomWebhook = body.wecomWebhook.trim();
        if (body.cooldownMin !== undefined && !Number.isNaN(Number(body.cooldownMin))) next.cooldownMin = Math.max(1, Number(body.cooldownMin));
        next.channel = 'wecom';
        store.setNotify(next);
        logger.write(`通知配置已更新（${next.enabled === false ? '已关闭' : '已开启'}）`, 'info', dataDir);
        return sendJson(res, { success: true, data: store.notify() });
      }

      if (req.method === 'POST' && pathname === '/api/notify/test') {
        const body = await readBody(req);
        const id = String(body.account || '');
        const k = id ? manager.keeper(id) : null;
        if (k) {
          const r = await k.notifier.send('测试通知', `这是一条测试消息\n时间：${new Date().toLocaleString('zh-CN')}`);
          if (r.ok) return sendJson(res, { success: true });
          return sendJson(res, { error: r.skipped ? '未配置机器人 webhook' : (r.error || '推送失败') }, 400);
        }
        const hook = store.notify().wecomWebhook;
        if (!hook) return sendJson(res, { error: '还没有配置机器人 webhook' }, 400);
        const text = `【TeleAgent保活】测试通知\n这是一条测试消息\n时间：${new Date().toLocaleString('zh-CN')}`;
        try {
          const r = await fetch(hook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
            signal: AbortSignal.timeout(10000)
          });
          const j = await r.json().catch(() => ({}));
          if (j.errcode === 0) return sendJson(res, { success: true });
          return sendJson(res, { error: `errcode=${j.errcode} ${j.errmsg || ''}` }, 400);
        } catch (e) {
          return sendJson(res, { error: e.message }, 400);
        }
      }

      // ---------- 通知模板 ----------
      if (req.method === 'GET' && pathname === '/api/notify/templates') {
        return sendJson(res, { success: true, data: catalog(store.notify().templates) });
      }

      if (req.method === 'POST' && pathname === '/api/notify/templates') {
        const body = await readBody(req);
        // 只改标题前缀
        if (typeof body.headTemplate === 'string') {
          const head = body.headTemplate.trim();
          store.setNotify({ headTemplate: head || DEFAULT_HEAD });
          logger.write('通知标题前缀已更新', 'info', dataDir);
          return sendJson(res, { success: true, data: store.notify() });
        }
        const id = String(body.id || '');
        if (!EVENT_MAP[id]) return sendJson(res, { error: '未知的事件 id' }, 400);
        const title = String(body.title == null ? '' : body.title);
        const bodyText = String(body.body == null ? '' : body.body);
        if (!title.trim() || !bodyText.trim()) {
          return sendJson(res, { error: '标题和正文都不能为空（想恢复默认请用「恢复默认」）' }, 400);
        }
        if (title.length > 200 || bodyText.length > 4000) {
          return sendJson(res, { error: '标题或正文太长' }, 400);
        }
        store.setTemplate(id, { title, body: bodyText });
        logger.write(`通知模板已更新：${EVENT_MAP[id].label}`, 'info', dataDir);
        return sendJson(res, { success: true, data: store.notify() });
      }

      if (req.method === 'POST' && pathname === '/api/notify/templates/reset') {
        store.resetTemplates();
        logger.write('通知模板已全部恢复默认', 'info', dataDir);
        return sendJson(res, { success: true, data: store.notify() });
      }

      // 预览：不落盘，实时看渲染成什么样
      if (req.method === 'POST' && pathname === '/api/notify/templates/preview') {
        const body = await readBody(req);
        const id = String(body.id || '');
        const def = EVENT_MAP[id];
        if (!def) return sendJson(res, { error: '未知的事件 id' }, 400);
        const tpl = (body.title != null || body.body != null)
          ? {
            title: body.title == null ? def.title : String(body.title),
            body: body.body == null ? def.body : String(body.body)
          }
          : store.notify().templates[id];
        const vars = { ...def.sample, ...(body.vars && typeof body.vars === 'object' ? body.vars : {}) };
        const t = render(tpl.title, vars);
        const b = render(tpl.body, vars);
        const head = renderHead(body.headTemplate, { 账号: vars.账号 || '' });
        return sendJson(res, {
          success: true,
          data: {
            title: t.text,
            content: b.text,
            full: `${compose(head, t.text)}\n${b.text}`,
            unknown: [...new Set([...t.unknown, ...b.unknown])]
          }
        });
      }

      // 按模板发一条真实测试消息
      if (req.method === 'POST' && pathname === '/api/notify/templates/test') {
        const body = await readBody(req);
        const id = String(body.id || '');
        const def = EVENT_MAP[id];
        if (!def) return sendJson(res, { error: '未知的事件 id' }, 400);
        const tpl = store.notify().templates[id];
        const vars = { ...def.sample, ...(body.vars && typeof body.vars === 'object' ? body.vars : {}) };
        const title = render(tpl.title, vars).text;
        const content = render(tpl.body, vars).text;
        const hook = store.notify().wecomWebhook;
        if (!hook) return sendJson(res, { error: '还没有配置机器人 webhook' }, 400);
        const head = renderHead(store.notify().headTemplate, { 账号: vars.账号 || '' });
        try {
          const r = await fetch(hook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ msgtype: 'text', text: { content: `${compose(head, title)}\n${content}` } }),
            signal: AbortSignal.timeout(10000)
          });
          const j = await r.json().catch(() => ({}));
          if (j.errcode === 0) return sendJson(res, { success: true });
          return sendJson(res, { error: `errcode=${j.errcode} ${j.errmsg || ''}` }, 400);
        } catch (e) {
          return sendJson(res, { error: e.message }, 400);
        }
      }

      // ---------- 静态文件 ----------
      const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const file = path.join(PUBLIC_DIR, rel);
      if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not Found');
      }
      const data = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    } catch (e) {
      sendJson(res, { error: e.message }, 500);
    }
  });
}

module.exports = { createServer };
