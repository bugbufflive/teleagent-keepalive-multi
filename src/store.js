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
  reloginDays: 7,
  cookie: '',
  instanceId: '',
  deviceCode: '',
  deviceType: 60,
  clientVersion: '103020001',
  osType: 'Windows',
  refreshSec: 300,
  sessionSec: 600,
  gapSec: 20,
  pingSec: 5,
  claim: true,
  pauseMin: 10,
  cookieAlertDays: 3,
  wecomWebhook: '',    // 可选：给这个账号单独指定机器人，留空则用全局
  remark: '',
  pointsAutoClaim: true,   // 每天自动领取「积分福利社」每日积分
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

    let dirty = this.migrated;
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
