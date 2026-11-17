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
const { getBootInfo } = require('./komari');

const BASE = 'https://agent.teleai.com.cn/teleagent-manager/v1';
// 积分 / 福利社走的是 meter 服务，跟实例管理不是同一个前缀
const METER = 'https://agent.teleai.com.cn/meter/super-agent';
const DAILY_CLAIM_PATH = '/user/portal/companyStore/checkTask?type=daily_login';
const CLAIMABLE = ['incomplete', 'not_joined', 'fixed'];

const MAGIC = Buffer.from('UkVEUQIAAAACAAAAGgAAAAAAAAABAAEAAAABAAAAEgAAAAkAAAAECAAA', 'base64');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0';

const STATUS_TEXT = { 3: '已关机', 4: '运行中', 5: '排队中', 100: '运行中' };
const RUNNING = [4, 100];

// 云电脑运行时长上限/预警已改为账号级可配置（instanceLimitMin / instanceWarnMin，默认 60/50 分钟）。
// 背景：天翼云公众版规则是「客户端断开连接 1 小时休眠，24 小时关机」——不是固定开机上限，
// 因此默认模式改为 claim（保持真实连接计入在线），并把默认上限设为 60 分钟便于提醒。

// 积分余额最多每 10 分钟刷新一次；自动领取失败后 20 分钟内不重复打接口
const POINTS_REFRESH_MS = 10 * 60 * 1000;
const POINTS_CLAIM_RETRY_MS = 20 * 60 * 1000;
// 定时积分播报默认时间（北京时间 09:00）
const POINTS_DAILY_DEFAULT_AT = '09:00';

/** 把 "HH:mm" 解析成当天的分钟数；格式不对返回 null */
function parseHhMm(s) {
  const m = String(s || '').trim().match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** 当前北京时间（UTC+8）的日期字符串和分钟数 */
function bjNow(now = Date.now()) {
  const d = new Date(now + 8 * 3600 * 1000);
  return {
    date: d.toISOString().slice(0, 10),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes()
  };
}

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
    this.runStartedAt = 0;   // 本次保活启动时间戳（start 时置位，restart 重置）
    this._lastInsStatus = null;  // 上次观测到的实例真实状态（instance/list 的 status）
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
      // 从 cfg 恢复持久化值：程序重启后接着算，不归零
      instanceStartAt: this.cfg.instanceStartAt || '',  // 实例本次开机时间（持久化）
      instanceRuntimeSec: 0,                            // 实例本次已开机秒数（实时算）
      instanceEstStart: !!this.cfg.instanceEstStart,    // 开机时间是否为估算
      cycles: 0,
      cookieExp: null,
      cookieDaysLeft: null,
      desktopDown: false,
      lastDownAt: '',
      // 积分
      points: null,              // 当前剩余积分
      pointsAt: '',              // 余额上次刷新时间
      pointsTodayClaimed: null,  // 今日是否已领（null = 未知）
      pointsDays: 0,             // 本期已领天数
      pointsTotal: 0,            // 本期累计领取积分
      pointsDaily: 0,            // 每日可领积分
      pointsExpireAt: '',        // 最早到期时间
      pointsExpireDays: null,    // 距最早到期还有几天
      pointsClaimAt: '',         // 上次成功领取时间
      pointsReportAt: '',        // 上次定时播报时间
      pointsReportDate: '',      // 上次播报的北京时间日期（用来保证一天只推一次）
      warmOk: null,              // 最近一次预热是否成功
      warmFailAt: '',            // 最近一次预热失败时间
      warmFailCount: 0,          // 预热连续失败次数（成功即归零）
      pointsError: ''
    };
    this.pointsClaimTryAt = 0;
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
    this.resetPointsState();
    const until = r.expiresAt ? new Date(r.expiresAt).toLocaleString('zh-CN') : '未知';
    this.notifier.event('relogin', {
      账号: account,
      到期: until,
      时间: new Date().toLocaleString('zh-CN')
    }, 5);
    return r;
  }

  async ensureLogin() {
    if (this.cfg.authMode !== 'password' || !this.cfg.autoRelogin) return false;
    if (!this.cfg.account || !this.cfg.passwordEnc) return false;
    const days = this.state.cookieDaysLeft;
    const need = !this.cfg.cookie || this.state.accountDead || (days !== null && days <= Number(this.cfg.reloginDays || 20));
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
    this.resetPointsState();
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
    await this.noteInstanceStatus(ins.status);
    this.state.instanceStatus = ins.status;
    return ins;
  }

  // 观测实例状态跳变，记录本次开机时间（instance/list 不返回开机时间，只能靠跳变推断）
  // 开机时间持久化到 config.json：程序重启后读回接着算，不再从 0 开始。
  // 若配置了 Komari 监控，则以探针 uptime 为准（更可靠）。
  async noteInstanceStatus(status) {
    const prev = this._lastInsStatus;
    this._lastInsStatus = status;
    const wasRunning = prev !== null && RUNNING.includes(prev);
    const isRunning = RUNNING.includes(status);

    // 运行中：优先用 Komari 探针校准（含重启后的真实开机时间）
    if (isRunning && String(this.cfg.komariUrl || '').trim()) {
      await this.syncBootFromKomari();
      return;
    }

    if (isRunning && !wasRunning) {
      // 非运行 → 运行：本次开机起点
      // 若已有"新鲜"的持久化开机时间（程序重启后首次观测），直接沿用，不重新计时。
      // 若持久化值距今已超过上限+余量（说明程序长期没跑、记录过期），则重新计时。
      const saved = this.state.instanceStartAt ? new Date(this.state.instanceStartAt).getTime() : 0;
      const limitSec = this.instanceLimitSec();
      // 过期阈值 = 上限 + 1小时余量；不限时(0)则用 24 小时兜底，避免永久残留陈旧值
      const expireMs = (limitSec > 0 ? limitSec + 3600 : 24 * 3600) * 1000;
      const fresh = saved && !Number.isNaN(saved) && (Date.now() - saved) < expireMs;
      if (fresh) {
        this.log(`[实例] 沿用持久化的开机时间 ${this.state.instanceStartAt}，继续计时`, 'info');
      } else {
        // 无有效持久化值：prev===null 说明程序启动时实例已在运行，开机时间未知，用当前时间估算
        const estimated = prev === null;
        this.state.instanceStartAt = new Date().toISOString();
        this.state.instanceEstStart = estimated;
        this.state.instanceRuntimeSec = 0;
        this.saveCfg({
          instanceStartAt: this.state.instanceStartAt,
          instanceEstStart: this.state.instanceEstStart
        });  // 立刻写盘
        if (estimated) {
          this.log('[实例] 首次观测到实例已运行，开机时间未知，从现在开始计时（估算，已持久化）', 'info');
        } else {
          this.log('[实例] 检测到实例已开机，开始记录云电脑运行时间（已持久化）', 'success');
        }
      }
    } else if (!isRunning) {
      // 实例当前非运行。
      // 关键：不立即清零——平台会周期性关机（实测 5~10 分钟一次），
      // 若一关机就清零，重新拉起后会把运行时长归零重算，丢失真实累计值。
      // 改为：记录「首次」停机时刻（后续观测不刷新），保留原开机时间；
      // 只有持续停机超过冷却期才真正清零。
      if (this.state.instanceStartAt) {
        if (!this._downSince) {
          this._downSince = Date.now();
          this.log(`[实例] 实例停机，开始 30 分钟宽限计时（期间重新拉起则沿用原开机时间）`, 'warning');
        }
        const downFor = Date.now() - this._downSince;
        const graceMs = 30 * 60 * 1000;   // 30 分钟冷却期
        if (downFor > graceMs) {
          this.state.instanceStartAt = '';
          this.state.instanceRuntimeSec = 0;
          this.state.instanceEstStart = false;
          this.saveCfg({ instanceStartAt: '', instanceEstStart: false });
          this.log('[实例] 持续停机超过 30 分钟，云电脑运行时间已清零', 'warning');
          this._downSince = 0;
        }
      }
    } else {
      // 恢复运行：退出宽限状态
      this._downSince = 0;
    }

    // 无论跳变与否，实时刷新运行时长
    this.refreshInstanceRuntime();
  }

  liveInstanceRuntime() {
    if (!this.state.instanceStartAt || !RUNNING.includes(this._lastInsStatus)) return 0;
    const start = new Date(this.state.instanceStartAt).getTime();
    if (Number.isNaN(start)) return 0;
    return Math.max(0, Math.floor((Date.now() - start) / 1000));
  }

  refreshInstanceRuntime() {
    this.state.instanceRuntimeSec = this.liveInstanceRuntime();
  }

  // 从 Komari 监控拉取云电脑真实开机时间。
  // 返回 { bootAt, uptime, node, online } 或 null（未配置/失败）。
  async fetchKomariBoot() {
    const url = String(this.cfg.komariUrl || '').trim();
    if (!url) return null;
    try {
      const r = await getBootInfo(url, this.cfg.komariNode || this.cfg.name, this.cfg);
      if (!r.ok) return null;
      return r;
    } catch (e) {
      return null;
    }
  }

  // 用 Komari 校准开机时间。只在观测到实例处于运行状态时调用。
  // 规则：
  //   - Komari 说已开机时长 < 本地记录的运行时长 → 说明中途重启过，以 Komari 为准
  //   - Komari 有值但本地无记录 → 直接用 Komari
  //   - 二者接近（误差 < 60s）→ 不重复写盘
  async syncBootFromKomari() {
    const k = await this.fetchKomariBoot();
    if (!k || !k.bootAt) return null;
    const bootMs = k.bootAt.getTime();
    if (Number.isNaN(bootMs)) return null;

    const localStart = this.state.instanceStartAt ? new Date(this.state.instanceStartAt).getTime() : 0;
    const localRun = this.liveInstanceRuntime();
    const komariRun = Math.max(0, Math.floor((Date.now() - bootMs) / 1000));

    // 只要与本地记录相差超过 60 秒，就以探针为准（探针读的是真实系统 uptime）。
    // 本地记录来源：①程序重启时实例已在运行 → 用当前时间估算（偏晚，运行时长偏短）
    //                ②状态跳变推断 → 可能因平台频繁关机而失真
    // 两种情况探针都更准，所以不做方向判断，直接覆盖。
    const diff = Math.abs(komariRun - localRun);
    const needUpdate = !localStart || diff > 60;
    if (needUpdate) {
      this.state.instanceStartAt = k.bootAt.toISOString();
      this.state.instanceEstStart = false;   // 来自探针，不是估算
      this.state.komariNode = k.node;
      this.state.komariOnline = k.online;
      this.saveCfg({ instanceStartAt: this.state.instanceStartAt, instanceEstStart: false });
      const why = !localStart ? '本地无记录' : `与本地记录相差 ${diff}s`;
      this.log(`[Komari] 采用监控探针开机时间 ${k.bootAt.toISOString()}（节点 ${k.node}，已运行 ${komariRun}s；${why}）`, 'info');
    }
    this.refreshInstanceRuntime();
    return k;
  }

  // 可配置的上限/预警（分钟→秒）。instanceLimitMin=0 表示不限时、不预警。
  instanceLimitSec() {
    const min = Number(this.cfg.instanceLimitMin);
    if (!Number.isFinite(min) || min < 0) return 60 * 60;  // 非法值 → 默认 60 分钟
    if (min === 0) return 0;                              // 0 = 不限时，不预警
    return min * 60;
  }
  instanceWarnSec() {
    const limit = this.instanceLimitSec();
    if (limit <= 0) return 0;
    const min = Number(this.cfg.instanceWarnMin);
    const warn = (Number.isFinite(min) && min > 0 ? min : 50) * 60;
    return Math.min(warn, limit);  // 预警不超过上限
  }
  isInstanceWarn() {
    if (this.instanceLimitSec() <= 0) return false;  // 不限时不预警
    return this.liveInstanceRuntime() >= this.instanceWarnSec();
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

  // ---------- 积分 / 福利社 ----------

  // 换了登录态以后，积分缓存和「今日已领」判断都得重来
  resetPointsState() {
    this.pointsClaimTryAt = 0;
    Object.assign(this.state, {
      points: null,
      pointsAt: '',
      pointsTodayClaimed: null,
      pointsDays: 0,
      pointsTotal: 0,
      pointsDaily: 0,
      pointsClaimAt: '',
      pointsReportAt: '',
      pointsReportDate: '',
      pointsError: ''
    });
  }

  meterHeaders() {
    return {
      Cookie: this.cfg.cookie,
      'x-client-platform': 'web',
      'User-Agent': UA,
      Referer: 'https://agent.teleai.com.cn/teleagent'
    };
  }

  async meterGet(p) {
    const res = await fetch(METER + p, { headers: this.meterHeaders(), signal: AbortSignal.timeout(20000) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { throw new Error(`积分接口返回非 JSON（HTTP ${res.status}）`); }
    if (!json || json.code !== 200) {
      const msg = (json && (json.msg || json.message)) || text.slice(0, 100);
      throw new Error(`积分接口失败（HTTP ${res.status}）：${msg}`);
    }
    return json.data;
  }

  // 剩余积分 + 最近到期时间
  async refreshPoints() {
    const d = await this.meterGet('/user/portal/points/detail');
    const bal = Number(d && d.pointsBalance);
    this.state.points = Number.isNaN(bal) ? null : bal;
    this.state.pointsAt = new Date().toISOString();
    let earliest = null;
    for (const g of (d && d.groups) || []) {
      for (const it of g.active || []) {
        if (it.isExpired || !it.effectiveEnd) continue;
        if (Number(it.balance) <= 0) continue;
        // 服务端给的是北京时间字符串 "2026-11-30 23:59:59"
        const t = new Date(String(it.effectiveEnd).replace(' ', 'T') + '+08:00').getTime();
        if (Number.isNaN(t)) continue;
        if (earliest === null || t < earliest) earliest = t;
      }
    }
    if (earliest) {
      this.state.pointsExpireAt = new Date(earliest).toISOString();
      this.state.pointsExpireDays = Math.round(((earliest - Date.now()) / 86400000) * 10) / 10;
    } else {
      this.state.pointsExpireAt = '';
      this.state.pointsExpireDays = null;
    }
    return this.state.points;
  }

  // 每日领取任务的状态（今日是否已领 / 已领天数 / 累计积分）
  async pointTaskStatus() {
    const d = await this.meterGet('/user/portal/companyStore/checkDayTask');
    if (d) {
      this.state.pointsTodayClaimed = !!d.claimed_today;
      this.state.pointsDays = Number(d.total_claim_days) || 0;
      this.state.pointsTotal = Number(d.total_claimed_points) || 0;
      this.state.pointsDaily = Number(d.daily_claimable_points) || 0;
    }
    return d || null;
  }

  async claimDailyPoints(trigger = '手动') {
    const before = this.state.points;
    const st = await this.pointTaskStatus();
    if (st && st.claimed_today) {
      this.state.pointsError = '';
      this.log(`[积分] 今日已领过（本期 ${this.state.pointsDays} 天 / ${this.state.pointsTotal} 分），无需重复领取`, 'info');
      return { already: true, balance: this.state.points, days: this.state.pointsDays, total: this.state.pointsTotal };
    }

    // 领取地址优先从 v3 任务里读，平台改路径能自动跟上；读不到就用兜底路径
    let path = DAILY_CLAIM_PATH;
    try {
      const v3 = await this.meterGet('/user/portal/companyStore/v3/checkDayTask');
      const task = ((v3 && v3.activity_data) || []).find((x) => x.action_type === 'api'
        && /checkTask/i.test(String(x.jump_url || ''))
        && CLAIMABLE.includes(x.action_status));
      if (task) path = String(task.jump_url).replace(/^.*?\/superCowork\/sapi/, '');
    } catch (e) { /* 用兜底路径 */ }

    await this.meterGet(path);
    await this.pointTaskStatus().catch(() => null);
    await this.refreshPoints().catch(() => null);

    const gained = before != null && this.state.points != null ? this.state.points - before : null;
    this.state.pointsClaimAt = new Date().toISOString();
    this.state.pointsError = '';
    if (gained !== null && gained <= 0) {
      // 接口返回成功但余额没动：多半是今天已经领过，或福利社活动已结束
      this.log(`[积分] ${trigger}领取接口已调用，但余额未变化（剩余 ${this.state.points}），今日可能已领过或活动已结束`, 'warning');
      return { already: true, gained: 0, balance: this.state.points, days: this.state.pointsDays, total: this.state.pointsTotal };
    }
    this.log(`[积分] ${trigger}领取成功${gained ? ` +${gained}` : ''}，剩余 ${this.state.points == null ? '未知' : this.state.points}，本期已领 ${this.state.pointsDays} 天 / ${this.state.pointsTotal} 分`, 'success');
    if (trigger !== '手动') {
      this.notifier.event('points', {
        账号: this.cfg.account || this.cfg.name,
        本次: gained ? '+' + gained : '已完成',
        剩余: this.state.points == null ? '未知' : this.state.points,
        累计: `${this.state.pointsDays} 天 / ${this.state.pointsTotal} 分`,
        时间: new Date().toLocaleString('zh-CN')
      }, 720);
    }
    return { already: false, gained, balance: this.state.points, days: this.state.pointsDays, total: this.state.pointsTotal };
  }

  // 保活循环里调：余额到期就刷新，今天没领就自动领
  async syncPoints() {
    if (!this.cfg.cookie) return null;
    const auto = this.cfg.pointsAutoClaim !== false;
    const last = this.state.pointsAt ? new Date(this.state.pointsAt).getTime() : 0;
    const stale = Date.now() - last > POINTS_REFRESH_MS;
    const dueClaim = auto && this.state.pointsTodayClaimed !== true && Date.now() - this.pointsClaimTryAt > POINTS_CLAIM_RETRY_MS;
    if (!stale && !dueClaim) return null;
    if (dueClaim) this.pointsClaimTryAt = Date.now();
    try {
      if (dueClaim) await this.claimDailyPoints('自动');
      else await this.pointTaskStatus().catch(() => null);
      if (stale) await this.refreshPoints();
      this.state.pointsError = '';
    } catch (e) {
      this.state.pointsError = e.message;
      this.log(`[积分] 同步失败：${e.message.slice(0, 120)}`, 'warning');
    }
    return this.state;
  }

  // ---------- 每日定时积分播报 ----------

  /** 播报时间（北京时间 HH:mm），配置无效时回落到默认 09:00 */
  pointsReportAt() {
    const raw = String(this.cfg.pointsDailyReportAt || '').trim();
    const m = parseHhMm(raw);
    return m === null ? parseHhMm(POINTS_DAILY_DEFAULT_AT) : m;
  }

  /** 播报时间的人类可读形式，如 "09:00" */
  pointsReportAtText() {
    const m = this.pointsReportAt();
    const h = String(Math.floor(m / 60)).padStart(2, '0');
    const min = String(m % 60).padStart(2, '0');
    return `${h}:${min}`;
  }

  /**
   * 到点了没？只在北京时间当天、且到达设定时刻之后才算。
   * 已经播报过今天就不再重复。
   */
  pointsReportDue(now = Date.now()) {
    if (this.cfg.pointsDailyReport !== true) return false;
    if (!this.cfg.cookie) return false;
    const { date, minutes } = bjNow(now);
    if (this.state.pointsReportDate === date) return false;
    return minutes >= this.pointsReportAt();
  }

  /**
   * 推送一条积分状态汇总
   * @param {boolean} force 手动触发时忽略时间限制
   */
  async sendPointsDailyReport(force = false) {
    if (!force && !this.pointsReportDue()) return { skipped: true };
    const { date } = bjNow();
    if (force && this.state.pointsReportDate === date) {
      // 手动重发允许，但不再改日期标记
    } else {
      this.state.pointsReportDate = date;
    }

    // 先把最新数据拉一遍，播报内容才准
    try {
      await this.pointTaskStatus().catch((e) => {
        this.log(`[积分播报] 领取状态刷新失败：${e.message.slice(0, 100)}`, 'warning');
      });
      await this.refreshPoints().catch((e) => {
        this.log(`[积分播报] 余额刷新失败：${e.message.slice(0, 100)}`, 'warning');
      });
    } catch (e) { /* 上面已经 catch，这里兜底 */ }

    const expire = this.state.pointsExpireAt
      ? `${new Date(this.state.pointsExpireAt).toLocaleDateString('zh-CN')}` +
        (this.state.pointsExpireDays != null ? `（还有 ${this.state.pointsExpireDays} 天）` : '')
      : '无';

    this.state.pointsReportAt = new Date().toISOString();
    const r = await this.notifier.event('points-daily', {
      账号: this.cfg.name || this.cfg.account || '',
      剩余: this.state.points == null ? '未知' : this.state.points,
      今日可领: this.state.pointsDaily == null ? '未知' : this.state.pointsDaily,
      今日状态: this.state.pointsTodayClaimed === true ? '已领取' : '未领取',
      已领天数: this.state.pointsDays || 0,
      累计: `${this.state.pointsTotal || 0} 分`,
      最快到期: expire,
      时间: new Date().toLocaleString('zh-CN')
    }, 60);

    if (r.ok) {
      this.log(`[积分播报] 已推送每日积分播报（剩余 ${this.state.points == null ? '未知' : this.state.points}）`, 'success');
    } else if (r.throttled) {
      this.log('[积分播报] 冷却中，跳过本次播报', 'info');
    }
    return r;
  }

  async ensureRunning(ins) {
    // 并发保护：同一账号的多个轮次可能同时检测到关机，只让一个执行拉起
    if (this._starting) {
      this.log('[实例] 已有拉起任务在进行，跳过重复调用', 'warning');
      await this._starting;
      return;
    }
    this._starting = (async () => {
      const st = ins && ins.status;
      const id = (ins && ins.id) || this.cfg.instanceId;
      const gap = this.state.lastTicketAt ? Math.round((Date.now() - new Date(this.state.lastTicketAt).getTime()) / 1000) : null;
      this.state.desktopDown = true;
      this.state.lastDownAt = new Date().toISOString();
      this.log(`[实例] 当前状态 ${st}（${STATUS_TEXT[st] || '非运行'}），距上次换票 ${gap === null ? '未知' : gap + 's'}，调用 start 拉起…`, 'warning');
      this.notifier.event('desktop', {
        账号: this.cfg.name || this.cfg.account || '',
        实例: id,
        状态: STATUS_TEXT[st] || `状态 ${st}`,
        距上次换票: gap === null ? '未知' : gap + ' 秒',
        时间: new Date().toLocaleString('zh-CN')
      }, Number(this.notifyCfg().cooldownMin) || 30);
      // 3 次尝试，但每次只等 40 秒（原来 90 秒），最坏 2 分钟而非 4.5 分钟
      let ok = false;
      for (let i = 0; i < 3 && !ok; i++) {
        try {
          await this.startInstance();
        } catch (e) {
          this.log(`[实例] start 第 ${i + 1} 次失败：${e.message.slice(0, 120)}`, 'warning');
        }
        ok = await this.waitReady(40000);
        if (!ok && i < 2) await sleep(3000);
      }
      if (!ok) {
        this.notifier.event('desktop-fail', {
          账号: this.cfg.name || this.cfg.account || '',
          实例: id,
          时间: new Date().toLocaleString('zh-CN')
        }, 60);
        this.state.desktopDown = false;
        throw new Error('实例拉起超时（未回到 100/4）');
      }
      if (this.notifyCfg().notifyRecover !== false) {
        await this.notifier.event('desktop-ok', {
          账号: this.cfg.name || this.cfg.account || '',
          实例: id,
          时间: new Date().toLocaleString('zh-CN')
        }, 1);
      }
      this.state.desktopDown = false;
    })();
    try {
      await this._starting;
    } finally {
      this._starting = null;
    }
  }

  // ---------- ticket 模式 ----------

  async ticketRound() {
    const ins = await this.resolveInstance();
    const realStatus = Number(ins.status);
    if (!RUNNING.includes(realStatus)) await this.ensureRunning(ins);

    const url = await this.connectTicketWithRetry();
    let warmOk = false;
    try {
      await this.connectDataByToken(url);
      warmOk = true;
      this.state.warmAt = new Date().toISOString();
      this.state.warmFailCount = 0;
    } catch (e) {
      this.state.warmFailAt = new Date().toISOString();
      this.state.warmFailCount++;
      this.log(`[预热] 换连接参数失败（不影响保活）：${e.message.slice(0, 120)}`, 'warning');
      // 连续失败说明连接凭证失效，需要人工介入；告警但不停摆
      if (this.state.warmFailCount > 0 && this.state.warmFailCount % 20 === 1) {
        this.log(`[预热] 已连续 ${this.state.warmFailCount} 次失败，连接凭证可能失效，建议重新登录账号`, 'error');
      }
    }

    // 真实状态：换票后再查一次，不用 100 假在线掩盖已关机的事实
    const after = await this.resolveInstance().catch(() => null);
    const nowStatus = after ? Number(after.status) : realStatus;
    const running = RUNNING.includes(nowStatus);

    this.state.lastTicketAt = new Date().toISOString();
    this.state.instanceStatus = nowStatus;
    this.state.phase = running ? 'online' : 'down';
    this.state.warmOk = warmOk;
    this.state.cycles++;
    if (running) {
      this.log(`[换票] 已刷新实例活跃并预热连接（第 ${this.state.cycles} 次），不占客户端位`, 'success');
    } else {
      this.log(`[换票] 已刷新活跃，但实例状态 ${nowStatus}（${STATUS_TEXT[nowStatus] || '非运行'}），等待下一轮拉起`, 'warning');
    }
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
    const holdMs = Math.max(15, Number(this.cfg.sessionSec) || 3600) * 1000;

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
        this.notifier.event('login-fail', {
          账号: this.cfg.account,
          原因: e.message,
          时间: new Date().toLocaleString('zh-CN')
        }, 60);
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
        await this.syncPoints();
        await this.sendPointsDailyReport();
        if (this.state.cookieDaysLeft !== null && this.state.cookieDaysLeft <= Number(this.cfg.cookieAlertDays || 7)) {
          this.log(`⚠️ 登录态剩余 ${this.state.cookieDaysLeft} 天，${this.cfg.authMode === 'password' ? '将自动重新登录' : '请重新抓取 Cookie'}`, 'warning');
          if (this.cfg.authMode !== 'password') {
            this.notifier.event('cookie-expire', {
              账号: this.cfg.name || this.cfg.account || '',
              剩余天数: this.state.cookieDaysLeft,
              时间: new Date().toLocaleString('zh-CN')
            }, 720);
          }
        }
      } catch (e) {
        this.state.lastError = e.message;
        this.state.phase = 'error';
        this.log(`[错误] ${e.message}`, 'error');
        if (this.isAuthError(e.message)) {
          this.state.accountDead = true;
          this.notifier.event('account', {
            账号: this.cfg.name || this.cfg.account || '',
            原因: e.message,
            处理: this.cfg.authMode === 'password' ? '正在自动重新登录' : '请到控制台更新 Cookie',
            时间: new Date().toLocaleString('zh-CN')
          }, Number(this.notifyCfg().cooldownMin) || 30);
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
        ? Math.max(5, Number(this.cfg.gapSec) || 10)
        : Math.max(60, Number(this.cfg.refreshSec) || 120);
      // 分段等待：每 15 秒快速查一次实例状态，一旦关机立即结束等待进入下一轮触发自愈，
      // 避免 ticket 模式因 120s 长等待导致关机后迟迟不拉起。claim 模式本就 10s 一轮。
      await this.sleepWithWatch(waitSec * 1000);
    }
  }

  // 分段 sleep：期间定期查实例状态，发现关机(非运行)则提前返回，让主循环尽快自愈。
  // 不直接调 ensureRunning，避免与主循环并发拉起；只负责"提前结束休眠"。
  async sleepWithWatch(totalMs) {
    const STEP = 15000;  // 每 15 秒查一次
    let waited = 0;
    while (waited < totalMs && !this.stopped) {
      const step = Math.min(STEP, totalMs - waited);
      await sleep(step);
      waited += step;
      if (this.stopped) return;
      try {
        const list = await this.listInstances();
        const ins = this.cfg.instanceId ? list.find((x) => x.id === this.cfg.instanceId) : list[0];
        if (ins && !RUNNING.includes(ins.status)) {
          this.log(`[快检] 等待期间发现实例已关机(status=${ins.status})，提前进入自愈`, 'warning');
          return;  // 提前结束等待 → 下一轮 resolveInstance → ensureRunning
        }
      } catch (e) { /* 快检失败不影响主循环 */ }
    }
  }

  start() {
    if (!this.stopped) return this.status();
    this.stopped = false;
    this.runStartedAt = Date.now();   // 每次启动（含 restart）重置计时
    // 配了 Komari 就立刻用探针校准一次：程序重启后本地记录的开机时间
    // 往往是"启动时刻估算"，与真实开机时间有偏差，探针一上来就纠正。
    if (String(this.cfg.komariUrl || '').trim()) {
      this.syncBootFromKomari()
        .then((k) => { if (k) this.log(`[Komari] 启动即校准：节点 ${k.node}，已运行 ${Math.round((Date.now() - k.bootAt.getTime()) / 1000)}s`, 'info'); })
        .catch((e) => this.log(`[Komari] 启动校准失败：${e.message}`, 'warning'));
    }
    this.supervise();
    const on = this.cfg.enabled && this.cfg.cookie;
    this.log(on ? `保活已启动（模式：${this.cfg.mode}）` : '保活已加载（未启用 / 未填 Cookie）', on ? 'success' : 'info');
    return this.status();
  }

  stop() {
    this.stopped = true;
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    try { if (this.ws) this.ws.close(); } catch (e) { /* ignore */ }
    this.state.phase = 'disabled';
  }

  restart() {
    this.stop();
    setTimeout(() => this.start(), 500);
    return this.status();
  }

  // 守护主循环：任何未捕获异常导致 loop() 退出时，自动退避重启，
  // 保证无人值守长期运行（7×24）不因一次异常就永久停摆。
  supervise() {
    if (this.stopped) return;
    this.loop().then(
      () => { if (!this.stopped) this.retryLoop('主循环意外结束'); },
      (e) => { this.log(`主循环异常退出: ${e.message}`, 'error'); this.retryLoop(`主循环异常: ${e.message}`); }
    );
  }

  retryLoop(reason) {
    if (this.stopped) return;
    this._retryCount = (this._retryCount || 0) + 1;
    const wait = Math.min(60000, 5000 * this._retryCount);   // 5s → 10s → 15s … 最长 60s
    this.log(`[守护] ${reason}，${Math.round(wait / 1000)} 秒后自动重启保活循环`, 'warning');
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._retryCount = 0;
      this.supervise();
    }, wait);
    if (this._retryTimer.unref) this._retryTimer.unref();
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
      runStartedAt: this.runStartedAt ? new Date(this.runStartedAt).toISOString() : '',
      runningSec: (this.cfg.enabled && !this.stopped && this.runStartedAt)
        ? Math.max(0, Math.floor((Date.now() - this.runStartedAt) / 1000))
        : 0,
      // 云电脑实例本次开机运行时长 + 可配置上限预警（默认 60/50 分钟）
      // 实时计算，避免面板 4 秒刷新时数字卡住（resolveInstance 可能 120 秒才跑一次）
      instanceStartAt: this.state.instanceStartAt,
      instanceRuntimeSec: this.liveInstanceRuntime(),
      instanceEstStart: !!this.state.instanceEstStart,
      instanceLimitSec: this.instanceLimitSec(),
      instanceWarnSec: this.instanceWarnSec(),
      instanceWarn: this.isInstanceWarn(),
      instanceLimitMin: Number(this.cfg.instanceLimitMin) || 0,
      instanceWarnMin: Number(this.cfg.instanceWarnMin) || 0,
      warmOk: this.state.warmOk,
      warmFailCount: this.state.warmFailCount,
      komariNode: this.state.komariNode || '',
      komariOnline: this.state.komariOnline == null ? null : this.state.komariOnline,
      komariUrl: String(this.cfg.komariUrl || ''),
      komariNodeCfg: String(this.cfg.komariNode || ''),
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
      todayChecked: (this.cfg.checkin || {}).lastDate === this.bjDate(),
      pointsAutoClaim: this.cfg.pointsAutoClaim !== false,
      pointsDailyReport: this.cfg.pointsDailyReport === true,
      pointsDailyReportAt: this.pointsReportAtText(),
      pointsReportAt: this.state.pointsReportAt || '',
      pointsReportDate: this.state.pointsReportDate || ''
    };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { AccountKeeper, STATUS_TEXT };
