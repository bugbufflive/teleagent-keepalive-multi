/**
 * 通知通道：企业微信机器人（webhook）。
 * ------------------------------------------------------------------
 * 文案来自「通知模板」（template.js），用户在控制台里可编辑；
 * 模板里的 {{变量}} 会在发送前替换成实际值。
 * 多账号场景下，标题前缀会自动带上账号名，方便区分是哪一台出了事。
 * 内置去重冷却，避免掉线抖动时刷屏。
 */
const { EVENT_MAP, render, renderHead, compose, mergeTemplates } = require('./template');

const DEFAULTS = {
  enabled: true,
  channel: 'wecom',
  wecomWebhook: '',
  cooldownMin: 30,
  notifyRecover: true,
  headTemplate: '',
  templates: {}
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

  /** 当前生效的模板表（用户改过的覆盖默认值） */
  templates() {
    return mergeTemplates(this.cfg().templates);
  }

  /**
   * 渲染某个事件的消息
   * @param {string} key   事件 id
   * @param {object} vars  变量表
   * @returns {{title, content, unknown}}
   */
  renderEvent(key, vars) {
    const tpl = this.templates()[key];
    if (!tpl) {
      const def = EVENT_MAP[key];
      return { title: def ? def.title : key, content: '', unknown: [] };
    }
    // 通用变量兜底：调用方没给时间和账号时自动补上，避免模板里出现空值
    const v = {
      时间: new Date().toLocaleString('zh-CN'),
      账号: String(this.tag() || '').trim(),
      ...(vars || {})
    };
    const t = render(tpl.title, v);
    const b = render(tpl.body, v);
    return {
      title: t.text,
      content: b.text,
      unknown: [...new Set([...t.unknown, ...b.unknown])]
    };
  }

  async send(title, content) {
    const c = this.cfg();
    if (!c.enabled || !c.wecomWebhook) return { ok: false, skipped: true };
    const tag = String(this.tag() || '').trim();
    const head = renderHead(c.headTemplate, { 账号: tag });
    try {
      const res = await fetch(c.wecomWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: `${compose(head, title)}\n${content}` } }),
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

  /**
   * 按事件推送（带冷却）
   * @param {string} key          事件 id，见 template.js 的 EVENTS
   * @param {object} vars         变量表，如 { 实例: 'xxx', 状态: '已关机' }
   * @param {number} cooldownMin  该事件的冷却分钟数
   */
  async event(key, vars, cooldownMin) {
    const c = this.cfg();
    const cd = (cooldownMin ?? c.cooldownMin) * 60000;
    const now = Date.now();
    if (this.lastSent[key] && now - this.lastSent[key] < cd) return { ok: false, throttled: true };
    this.lastSent[key] = now;
    const r = this.renderEvent(key, vars || {});
    if (r.unknown.length) {
      this.log(`[通知] 模板「${key}」里有未知变量：${r.unknown.join(', ')}`, 'warning');
    }
    const sent = await this.send(r.title, r.content);
    if (sent.ok) this.log(`[通知] 已推送：${r.title}`, 'info');
    return sent;
  }

  reset(key) {
    if (key) delete this.lastSent[key];
    else this.lastSent = {};
  }
}

module.exports = { Notifier, NOTIFY_DEFAULTS: DEFAULTS };
