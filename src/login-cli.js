#!/usr/bin/env node
/**
 * 单独验证「账号 + 密码」能不能登录，不经过面板、不写任何数据。
 *
 * 用法一（推荐，密码不进 shell 历史）：
 *   PW='你的密码' node src/login-cli.js 17757383647a
 * 用法二：
 *   node src/login-cli.js 17757383647a '你的密码'
 *
 * 返回码：0 = 登录成功；1 = 失败（看打印的 code 与提示）
 */
const L = require('./login');

const account = process.argv[2] || '';
const password = process.argv[3] || process.env.PW || '';

if (!account || !password) {
  console.log('用法: PW=\'密码\' node src/login-cli.js <账号>');
  process.exit(1);
}

(async () => {
  const t0 = Date.now();
  console.log(`账号：${account}`);
  console.log(`密码：${'*'.repeat(Math.min(password.length, 12))}（${password.length} 位）`);
  console.log('开始登录…');
  try {
    const r = await L.loginByPassword(account, password, { log: (m) => console.log('  ' + m) });
    console.log(`\n[成功] 服务端认的登录名：${r.loginName}`);
    console.log(`  Cookie 长度 ${r.cookie.length}，到期 ${r.expiresAt ? new Date(r.expiresAt).toLocaleString('zh-CN') : '未知'}`);
    console.log(`  耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    process.exit(0);
  } catch (e) {
    console.log(`\n[失败] code=${e.code || '-'}  ${e.message}`);
    if (e.code === '10980003') {
      console.log('  含义：服务端解不开请求体，几乎都是「账号名」写法不对（后缀字母大小写）。');
      console.log('  处理：把账号改成全小写再试，例如 17757383647a。');
    } else if (e.code === '10980039') {
      console.log('  含义：账号名能识别，密码不匹配（或该账号被临时风控锁定）。');
      console.log('  处理：浏览器人工登录一次确认密码；连续失败的话等 15~30 分钟再试。');
    }
    console.log(`  耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    process.exit(1);
  }
})();
