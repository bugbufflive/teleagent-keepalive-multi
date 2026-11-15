/**
 * 通知通道：企业微信机器人（webhook）。
 * 多账号场景下，title 前会自动加上账号名，方便区分是哪一台出了事。
 * 内置去重冷却，避免掉线抖动时刷屏。
 */
const DEFAULTS = {
  enabled: true,
  channel: 'wecom',
  wecomWebhook: '',
  cooldownMin: 30,
  notifyRecover: true
};

class Notifier {
  constructor({ getCfg, log, tag }) {
    this.getCfg = getCfg;
    this.log = log || (() => {});
    this.tag = typeof tag === 'function' ? tag : () => '';
    this.lastSent = {};
  }

  cfg() {
    return { ...DEFAULTS, ...(this.getCfg() || {}) };
  }

  async send(title, content) {
    const c = this.cfg();
    if (!c.enabled || !c.wecomWebhook) return { ok: false, skipped: true };
    const tag = String(this.tag() || '').trim();
    const head = tag ? `【TeleAgent保活·${tag}】` : '【TeleAgent保活】';
    try {
      const res = await fetch(c.wecomWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: `${head}${title}\n${content}` } }),
        signal: AbortSignal.timeout(10000)
      });
      const j = await res.json().catch(() => ({}));
      if (j.errcode === 0) return { ok: true };
      this.log(`[通知] 推送失败 errcode=${j.errcode} ${j.errmsg || ''}`, 'warning');
      return { ok: false, error: j.errmsg };
    } catch (e) {
      this.log(`[通知] 推送异常: ${e.message}`, 'warning');
      return { ok: false, error: e.message };
    }
  }

  // 带冷却的事件推送
  async event(key, title, content, cooldownMin) {
    const c = this.cfg();
    const cd = (cooldownMin ?? c.cooldownMin) * 60000;
    const now = Date.now();
    if (this.lastSent[key] && now - this.lastSent[key] < cd) return { ok: false, throttled: true };
    this.lastSent[key] = now;
    const r = await this.send(title, content);
    if (r.ok) this.log(`[通知] 已推送：${title}`, 'info');
    return r;
  }

  reset(key) {
    if (key) delete this.lastSent[key];
    else this.lastSent = {};
  }
}

module.exports = { Notifier, NOTIFY_DEFAULTS: DEFAULTS };
