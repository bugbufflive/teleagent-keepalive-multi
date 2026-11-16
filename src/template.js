/**
 * 通知模板引擎
 * ------------------------------------------------------------------
 * 每类通知事件都有独立的「标题 / 正文」模板，模板里用 {{变量}} 占位，
 * 例如：实例：{{实例}}\n状态：{{状态}}
 *
 * 用户可以在控制台「通知模板」里编辑，编辑结果落到 data/config.json 的
 * notify.templates 里；notify.js 发送前用本模块渲染。
 *
 * 本模块不依赖任何其他模块，方便被 store.js / notify.js / web.js 共用。
 */

/** 通知标题前缀模板（账号名从 {{账号}} 取） */
const DEFAULT_HEAD = '【TeleAgent保活·{{账号}}】';

/**
 * 全部通知事件定义
 * ------------------------------------------------------------------
 * id     事件键，代码里 notifier.event(id, vars, cooldown) 用它
 * label  面板上显示的名字
 * desc   什么时候会触发（面板提示）
 * vars   该事件可用的变量（面板上以按钮展示，点一下插入正文）
 * sample 变量的示例值（预览 / 测试时填充）
 * title  默认标题模板
 * body   默认正文模板
 */
const EVENTS = [
  {
    id: 'desktop',
    label: '云电脑掉线',
    desc: '实例被回收或关机，正在自动拉起',
    vars: ['账号', '实例', '状态', '距上次换票', '时间'],
    sample: { 账号: '会员号A', 实例: '01a1d43f-586b-75c6-add0-0b447d000e87', 状态: '已关机', 距上次换票: '312 秒', 时间: '2026/11/16 10:57:45' },
    title: '云电脑掉线，正在自动拉起',
    body: '实例：{{实例}}\n状态：{{状态}}\n距上次换票：{{距上次换票}}\n时间：{{时间}}'
  },
  {
    id: 'desktop-fail',
    label: '云电脑拉起失败',
    desc: '多轮 start 之后实例仍未回到运行中',
    vars: ['账号', '实例', '时间'],
    sample: { 账号: '会员号A', 实例: '01a1d43f-586b-75c6-add0-0b447d000e87', 时间: '2026/11/16 10:57:45' },
    title: '云电脑拉起失败',
    body: '实例：{{实例}}\n多轮 start 后仍未回到运行中\n时间：{{时间}}'
  },
  {
    id: 'desktop-ok',
    label: '云电脑已自动拉起',
    desc: '掉线之后又拉起来了（可在通知设置里关掉）',
    vars: ['账号', '实例', '时间'],
    sample: { 账号: '会员号A', 实例: '01a1d43f-586b-75c6-add0-0b447d000e87', 时间: '2026/11/16 10:57:45' },
    title: '云电脑已自动拉起',
    body: '实例：{{实例}}\n时间：{{时间}}'
  },
  {
    id: 'account',
    label: '登录态失效',
    desc: 'Cookie / 登录态过期，账号掉线',
    vars: ['账号', '原因', '处理', '时间'],
    sample: { 账号: '会员号A', 原因: '没有实例（Cookie 是否已失效？）', 处理: '正在自动重新登录', 时间: '2026/11/16 10:57:45' },
    title: '账号登录态已失效',
    body: '原因：{{原因}}\n处理：{{处理}}\n时间：{{时间}}'
  },
  {
    id: 'login-fail',
    label: '自动登录失败',
    desc: '账号密码自动续期失败',
    vars: ['账号', '原因', '时间'],
    sample: { 账号: '13339387513a', 原因: '密码错误', 时间: '2026/11/16 10:57:45' },
    title: '账号自动登录失败',
    body: '账号：{{账号}}\n原因：{{原因}}\n请到控制台检查账号或密码\n时间：{{时间}}'
  },
  {
    id: 'cookie-expire',
    label: 'Cookie 快过期',
    desc: 'Cookie 剩余天数不足（仅 Cookie 登录模式）',
    vars: ['账号', '剩余天数', '时间'],
    sample: { 账号: '会员号A', 剩余天数: '2', 时间: '2026/11/16 10:57:45' },
    title: 'Cookie 即将过期',
    body: '剩余 {{剩余天数}} 天\n请到控制台更新 Cookie\n时间：{{时间}}'
  },
  {
    id: 'relogin',
    label: '已自动重新登录',
    desc: '账号密码模式下自动续期成功',
    vars: ['账号', '到期', '时间'],
    sample: { 账号: '13339387513a', 到期: '2026/11/23 10:57:45', 时间: '2026/11/16 10:57:45' },
    title: '账号已自动重新登录',
    body: '账号：{{账号}}\n新登录态到期：{{到期}}\n时间：{{时间}}'
  },
  {
    id: 'points-daily',
    label: '每日积分播报',
    desc: '每天固定时间推送一条积分状态汇总（默认早上 9 点）',
    vars: ['账号', '剩余', '今日可领', '今日状态', '已领天数', '累计', '最快到期', '时间'],
    sample: {
      账号: '会员号A',
      剩余: '6300',
      今日可领: '100',
      今日状态: '已领取',
      已领天数: '7',
      累计: '700 分',
      最快到期: '2026-11-30（还有 14 天）',
      时间: '2026/11/16 09:00:00'
    },
    title: '每日积分播报',
    body: '账号：{{账号}}\n剩余积分：{{剩余}}\n今日可领：{{今日可领}}（{{今日状态}}）\n本期已领：{{已领天数}} 天 / 累计 {{累计}}\n最快到期：{{最快到期}}\n时间：{{时间}}'
  },
  {
    id: 'points',
    label: '积分已自动领取',
    desc: '每日积分福利自动领取成功',
    vars: ['账号', '本次', '剩余', '累计', '时间'],
    sample: { 账号: '13339387513a', 本次: '+100', 剩余: '6300', 累计: '7 天 / 700 分', 时间: '2026/11/16 10:57:45' },
    title: '积分已自动领取',
    body: '账号：{{账号}}\n本次：{{本次}}\n剩余：{{剩余}}\n本期累计：{{累计}}\n时间：{{时间}}'
  }
];

const EVENT_MAP = EVENTS.reduce((m, e) => { m[e.id] = e; return m; }, {});

/** 默认模板表（id -> {title, body}） */
const DEFAULT_TEMPLATES = EVENTS.reduce((m, e) => {
  m[e.id] = { title: e.title, body: e.body };
  return m;
}, {});

/**
 * 渲染模板：把 {{变量}} 替换成实际值
 * ------------------------------------------------------------------
 * 未定义的变量会被替换成空串，同时在 unknown 里回报，方便面板提示。
 * @returns {{text: string, unknown: string[]}}
 */
function render(text, vars) {
  const unknown = [];
  const src = text == null ? '' : String(text);
  const out = src.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (m, name) => {
    const key = String(name).trim();
    if (vars && Object.prototype.hasOwnProperty.call(vars, key)) {
      const v = vars[key];
      return v === undefined || v === null ? '' : String(v);
    }
    if (!unknown.includes(key)) unknown.push(key);
    return '';
  });
  return { text: out, unknown };
}

/** 渲染标题前缀，顺手清掉空变量留下的多余分隔符 */
function renderHead(text, vars) {
  const tpl = text && String(text).trim() ? String(text) : DEFAULT_HEAD;
  const { text: out } = render(tpl, vars);
  return out.replace(/·\s*(?=】)/g, '').replace(/·\s*·/g, '·').trim();
}

/**
 * 把标题前缀和正文标题拼成一条消息
 * ------------------------------------------------------------------
 * 前缀以收尾符号结尾时直接相连（如「【…】」），否则换行分开，
 * 避免用户自定义的前缀和标题黏成一团。
 */
function compose(head, title) {
  const h = String(head || '').trim();
  const t = String(title || '');
  if (!h) return t;
  if (!t) return h;
  return /[】\]）)>\*#】]$/.test(h) ? `${h}${t}` : `${h}\n${t}`;
}

/**
 * 合并用户模板和默认模板
 * ------------------------------------------------------------------
 * 用户改过的用用户的，没改过的用默认值；未知的事件 id 直接丢掉。
 */
function mergeTemplates(userTemplates) {
  const src = (userTemplates && typeof userTemplates === 'object') ? userTemplates : {};
  const out = {};
  for (const e of EVENTS) {
    const u = src[e.id] && typeof src[e.id] === 'object' ? src[e.id] : {};
    out[e.id] = {
      title: typeof u.title === 'string' && u.title.trim() ? u.title : e.title,
      body: typeof u.body === 'string' && u.body.trim() ? u.body : e.body
    };
  }
  return out;
}

/**
 * 面板用的目录：把默认模板和当前生效模板一起给前端
 */
function catalog(current) {
  const cur = mergeTemplates(current);
  return {
    headTemplate: DEFAULT_HEAD,
    events: EVENTS.map((e) => ({
      id: e.id,
      label: e.label,
      desc: e.desc,
      vars: e.vars,
      sample: e.sample,
      defaults: { title: e.title, body: e.body },
      current: cur[e.id]
    }))
  };
}

module.exports = {
  EVENTS,
  EVENT_MAP,
  DEFAULT_HEAD,
  DEFAULT_TEMPLATES,
  render,
  renderHead,
  compose,
  mergeTemplates,
  catalog
};
