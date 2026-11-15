/**
 * 单个账号的保活内核（多账号版本）
 * ------------------------------------------------------------------
 * 目标：让 agent.teleai.com.cn 签发的政企云电脑实例不被空闲回收关机。
 *
 * 两种工作模式（cf. mode）：
 *   ticket（默认）：定时调 instance/connect「换票」并丢弃，不建 CLINK 会话、不认领，
 *                  因此不会把浏览器端顶下线。
 *   claim ：建立 wss CLINK 会话并发送 112/104 认领，语义等同「一台常开客户端」。
 *
 * 两种模式都会「自愈」：发现实例 status=3（关机）或 5（排队）时调 instance/start 拉起。
 *
 * 与单账号版的区别：配置不再读写 data/config.json，而是直接操作 Store 里该账号的记录对象，
 * 每个账号一个实例、一个独立循环、一个独立 WebSocket，互不影响。
 */
const WebSocket = require('ws');
const CtYunEncryption = require('./crypto');
const { loginByPassword, encryptPassword, decryptPassword } = require('./login');
const { Notifier } = require('./notify');

const BASE = 'https://agent.teleai.com.cn/teleagent-manager/v1';
const MAGIC = Buffer.from('UkVEUQIAAAACAAAAGgAAAAAAAAABAAEAAAABAAAAEgAAAAkAAAAECAAA', 'base64');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0';

const STATUS_TEXT = { 3: '已关机', 4: '运行中', 5: '排队中', 100: '运行中' };
const RUNNING = [4, 100];

class AccountKeeper {
  constructor(opts = {}) {
    this.dataDir = opts.dataDir;
    this.store = opts.store;
    this.onLog = typeof opts.onLog === 'function' ? opts.onLog : null;
    this.cfg = opts.account;              // Store 内的对象引用，改了就是改了全局
    this.id = this.cfg.id;

    this.enc = new CtYunEncryption();
    this.notifier = new Notifier({
      getCfg: () => this.notifyCfg(),
      tag: () => this.cfg.name || this.cfg.account || '',
      log: (m, l) => this.log(m, l)
    });

    this.ws = null;
    this.stopped = true;
    this.pausedUntil = 0;
    this.state = {
      phase: 'idle',
      accountDead: false,
      lastLoginAt: '',
      lastLoginOk: null,
      lastError: '',
      lastCycleAt: '',
      lastTicketAt: '',
      lastConnectAt: '',
      instanceStatus: null,
      cycles: 0,
      cookieExp: null,
      cookieDaysLeft: null,
      desktopDown: false,
      lastDownAt: ''
    };
  }

  // ---------- 配置 ----------

  saveCfg(patch = {}) {
    Object.assign(this.cfg, patch);
    this.store.save();
    return this.cfg;
  }

  notifyCfg() {
    const g = this.store.notify();
    const own = String(this.cfg.wecomWebhook || '').trim();
    return own ? { ...g, wecomWebhook: own } : g;
  }

  log(msg, level = 'info') {
    if (this.onLog) this.onLog(msg, level, this);
    else console.log(`[${level}] ${msg}`);
  }

  bjDate() {
    return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  }

  // ---------- 账号密码登录 / 自动续期 ----------

  isAuthError(msg) {
    return /没有实例|未登录|登录过期|登录失效|Cookie|401|token/i.test(String(msg || ''));
  }

  async doLogin(reason = '') {
    const account = String(this.cfg.account || '').trim();
    let password = '';
    try {
      password = decryptPassword(this.dataDir, this.cfg.passwordEnc);
    } catch (e) {
      // 密文是用别的 data/.secret 加密的，或者旧格式，都没法解
      throw new Error('密码密文无法解开（与本机 data/.secret 不匹配，多为从别的机器迁移配置时只搬了 config.json），请在该账号里重新输入一次密码');
    }
    if (!account) throw new Error('未配置账号');
    if (!password) {
      throw new Error(this.cfg.passwordEnc
        ? '已存密码密文格式无效（旧版本或已损坏），请重新输入一次密码'
        : '未配置密码');
    }
    this.log(`[登录] ${reason || '开始登录'}（账号 ${account}）`, 'info');
    const r = await loginByPassword(account, password, { log: (m, l) => this.log(m, l) });
    this.saveCfg({ cookie: r.cookie });
    this.state.accountDead = false;
    this.state.lastLoginAt = new Date().toISOString();
    this.state.lastLoginOk = true;
    this.parseIdentity();
    const until = r.expiresAt ? new Date(r.expiresAt).toLocaleString('zh-CN') : '未知';
    this.notifier.event('relogin', '账号已自动重新登录', `账号：${account}\n新登录态到期：${until}`, 5);
    return r;
  }

  async ensureLogin() {
    if (this.cfg.authMode !== 'password' || !this.cfg.autoRelogin) return false;
    if (!this.cfg.account || !this.cfg.passwordEnc) return false;
    const days = this.state.cookieDaysLeft;
    const need = !this.cfg.cookie || this.state.accountDead || (days !== null && days <= Number(this.cfg.reloginDays || 7));
    if (!need) return false;
    await this.doLogin(days === null ? '检查登录态' : `登录态剩余 ${days} 天，提前续期`);
    return true;
  }

  // 先用给到的账号密码真登录一次，成功了才落盘（避免密码错了把配置改坏）
  async loginWith(account, password) {
    const acc = String(account || '').trim();
    if (!acc || !password) throw new Error('账号和密码都要填');
    this.log(`[登录] 尝试账号密码登录（${acc}）…`, 'info');
    const r = await loginByPassword(acc, password, { log: (m, l) => this.log(m, l) });
    this.saveCfg({
      account: r.loginName || acc,   // 服务端认的是小写规范形式，存回可用的那个
      passwordEnc: encryptPassword(this.dataDir, password),
      cookie: r.cookie,
      authMode: 'password'
    });
    this.state.accountDead = false;
    this.state.lastLoginAt = new Date().toISOString();
    this.state.lastLoginOk = true;
    this.parseIdentity();
    this.log(`[登录] 成功，登录态已写入（到期 ${r.expiresAt ? new Date(r.expiresAt).toLocaleString('zh-CN') : '未知'}）`, 'success');
    return r;
  }

  checkin(manual = false) {
    const today = this.bjDate();
    const ck = this.cfg.checkin || { lastDate: '', streak: 0, lastAt: '' };
    if (ck.lastDate === today) return { already: true, ...ck, today };
    const yesterday = new Date(Date.now() + 8 * 3600 * 1000 - 86400000).toISOString().slice(0, 10);
    const streak = ck.lastDate === yesterday ? (ck.streak || 0) + 1 : 1;
    const next = { lastDate: today, streak, lastAt: new Date().toISOString() };
    this.saveCfg({ checkin: next });
    this.log(`[打卡] ${today} 已打卡${manual ? '（手动）' : '（保活自动）'}，连续 ${streak} 天`, 'success');
    return { already: false, ...next, today };
  }

  pauseFor(minutes) {
    const min = Math.max(1, Math.min(180, Number(minutes) || Number(this.cfg.pauseMin) || 10));
    this.pausedUntil = Date.now() + min * 60000;
    try { if (this.ws) this.ws.close(); } catch (e) { /* ignore */ }
    this.log(`[让位] 保活暂停 ${min} 分钟，把云电脑让给你手动使用`, 'info');
    return min;
  }

  // ---------- HTTP ----------

  async httpJson(url, body, headers = {}) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA, ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000)
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch (e) { throw new Error(`响应非 JSON: ${text.slice(0, 120)}`); }
  }

  apiHeaders() {
    return { Cookie: this.cfg.cookie, 'x-client-platform': 'web', Referer: 'https://agent.teleai.com.cn/teleagent' };
  }

  async listInstances() {
    const res = await fetch(`${BASE}/instance/list`, {
      headers: { ...this.apiHeaders(), 'User-Agent': UA },
      signal: AbortSignal.timeout(20000)
    });
    const json = await res.json();
    if (!json || (json.error && json.error.code !== 0)) throw new Error(`实例列表失败: ${JSON.stringify(json).slice(0, 160)}`);
    return json.data || [];
  }

  async resolveInstance() {
    const list = await this.listInstances();
    if (!list.length) throw new Error('该 Cookie 名下没有实例（Cookie 是否已失效？）');
    const ins = this.cfg.instanceId ? list.find((x) => x.id === this.cfg.instanceId) : list[0];
    if (!ins) throw new Error('配置的 instanceId 不存在，请检查或清空后自动选取');
    if (!this.cfg.instanceId) this.saveCfg({ instanceId: ins.id });
    this.state.instanceStatus = ins.status;
    return ins;
  }

  async startInstance() {
    const r = await this.httpJson(`${BASE}/instance/start`, { id: this.cfg.instanceId }, this.apiHeaders());
    if (!r || (r.error && r.error.code !== 0)) throw new Error(`start 失败: ${JSON.stringify(r).slice(0, 160)}`);
    this.log(`[实例] start 已受理，status=${r.data ? r.data.status : '?'}`, 'info');
    return r.data;
  }

  async waitReady(maxMs = 180000) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      try {
        const ins = await this.resolveInstance();
        if (ins && RUNNING.includes(ins.status)) return true;
      } catch (e) { /* 单次失败忽略 */ }
      await sleep(6000);
    }
    return false;
  }

  async connectTicket() {
    const c = await this.httpJson(`${BASE}/instance/connect`, { id: this.cfg.instanceId }, this.apiHeaders());
    if (!c || !c.data || !c.data.connectURL) throw new Error(`connect 未返回连接地址: ${JSON.stringify(c).slice(0, 160)}`);
    return c.data.connectURL;
  }

  async freshConnectUrl() {
    return this.connectTicket();
  }

  parseIdentity() {
    const out = { userId: 0, userName: 'teleagent' };
    const ck = this.cfg.cookie || '';
    const m = ck.match(/x-token=([^;]+)/) || ck.match(/operationToken=([^;]+)/);
    if (!m) return out;
    const parts = m[1].split('.');
    if (parts.length < 2) return out;
    try {
      const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      out.userId = Number(payload.userId || payload.accountId || 0) || 0;
      out.userName = payload.userName || payload.accountName || 'teleagent';
      if (payload.exp) {
        this.state.cookieExp = new Date(payload.exp * 1000).toISOString();
        this.state.cookieDaysLeft = Math.round((payload.exp * 1000 - Date.now()) / 86400000 * 10) / 10;
      }
    } catch (e) { /* JWT 解析失败不影响主流程 */ }
    return out;
  }

  async fetchConnectData(connectURL) {
    const url = connectURL || (await this.connectTicket());
    return this.connectDataByToken(url);
  }

  async connectDataByToken(connectURL) {
    const frag = String(connectURL).split('#')[1] || '';
    const qs = frag.split('?')[1] || '';
    const token = new URLSearchParams(qs).get('token');
    if (!token) throw new Error('connectURL 中未找到 token');
    const d = await this.httpJson('https://desk.ctyun.cn:8810/api/desktop/client/getConnectDataByToken', {
      connectToken: token,
      osType: this.cfg.osType,
      deviceType: Number(this.cfg.deviceType) || 60,
      from: '_ai_target_'
    }, {
      'ctg-devicetype': String(this.cfg.deviceType || 60),
      'ctg-version': this.cfg.clientVersion,
      'ctg-devicecode': this.cfg.deviceCode,
      Referer: 'https://pc.ctyun.cn/',
      Origin: 'https://pc.ctyun.cn'
    });
    if (!d || d.code !== 0 || !d.data) throw new Error(`换连接参数失败: ${JSON.stringify(d).slice(0, 160)}`);
    return d.data;
  }

  async connectTicketWithRetry(times = 3) {
    let lastErr = null;
    for (let i = 0; i < times; i++) {
      try {
        return await this.connectTicket();
      } catch (e) {
        lastErr = e;
        this.log(`[换票] 第 ${i + 1} 次失败：${e.message.slice(0, 120)}`, 'warning');
        await sleep(4000);
      }
    }
    throw lastErr || new Error('换票失败');
  }

  async ensureRunning(ins) {
    const st = ins && ins.status;
    const id = (ins && ins.id) || this.cfg.instanceId;
    const gap = this.state.lastTicketAt ? Math.round((Date.now() - new Date(this.state.lastTicketAt).getTime()) / 1000) : null;
    this.state.desktopDown = true;
    this.state.lastDownAt = new Date().toISOString();
    this.log(`[实例] 当前状态 ${st}（${STATUS_TEXT[st] || '非运行'}），距上次换票 ${gap === null ? '未知' : gap + 's'}，调用 start 拉起…`, 'warning');
    this.notifier.event('desktop', '云电脑掉线，正在自动拉起',
      `实例：${id}\n状态：${STATUS_TEXT[st] || `状态 ${st}`}\n距上次换票：${gap === null ? '未知' : gap + ' 秒'}\n时间：${new Date().toLocaleString('zh-CN')}`,
      Number(this.notifyCfg().cooldownMin) || 30);
    let ok = false;
    for (let i = 0; i < 3 && !ok; i++) {
      try {
        await this.startInstance();
      } catch (e) {
        this.log(`[实例] start 第 ${i + 1} 次失败：${e.message.slice(0, 120)}`, 'warning');
      }
      ok = await this.waitReady(90000);
      if (!ok) await sleep(5000);
    }
    if (!ok) {
      this.notifier.event('desktop-fail', '云电脑拉起失败', `实例：${id}\n多轮 start 后仍未回到运行中`, 60);
      throw new Error('实例拉起超时（未回到 100/4）');
    }
    if (this.notifyCfg().notifyRecover !== false) {
      await this.notifier.event('desktop-ok', '云电脑已自动拉起', `实例：${id}\n时间：${new Date().toLocaleString('zh-CN')}`, 1);
    }
    this.state.desktopDown = false;
  }

  // ---------- ticket 模式 ----------

  async ticketRound() {
    const ins = await this.resolveInstance();
    if (!RUNNING.includes(ins.status)) await this.ensureRunning(ins);

    const url = await this.connectTicketWithRetry();
    try {
      await this.connectDataByToken(url);
      this.state.warmAt = new Date().toISOString();
    } catch (e) {
      this.log(`[预热] 换连接参数失败（不影响保活）：${e.message.slice(0, 120)}`, 'warning');
    }

    this.state.lastTicketAt = new Date().toISOString();
    this.state.instanceStatus = 100;
    this.state.phase = 'online';
    this.state.cycles++;
    this.log(`[换票] 已刷新实例活跃并预热连接（第 ${this.state.cycles} 次），不占客户端位`, 'success');
    return url;
  }

  // ---------- claim 模式 ----------

  async runSession() {
    const data = await this.fetchConnectData();
    const di = data.desktopInfo || {};
    const desktopId = data.desktopId || di.desktopId;
    if (!desktopId || !di.clinkLvsOutHost) throw new Error('连接参数缺少 desktopId / clinkLvsOutHost');

    const idt = this.parseIdentity();
    this.state.lastConnectAt = new Date().toISOString();
    this.state.phase = 'connecting';
    this.log(`[连接] desktopId=${desktopId} 网关=${di.clinkLvsOutHost} 目标=${di.host}:${di.port}`, 'info');

    const wsUrl = `wss://${di.clinkLvsOutHost}/clinkProxy/${desktopId}/MAIN`;
    const holdMs = Math.max(15, Number(this.cfg.sessionSec) || 600) * 1000;

    return await new Promise((resolve) => {
      let done = false;
      let redq = 0;
      let frames = 0;
      let hbTimer = null;
      let holdTimer = null;
      let claimed = false;
      let openedAt = Date.now();

      const finish = (reason) => {
        if (done) return;
        done = true;
        if (hbTimer) clearInterval(hbTimer);
        if (holdTimer) clearTimeout(holdTimer);
        try { if (this.ws) this.ws.close(); } catch (e) { /* ignore */ }
        this.ws = null;
        this.state.phase = 'idle';
        this.state.cycles++;
        const held = ((Date.now() - openedAt) / 1000).toFixed(0);
        this.log(`[会话] ${reason} | 保持 ${held}s | REDQ ${redq} 次 | 画面帧 ${frames} 个`, reason === '正常轮换' ? 'info' : 'warning');
        resolve({ reason, redq, frames });
      };

      const ws = new WebSocket(wsUrl, { headers: { Origin: 'https://pc.ctyun.cn' }, rejectUnauthorized: false });
      this.ws = ws;
      const send = (b) => { try { if (ws.readyState === WebSocket.OPEN) ws.send(b); } catch (e) { /* ignore */ } };

      ws.on('open', () => {
        openedAt = Date.now();
        this.state.phase = 'online';
        this.log('[会话] 通道已建立，开始握手与保活', 'success');
        const hp = String(di.clinkLvsOutHost || '').split(':');
        send(JSON.stringify({ type: 1, ssl: 1, host: hp[0], port: hp[1] || '443', ca: di.caCert, cert: di.clientCert, key: di.clientKey, servername: `${di.host}:${di.port}`, oqs: 0 }));
        setTimeout(() => send(MAGIC), 500);
        holdTimer = setTimeout(() => finish('正常轮换'), holdMs);
      });

      ws.on('message', (raw) => {
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        if (buf.length >= 6 && buf.slice(0, 4).toString('hex').toUpperCase() === '52454451') {
          redq++;
          try { send(this.enc.execute(buf)); } catch (e) { this.state.lastError = `REDQ 应答失败: ${e.message}`; }
          return;
        }
        if (buf.length >= 6) {
          const type = buf.readUInt16LE(0);
          const size = buf.readUInt32LE(2);
          if (type === 4) {
            const p = Buffer.alloc(6 + Math.min(size, 12));
            p.writeUInt16LE(3, 0); p.writeUInt32LE(Math.min(size, 12), 2);
            if (size > 0) buf.copy(p, 6, 6, 6 + Math.min(size, 12));
            send(p); return;
          }
          if (type === 3 && size >= 8) {
            const gen = buf.readUInt32LE(6);
            const a = Buffer.alloc(10);
            a.writeUInt16LE(1, 0); a.writeUInt32LE(4, 2); a.writeUInt32LE(gen, 6);
            send(a); return;
          }
          if (type === 103) {
            const payload = Buffer.from(JSON.stringify({ type: 1, userName: idt.userName, userInfo: '', userId: idt.userId }));
            const s = Buffer.alloc(2 + 4 + 8 + payload.length);
            s.writeUInt16LE(118, 0); s.writeUInt32LE(8 + payload.length, 2);
            payload.copy(s, 14);
            send(s);
            this.log(`[会话] 收到 103 认证，已回传 118 身份 (${idt.userName})`, 'info');

            if (this.cfg.claim && !claimed) {
              try {
                const sId = String(di.token || '');
                const vals = [sId, String(this.cfg.deviceType || 60), String(this.cfg.deviceCode || ''), String(idt.userName || '')];
                const lens = vals.map((x) => Buffer.byteLength(x, 'utf8') + 1);
                const dataSize = 36 + lens.reduce((a, b) => a + b, 0);
                const b = Buffer.alloc(dataSize);
                let off = 0, strOff = 36;
                b.writeUInt32LE(Number(desktopId), off); off += 4;
                for (let i = 0; i < 4; i++) { b.writeUInt32LE(lens[i], off); off += 4; b.writeUInt32LE(strOff, off); off += 4; strOff += lens[i]; }
                let w = 36;
                for (const v of vals) { b.write(v, w, 'utf8'); w += Buffer.byteLength(v, 'utf8') + 1; }
                const m112 = Buffer.alloc(6 + dataSize);
                m112.writeUInt16LE(112, 0); m112.writeUInt32LE(dataSize, 2); b.copy(m112, 6);
                send(m112);
                const m104 = Buffer.alloc(6); m104.writeUInt16LE(104, 0); m104.writeUInt32LE(0, 2);
                send(m104);
                claimed = true;
                this.log('[会话] 已发送 112/104 认领（计入使用中）', 'info');
              } catch (e) {
                this.log(`[会话] 认领报文构造失败: ${e.message}`, 'warning');
              }
            }
            if (!hbTimer) {
              const pingSec = Math.max(3, Number(this.cfg.pingSec) || 5);
              hbTimer = setInterval(() => {
                const hb = Buffer.alloc(6); hb.writeUInt16LE(7, 0); hb.writeUInt32LE(0, 2); send(hb);
              }, pingSec * 1000);
            }
            return;
          }
        }
        frames++;
      });

      ws.on('close', (code, reason) => finish(`服务端断开 code=${code} ${String(reason || '')}`.trim()));
      ws.on('error', (e) => { this.state.lastError = e.message; finish(`连接异常: ${e.message}`); });
    });
  }

  async loop() {
    while (!this.stopped) {
      if (!this.cfg.enabled) {
        this.state.phase = 'disabled';
        await sleep(10000);
        continue;
      }
      try {
        await this.ensureLogin();
      } catch (e) {
        this.state.lastError = `自动登录失败: ${e.message}`;
        this.state.lastLoginOk = false;
        this.log(`[登录] 自动登录失败：${e.message}`, 'error');
        this.notifier.event('login-fail', '账号自动登录失败', `账号：${this.cfg.account}\n原因：${e.message}\n请到控制台检查账号或密码`, 60);
      }
      if (!this.cfg.cookie) {
        this.state.phase = 'nologin';
        await sleep(15000);
        continue;
      }
      this.state.lastCycleAt = new Date().toISOString();
      try {
        if (this.cfg.mode === 'claim') await this.runSession();
        else await this.ticketRound();
        this.state.lastError = '';
        this.state.accountDead = false;
        this.checkin(false);
        if (this.state.cookieDaysLeft !== null && this.state.cookieDaysLeft <= Number(this.cfg.cookieAlertDays || 3)) {
          this.log(`⚠️ 登录态剩余 ${this.state.cookieDaysLeft} 天，${this.cfg.authMode === 'password' ? '将自动重新登录' : '请重新抓取 Cookie'}`, 'warning');
          if (this.cfg.authMode !== 'password') {
            this.notifier.event('cookie-expire', 'Cookie 即将过期', `剩余 ${this.state.cookieDaysLeft} 天\n请到控制台更新 Cookie`, 720);
          }
        }
      } catch (e) {
        this.state.lastError = e.message;
        this.state.phase = 'error';
        this.log(`[错误] ${e.message}`, 'error');
        if (this.isAuthError(e.message)) {
          this.state.accountDead = true;
          this.notifier.event('account', '账号登录态已失效',
            `原因：${e.message}\n处理：${this.cfg.authMode === 'password' ? '正在自动重新登录' : '请到控制台更新 Cookie'}`,
            Number(this.notifyCfg().cooldownMin) || 30);
          if (this.cfg.authMode === 'password' && this.cfg.autoRelogin && this.cfg.account && this.cfg.passwordEnc) {
            try {
              await this.doLogin('登录态失效，立即重登');
            } catch (e2) {
              this.log(`[登录] 重登失败：${e2.message}`, 'error');
            }
          }
        }
      }

      if (this.stopped) break;
      const isPaused = this.pausedUntil && Date.now() < this.pausedUntil;
      if (isPaused) {
        this.state.phase = 'paused';
        const left = this.pausedUntil - Date.now();
        this.log(`[让位] 还有 ${Math.ceil(left / 60000)} 分钟恢复`, 'info');
        await sleep(left + 800);
        this.pausedUntil = 0;
      }
      const waitSec = this.cfg.mode === 'claim'
        ? Math.max(5, Number(this.cfg.gapSec) || 20)
        : Math.max(60, Number(this.cfg.refreshSec) || 300);
      await sleep(waitSec * 1000);
    }
  }

  start() {
    if (!this.stopped) return this.status();
    this.stopped = false;
    this.loop().catch((e) => this.log(`主循环异常退出: ${e.message}`, 'error'));
    const on = this.cfg.enabled && this.cfg.cookie;
    this.log(on ? `保活已启动（模式：${this.cfg.mode}）` : '保活已加载（未启用 / 未填 Cookie）', on ? 'success' : 'info');
    return this.status();
  }

  stop() {
    this.stopped = true;
    try { if (this.ws) this.ws.close(); } catch (e) { /* ignore */ }
    this.state.phase = 'disabled';
  }

  restart() {
    this.stop();
    setTimeout(() => this.start(), 500);
    return this.status();
  }

  status() {
    this.parseIdentity();
    const n = this.notifyCfg();
    const hook = String(n.wecomWebhook || '');
    return {
      ...this.state,
      id: this.cfg.id,
      name: this.cfg.name || this.cfg.account || '账号 ' + this.cfg.id.slice(0, 4),
      remark: this.cfg.remark || '',
      enabled: !!this.cfg.enabled,
      mode: this.cfg.mode,
      authMode: this.cfg.authMode,
      account: this.cfg.account || '',
      hasPassword: !!this.cfg.passwordEnc,
      autoRelogin: !!this.cfg.autoRelogin,
      reloginDays: this.cfg.reloginDays,
      notify: {
        enabled: n.enabled !== false,
        channel: n.channel || 'wecom',
        wecomWebhook: hook ? `${hook.slice(0, 52)}…${hook.slice(-4)}` : '',
        hasWebhook: !!hook,
        ownWebhook: !!String(this.cfg.wecomWebhook || '').trim(),
        cooldownMin: n.cooldownMin,
        notifyRecover: n.notifyRecover !== false
      },
      instanceId: this.cfg.instanceId,
      hasCookie: !!this.cfg.cookie,
      refreshSec: this.cfg.refreshSec,
      sessionSec: this.cfg.sessionSec,
      gapSec: this.cfg.gapSec,
      pingSec: this.cfg.pingSec,
      claim: !!this.cfg.claim,
      pauseMin: this.cfg.pauseMin,
      pausedUntil: this.pausedUntil ? new Date(this.pausedUntil).toISOString() : null,
      checkin: this.cfg.checkin || { lastDate: '', streak: 0, lastAt: '' },
      todayChecked: (this.cfg.checkin || {}).lastDate === this.bjDate()
    };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { AccountKeeper, STATUS_TEXT };
