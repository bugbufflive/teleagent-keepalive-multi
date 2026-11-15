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
  checkin: { lastDate: '', streak: 0, lastAt: '' }
};

const NOTIFY_DEFAULTS = {
  enabled: true,
  channel: 'wecom',
  wecomWebhook: '',
  cooldownMin: 30,
  notifyRecover: true
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
    return { ...NOTIFY_DEFAULTS, ...(this.data.notify || {}) };
  }

  setNotify(patch = {}) {
    this.data.notify = { ...this.notify(), ...patch };
    this.save();
    return this.data.notify;
  }
}

module.exports = { Store, ACCOUNT_DEFAULTS, NOTIFY_DEFAULTS, newDeviceCode };
