/**
 * 多账号配置存储
 * ------------------------------------------------------------------
 * data/config.json 结构（v2）：
 * {
 *   "version": 2,
 *   "notify": { enabled, channel, wecomWebhook, cooldownMin, notifyRecover },
 *   "accounts": [ { ...单个账号的全部配置 + checkin }, ... ]
 * }
 *
 * 兼容 v1 单账号配置：首次启动时自动把旧结构包成 accounts[0]，并立刻回写。
 * 密码密文统一用 data/.secret 加密（login.js 里的 encryptPassword/decryptPassword），
 * 与账号无关，所以多账号共用一个密钥文件即可。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DEFAULT_HEAD, mergeTemplates } = require('./template');

const ACCOUNT_DEFAULTS = {
  name: '',            // 面板显示名，留空时按账号/实例自动生成
  enabled: false,
  mode: 'ticket',      // ticket | claim
  authMode: 'cookie',  // cookie | password
  account: '',         // 登录账号
  passwordEnc: '',     // 密码密文
  autoRelogin: true,
  reloginDays: 20,      // 提前 20 天续期（原 7），登录态更耐用到期
  cookie: '',
  instanceId: '',
  deviceCode: '',
  deviceType: 60,
  clientVersion: '103020001',
  osType: 'Windows',
  refreshSec: 120,      // ticket 换票间隔 120s（原 300），活跃刷新更密、实例更不易被回收
  sessionSec: 3600,     // claim 单次会话保持 3600s（原 600），挂机更久
  gapSec: 10,           // claim 会话轮换间隙 10s（原 20），衔接更紧
  pingSec: 5,           // 心跳间隔 5s，保持连接活跃
  claim: true,
  pauseMin: 10,
  cookieAlertDays: 7,   // 提前 7 天提醒（原 3）
  wecomWebhook: '',    // 可选：给这个账号单独指定机器人，留空则用全局
  remark: '',
  pointsAutoClaim: true,   // 每天自动领取「积分福利社」每日积分
  pointsDailyReport: false, // 是否每天定时推送积分播报
  pointsDailyReportAt: '09:00', // 定时播报时间（北京时间 HH:mm）
  checkin: { lastDate: '', streak: 0, lastAt: '' }
};

const NOTIFY_DEFAULTS = {
  enabled: true,
  channel: 'wecom',
  wecomWebhook: '',
  cooldownMin: 30,
  notifyRecover: true,
  headTemplate: DEFAULT_HEAD,   // 消息标题前缀模板
  templates: {}                 // 用户自定义的通知模板（id -> {title, body}）
};

// 长保活参数迁移表：老账号若某字段仍是「旧默认值」，说明用户没改过，自动升级到新值。
// 用户手动调整过的非默认值一律保留，不覆盖。
const KEEPALIVE_UPGRADE = {
  refreshSec:      { from: 300, to: 120 },
  sessionSec:      { from: 600, to: 3600 },
  gapSec:          { from: 20,  to: 10 },
  reloginDays:     { from: 7,   to: 20 },
  cookieAlertDays: { from: 3,   to: 7 }
};

function newId() {
  return crypto.randomBytes(4).toString('hex');
}

function newDeviceCode() {
  return 'web_' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'config.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.data = { version: 2, notify: { ...NOTIFY_DEFAULTS }, accounts: [] };
    this.migrated = false;
    this.load();
  }

  load() {
    let raw = null;
    try {
      if (fs.existsSync(this.file)) raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      this.loadError = e.message;
    }
    if (!raw || typeof raw !== 'object') {
      this.data = { version: 2, notify: { ...NOTIFY_DEFAULTS }, accounts: [] };
      return;
    }

    if (Array.isArray(raw.accounts)) {
      // v2
      this.data = {
        version: 2,
        notify: { ...NOTIFY_DEFAULTS, ...(raw.notify || {}) },
        accounts: raw.accounts.map((a) => this.normalize(a))
      };
    } else if (raw.account || raw.cookie || raw.enabled !== undefined || raw.passwordEnc) {
      // v1 → v2 迁移
      const acc = this.normalize({
        ...raw,
        id: newId(),
        name: raw.name || raw.account || '默认账号'
      });
      delete acc.id_old;
      this.data = {
        version: 2,
        notify: { ...NOTIFY_DEFAULTS, ...(raw.notify || {}) },
        accounts: [acc]
      };
      this.migrated = true;
    }

    // 检测原始配置里是否存在待升级的旧默认值（用 raw 判断，避免新账号被误标脏）
    const needKeepaliveMigrate = (Array.isArray(raw.accounts) ? raw.accounts : [])
      .some((a) => Object.entries(KEEPALIVE_UPGRADE).some(([k, { from }]) => a[k] === from));

    let dirty = this.migrated || needKeepaliveMigrate;
    for (const a of this.data.accounts) {
      if (!a.deviceCode) { a.deviceCode = newDeviceCode(); dirty = true; }
      if (!a.id) { a.id = newId(); dirty = true; }
      if (!a.name) { a.name = a.account || '账号 ' + a.id.slice(0, 4); dirty = true; }
    }
    if (dirty) this.save();
  }

  normalize(a) {
    const acc = {
      ...ACCOUNT_DEFAULTS,
      ...a,
      id: a.id || newId(),
      checkin: { ...ACCOUNT_DEFAULTS.checkin, ...(a.checkin || {}) }
    };
    // 迁移老账号：仍是旧默认值的保活参数升级到长保活值；用户自定义值不动
    for (const [key, { from, to }] of Object.entries(KEEPALIVE_UPGRADE)) {
      if (acc[key] === from) acc[key] = to;
    }
    if (!acc.deviceCode) acc.deviceCode = newDeviceCode();
    return acc;
  }

  save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
      return true;
    } catch (e) {
      this.saveError = e.message;
      return false;
    }
  }

  list() {
    return this.data.accounts;
  }

  get(id) {
    return this.data.accounts.find((a) => a.id === id) || null;
  }

  add(patch = {}) {
    const acc = this.normalize({ ...patch, id: newId() });
    if (!acc.name) acc.name = acc.account || '账号 ' + acc.id.slice(0, 4);
    this.data.accounts.push(acc);
    this.save();
    return acc;
  }

  update(id, patch = {}) {
    const acc = this.get(id);
    if (!acc) return null;
    Object.assign(acc, patch);
    this.save();
    return acc;
  }

  remove(id) {
    const i = this.data.accounts.findIndex((a) => a.id === id);
    if (i < 0) return false;
    this.data.accounts.splice(i, 1);
    this.save();
    return true;
  }

  notify() {
    const raw = { ...NOTIFY_DEFAULTS, ...(this.data.notify || {}) };
    // templates 存的是「用户改过的部分」，读出来时和默认值合并
    raw.templates = mergeTemplates(raw.templates);
    return raw;
  }

  /** 原始（未合并默认值的）通知配置，保存时用它做基底 */
  rawNotify() {
    return { ...(this.data.notify || {}) };
  }

  setNotify(patch = {}) {
    const cur = this.rawNotify();
    // templates 只存用户改过的部分，避免把默认值也写回磁盘
    const next = { ...cur, ...patch };
    if (!next.templates || !Object.keys(next.templates).length) delete next.templates;
    this.data.notify = next;
    this.save();
    return this.notify();
  }

  /** 保存单个事件的模板；传 null 表示恢复默认 */
  setTemplate(id, tpl) {
    const cur = this.rawNotify();
    const templates = { ...(cur.templates || {}) };
    if (tpl === null) delete templates[id];
    else templates[id] = { title: tpl.title, body: tpl.body };
    cur.templates = templates;
    this.data.notify = cur;
    this.save();
    return this.notify();
  }

  /** 全部恢复默认 */
  resetTemplates() {
    const cur = this.rawNotify();
    delete cur.templates;
    cur.headTemplate = DEFAULT_HEAD;
    this.data.notify = cur;
    this.save();
    return this.notify();
  }
}

module.exports = { Store, ACCOUNT_DEFAULTS, NOTIFY_DEFAULTS, newDeviceCode };
