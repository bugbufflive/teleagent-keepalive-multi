/**
 * 多账号调度器
 * ------------------------------------------------------------------
 * 每个账号对应一个 AccountKeeper，各自跑独立循环、独立 WebSocket，互不干扰。
 * 账号配置对象就是 Store 里的同一个引用，所以改配置后不需要重建实例，
 * 只有「启用状态 / 保活模式 / 登录态」变化时才重启那一个账号的循环。
 */
const { AccountKeeper } = require('./teleagent');

class Manager {
  constructor({ dataDir, store, logger }) {
    this.dataDir = dataDir;
    this.store = store;
    this.logger = logger;
    this.keepers = new Map();
  }

  onKeeperLog(acct) {
    return (msg, level) => {
      this.logger.write(msg, level, this.dataDir, { acct: acct.name || acct.account, acctId: acct.id });
    };
  }

  spawn(account) {
    const k = new AccountKeeper({
      dataDir: this.dataDir,
      store: this.store,
      account,
      onLog: this.onKeeperLog(account)
    });
    this.keepers.set(account.id, k);
    k.start();
    return k;
  }

  startAll() {
    for (const acc of this.store.list()) {
      if (!this.keepers.has(acc.id)) this.spawn(acc);
    }
    this.logger.write(`已加载 ${this.store.list().length} 个账号`, 'success', this.dataDir);
  }

  keeper(id) {
    return this.keepers.get(id) || null;
  }

  statusAll() {
    return this.store.list().map((acc) => {
      const k = this.keepers.get(acc.id);
      if (k) return k.status();
      return this.placeholder(acc);
    });
  }

  placeholder(acc) {
    return {
      id: acc.id,
      name: acc.name || acc.account || acc.id,
      remark: acc.remark || '',
      phase: acc.enabled ? 'idle' : 'disabled',
      enabled: !!acc.enabled,
      runStartedAt: '',
      runningSec: 0,
      mode: acc.mode,
      authMode: acc.authMode,
      account: acc.account || '',
      hasPassword: !!acc.passwordEnc,
      hasCookie: !!acc.cookie,
      autoRelogin: !!acc.autoRelogin,
      reloginDays: acc.reloginDays,
      instanceId: acc.instanceId,
      instanceStatus: null,
      cycles: 0,
      cookieDaysLeft: null,
      cookieExp: null,
      lastCycleAt: '',
      lastTicketAt: '',
      lastError: '',
      checkin: acc.checkin || { lastDate: '', streak: 0, lastAt: '' },
      todayChecked: false,
      points: null,
      pointsAt: '',
      pointsTodayClaimed: null,
      pointsDays: 0,
      pointsTotal: 0,
      pointsDaily: 0,
      pointsExpireAt: '',
      pointsExpireDays: null,
      pointsClaimAt: '',
      pointsError: '',
      pointsAutoClaim: acc.pointsAutoClaim !== false,
      pointsDailyReport: acc.pointsDailyReport === true,
      pointsDailyReportAt: acc.pointsDailyReportAt || '09:00',
      pointsReportAt: '',
      pointsReportDate: '',
      refreshSec: acc.refreshSec,
      pauseMin: acc.pauseMin,
      claim: !!acc.claim,
      notify: { enabled: true, channel: 'wecom', wecomWebhook: '', hasWebhook: false, ownWebhook: !!acc.wecomWebhook, cooldownMin: 30, notifyRecover: true }
    };
  }

  create(patch = {}) {
    const acc = this.store.add(patch);
    this.spawn(acc);
    this.logger.write(`新增账号 ${acc.name}（${acc.account || '未填账号'}）`, 'success', this.dataDir, { acct: acc.name });
    return acc;
  }

  update(id, patch = {}, opts = {}) {
    const acc = this.store.get(id);
    if (!acc) return null;
    const beforeEnabled = acc.enabled;
    const beforeMode = acc.mode;
    const beforeCookie = acc.cookie;
    this.store.update(id, patch);
    const k = this.keepers.get(id);
    if (k) {
      const needRestart = opts.restart === true
        || acc.enabled !== beforeEnabled
        || acc.mode !== beforeMode
        || acc.cookie !== beforeCookie;
      if (needRestart) k.restart();
    } else if (acc.enabled) {
      this.spawn(acc);
    }
    return acc;
  }

  remove(id) {
    const acc = this.store.get(id);
    if (!acc) return false;
    const k = this.keepers.get(id);
    if (k) {
      k.stop();
      this.keepers.delete(id);
    }
    this.store.remove(id);
    this.logger.write(`已删除账号 ${acc.name}`, 'warning', this.dataDir);
    return true;
  }

  restart(id) {
    const k = this.keepers.get(id);
    if (!k) return null;
    return k.restart();
  }

  stopAll() {
    for (const k of this.keepers.values()) {
      try { k.stop(); } catch (e) { /* ignore */ }
    }
    this.keepers.clear();
  }
}

module.exports = { Manager };
