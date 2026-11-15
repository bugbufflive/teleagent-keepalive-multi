/**
 * TeleAgent（天翼星辰）账号密码登录
 * ------------------------------------------------------------------
 * 链路（2026-11 抓包复原）：
 *   1. GET  /upms/public/auth/getRsaPublicKey        取 RSA 公钥 + keyId
 *   2. POST /upms/public/captcha/get                 blockPuzzle 滑块图
 *   3. 本地识别缺口坐标 → POST /upms/public/captcha/check
 *   4. POST /upms/public/auth/accountNameLogin       账号密码落在 AES-GCM 里
 *   5. GET  返回的 redirectUri（带 code）       → Set-Cookie: operationToken
 *
 * 加密细节（来自官方前端 accountEncrypt 模块）：
 *   AES-128-GCM，AAD = "loginName=..&keyId=..&timestamp=..&requestId=..&clientId=.."
 *   encryptedKeyIv = RSA-OAEP(SHA-256)(aesKey(16B) + iv(12B))
 *   验证码 captchaVerification = AES-128-ECB-PKCS7(secretKey, token + "---" + {"x":x,"y":5})
 *
 * 2026-11-14 修复「滑块连续 4 次未通过」：
 *   原始实现按「白色连通块面积最大」选缺口，但服务端图里同时画了
 *   ① 真正的缺口  ② 被挖出来的拼图块预览（两块面积非常接近，甚至预览块更大），
 *   所以经常选中预览块 → x 偏出 80~120px → 必然失败。
 *   现在改用 jigsawImageBase64 的 alpha 通道不透明区，先拿到缺口的纵向范围，
 *   再用该范围去筛原图里的白块，实测算出的 x 连续多次一次通过。
 */
const crypto = require('crypto');
const zlib = require('zlib');

const API = 'https://www.teleai.com.cn/teleai-api';
const CLIENT_ID = 'Z2veLLEHhZfq3hb5hWIwqJuPajIuasYi';
const REDIRECT = 'https://agent.teleai.com.cn/superCowork/sapi/cowork/auth?source=4&state=https://agent.teleai.com.cn/teleagent';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0';
const REFERER = 'https://www.teleai.com.cn/master-auth';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(url, { method = 'POST', body, headers = {}, redirect } = {}) {
  const h = { 'User-Agent': UA, Origin: 'https://www.teleai.com.cn', Referer: REFERER, ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: redirect || 'follow',
    signal: AbortSignal.timeout(20000)
  });
  return res;
}

async function postJson(path, body) {
  const res = await req(API + path, { body });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${path} 响应非 JSON（HTTP ${res.status}）`);
  }
}

// ---------- 极简 PNG 解码（只支持 8bit 非隔行 RGB/RGBA，够用于滑块图） ----------
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (data[12] !== 0) throw new Error('不支持隔行 PNG');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) throw new Error('不支持的 PNG 格式');
  const ch = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.slice(pos, pos + stride); pos += stride;
    const cur = out.slice(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.slice((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
  }
  return { width, height, ch, data: out };
}

// jigsaw 小图的 alpha 不透明区 = 缺口的纵向范围（这是区分「缺口」和「预览块」的关键）
function bandFromJigsaw(jigsawPng) {
  if (!jigsawPng || !jigsawPng.length) return null;
  try {
    const j = decodePng(jigsawPng);
    if (j.ch !== 4) return null;
    let y0 = -1, y1 = -1;
    for (let y = 0; y < j.height; y++) {
      let c = 0;
      for (let x = 0; x < j.width; x++) if (j.data[(y * j.width + x) * 4 + 3] > 10) c++;
      if (c > 2) { if (y0 < 0) y0 = y; y1 = y; }
    }
    return y0 >= 0 && y1 > y0 ? { y0, y1 } : null;
  } catch (e) {
    return null;
  }
}

// 找出原图里所有白色描边的连通块
function whiteBlocks(origPng, thresh) {
  const t = thresh || 225;
  const img = decodePng(origPng);
  const { width, height, ch, data } = img;
  const isWhite = (x, y) => {
    const i = (y * width + x) * ch;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    return Math.min(r, g, b) > t && Math.max(r, g, b) - Math.min(r, g, b) < 18;
  };
  const seen = new Uint8Array(width * height);
  const out = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (seen[y * width + x] || !isWhite(x, y)) continue;
      const stack = [[x, y]];
      seen[y * width + x] = 1;
      let n = 0, minX = x, maxX = x, minY = y, maxY = y;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        n++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            if (seen[ny * width + nx]) continue;
            if (!isWhite(nx, ny)) continue;
            seen[ny * width + nx] = 1;
            stack.push([nx, ny]);
          }
        }
      }
      if (n > 40) out.push({ n, minX, maxX, minY, maxY, w: maxX - minX + 1, h: maxY - minY + 1 });
    }
  }
  return out;
}

// 返回缺口左上角 x（拖拽距离 = 缺口 x - 2）
function solveOffset(origPng, jigsawPng) {
  const band = jigsawPng && jigsawPng.length ? bandFromJigsaw(jigsawPng) : null;
  let blocks = whiteBlocks(origPng, 225);
  if (!blocks.length) blocks = whiteBlocks(origPng, 200);
  if (!blocks.length) throw new Error('滑块图未识别到缺口');

  let best = null;
  if (band) {
    // 用 jigsaw 的纵向范围挑「纵坐标对得上」的块
    const scored = blocks.map((b) => ({
      b,
      overlap: Math.min(b.maxY, band.y1) - Math.max(b.minY, band.y0) + 1,
      dh: Math.abs(b.minY - band.y0)
    }));
    scored.sort((a, b) => (b.overlap - a.overlap) || (a.dh - b.dh));
    const need = Math.min(band.y1 - band.y0 + 1, 20) * 0.5;
    if (scored[0].overlap >= need) best = scored[0].b;
  }
  if (!best) best = blocks.slice().sort((a, b) => b.n - a.n)[0];
  return Math.max(0, best.minX - 2);
}

const b64 = (b) => Buffer.from(b).toString('base64');

function aesEcbBase64(key, plain) {
  const c = crypto.createCipheriv('aes-128-ecb', Buffer.from(key, 'utf8'), null);
  return b64(Buffer.concat([c.update(plain, 'utf8'), c.final()]));
}

// ---------- 滑块 ----------
async function solveCaptcha(log = () => {}) {
  for (let i = 0; i < 6; i++) {
    const r = await postJson('/upms/public/captcha/get', { captchaType: 'blockPuzzle' });
    const d = r && r.repData;
    if (!d || !d.originalImageBase64) throw new Error('验证码图获取失败');
    const jigsaw = d.jigsawImageBase64 ? Buffer.from(d.jigsawImageBase64, 'base64') : null;
    const x = solveOffset(Buffer.from(d.originalImageBase64, 'base64'), jigsaw);
    const pointJson = JSON.stringify({ x, y: 5 });
    const check = await postJson('/upms/public/captcha/check', {
      captchaType: 'blockPuzzle',
      pointJson: aesEcbBase64(d.secretKey, pointJson),
      token: d.token
    });
    if (check && check.repCode === '0000') {
      log(`[登录] 滑块已自动通过（x=${x}，第 ${i + 1} 次）`);
      return { captchaVerification: aesEcbBase64(d.secretKey, `${d.token}---${pointJson}`) };
    }
    log(`[登录] 滑块校验未通过（x=${x}），换一张重试（第 ${i + 1} 次）`, 'warning');
    await sleep(300);
  }
  throw new Error('滑块连续 6 次未通过');
}

// ---------- 账号密码登录 ----------
async function loginByPassword(account, password, opts = {}) {
  const log = opts.log || (() => {});
  if (!account || !password) throw new Error('账号或密码为空');

  const keyRes = await req(`${API}/upms/public/auth/getRsaPublicKey`, { method: 'GET' }).then((r) => r.json());
  if (!keyRes || keyRes.code !== '10980001') throw new Error(`获取公钥失败: ${keyRes && keyRes.message}`);
  const { publicKey, keyId } = keyRes.data;

  const pub = crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });

  // 服务端会用 loginName 重建 AAD，且命名是大小写不敏感的规范形式（字母统一小写）。
  // 传了含大写字母的账号名，GCM 校验通不过，服务端只会回 10980003「密码解密失败」。
  // 所以：先按原样试，遇到 10980003 再换全小写重试一次（重试要重新过滑块，token 一次性）。
  async function attempt(loginName) {
    const captcha = await solveCaptcha(log);
    const aesKey = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const timestamp = Date.now();
    const requestId = crypto.randomUUID();
    const aad = `loginName=${loginName}&keyId=${keyId}&timestamp=${timestamp}&requestId=${requestId}&clientId=${CLIENT_ID}`;

    const gcm = crypto.createCipheriv('aes-128-gcm', aesKey, iv);
    gcm.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([gcm.update(password, 'utf8'), gcm.final()]);
    const tag = gcm.getAuthTag();

    const encryptedKeyIv = crypto.publicEncrypt(
      { key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.concat([aesKey, iv])
    );

    const body = {
      loginName,
      keyId,
      timestamp,
      requestId,
      redirectUri: REDIRECT,
      clientId: CLIENT_ID,
      encryptedKeyIv: b64(encryptedKeyIv),
      ciphertext: b64(ct),
      tag: b64(tag),
      invitationCode: '',
      captchaCheckResult: captcha,
      publicKey
    };

    return postJson('/upms/public/auth/accountNameLogin', body);
  }

  const raw = String(account).trim();
  const names = [...new Set([raw, raw.toLowerCase()])];
  let login = null;
  let usedName = raw;

  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    login = await attempt(name);
    if (login && login.code === '10980001') { usedName = name; break; }
    if (name !== raw) break;
    // 只有「密码解密失败」才值得换写法重试；其它错误（密码错、账号不存在）换了也没用
    if (!login || login.code !== '10980003' || names.length < 2) break;
    log(`[登录] 账号名含大写，服务端解密失败，改用全小写「${names[1]}」重试`, 'warning');
  }

  if (!login || login.code !== '10980001') {
    const code = login && login.code;
    let msg = (login && login.message) || '登录失败';
    if (code === '10980003') {
      msg = `账号名无法识别（服务器解密失败，常见于后缀字母大小写不对）：${msg}`;
    } else if (code === '10980039') {
      msg = `账号名能识别，但密码不对：${msg}`;
    }
    const err = new Error(msg);
    err.code = code;
    throw err;
  }

  const data = login.data || {};
  log(`[登录] 密码校验通过，账号 ${usedName}`);

  // 用 code 换 operationToken
  const cbRes = await req(data.redirectUri || REDIRECT, { method: 'GET', redirect: 'manual' });
  const cookies = typeof cbRes.headers.getSetCookie === 'function' ? cbRes.headers.getSetCookie() : [];
  const jar = {};
  for (const c of cookies) {
    const nv = c.split(';')[0];
    const i = nv.indexOf('=');
    if (i > 0) jar[nv.slice(0, i)] = nv.slice(i + 1);
  }
  if (!jar.operationToken) throw new Error('回跳未拿到 operationToken（登录态异常）');

  const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  let exp = data.expiresAt ? Number(data.expiresAt) * 1000 : 0;
  if (!exp) {
    try {
      const p = JSON.parse(Buffer.from(jar.operationToken.split('.')[1], 'base64').toString('utf8'));
      exp = p.exp ? p.exp * 1000 : 0;
    } catch (e) { /* ignore */ }
  }
  log(`[登录] 已换取 operationToken，有效期至 ${exp ? new Date(exp).toISOString().slice(0, 10) : '未知'}`, 'success');
  return { cookie, refreshToken: data.refreshToken || '', expiresAt: exp, loginName: usedName };
}

// ---------- 本地密码加密存储（AES-256-GCM，密钥在本机 data/.secret） ----------
function loadSecret(dataDir) {
  const fs = require('fs');
  const path = require('path');
  const f = path.join(dataDir, '.secret');
  try {
    return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
  } catch (e) {
    const k = crypto.randomBytes(32);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(f, k.toString('hex'), { mode: 0o600 });
    return k;
  }
}

function encryptPassword(dataDir, plain) {
  if (!plain) return '';
  const key = loadSecret(dataDir);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', b64(iv), b64(ct), b64(c.getAuthTag())].join(':');
}

function decryptPassword(dataDir, blob) {
  if (!blob) return '';
  const [ver, ivB, ctB, tagB] = String(blob).split(':');
  if (ver !== 'v1') return '';
  const key = loadSecret(dataDir);
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64'));
  d.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ctB, 'base64')), d.final()]).toString('utf8');
}

module.exports = { loginByPassword, solveCaptcha, solveOffset, bandFromJigsaw, encryptPassword, decryptPassword, decodePng };
