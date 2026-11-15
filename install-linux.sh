#!/usr/bin/env bash
# ============================================================
# TeleAgent 保活 · 多账号版  ·  Linux 一键部署
# ------------------------------------------------------------
# 用法（root 执行）：
#   bash install-linux.sh                    # systemd 原生部署（默认，不需要 Docker）
#   bash install-linux.sh --docker           # 用 Docker Compose 部署
#   bash install-linux.sh --port 8590        # 换端口
#   bash install-linux.sh --password 'xxx'   # 给面板加访问密码（公网机器强烈建议）
#
# 目录约定：
#   /opt/teleagent/teleagent-multi          程序
#   /opt/teleagent/teleagent-multi/data     数据（config.json / .secret / logs）
#   /etc/systemd/system/teleagent-multi.service
# ============================================================
set -uo pipefail

APP=/opt/teleagent/teleagent-multi
SVC=teleagent-multi
PORT=8580
PASSWORD=""
USE_DOCKER=0
NPM_REG=https://registry.npmmirror.com
NODE_VER=v20.19.0

while [ $# -gt 0 ]; do
  case "$1" in
    --docker) USE_DOCKER=1; shift ;;
    --port) PORT="$2"; shift 2 ;;
    --password) PASSWORD="$2"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "未知参数：$1"; exit 1 ;;
  esac
done

say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
ok()  { printf '\033[1;32m[ok]\033[0m %s\n' "$*"; }
bad() { printf '\033[1;31m[!!]\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;33m[!]\033[0m %s\n' "$*"; }

# 探测面板是否起来：优先 curl，没有就用 node（最小化系统常常没 curl）
probe() {
  if command -v curl >/dev/null 2>&1; then
    curl -s -o /dev/null -w '%{http_code}' --max-time 4 "http://127.0.0.1:$PORT/api/state" 2>/dev/null || echo 000
  elif command -v node >/dev/null 2>&1; then
    node -e "fetch('http://127.0.0.1:$PORT/api/state').then(r=>process.stdout.write(String(r.status))).catch(()=>process.stdout.write('000'))" 2>/dev/null || echo 000
  else
    echo 000
  fi
}

[ "$(id -u)" = "0" ] || { bad "请用 root 执行：sudo bash $0"; exit 1; }

SRC="$(cd "$(dirname "$0")" && pwd)/teleagent-multi"
if [ ! -f "$SRC/src/index.js" ]; then
  # 也支持脚本就放在源码目录里的情况
  if [ -f "$(dirname "$0")/src/index.js" ]; then SRC="$(cd "$(dirname "$0")" && pwd)"; else
    bad "找不到源码：$SRC/src/index.js。请把 install-linux.sh 和 teleagent-multi/ 放在同一目录"; exit 1
  fi
fi
ok "源码目录 $SRC"

# ------------------------------------------------------------
# 1) 同步程序文件（保留 data）
# ------------------------------------------------------------
say "1) 安装程序到 $APP"
mkdir -p "$APP"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --exclude data --exclude node_modules "$SRC"/ "$APP"/
else
  for item in src public package.json deploy.sh rollback.sh README.md; do
    [ -e "$SRC/$item" ] && cp -r "$SRC/$item" "$APP"/
  done
fi
mkdir -p "$APP/data/logs"
ok "程序文件就位"

# ------------------------------------------------------------
# 2) 迁移旧数据（如果这台机器以前跑过单账号版）
# ------------------------------------------------------------
say "2) 数据目录"
if [ -f "$APP/data/config.json" ]; then
  ok "已有 $APP/data/config.json，沿用（不会覆盖）"
else
  found=""
  for old in /opt/teleagent/teleagent-keepalive/data /opt/teleagent/data /root/teleagent-keepalive/data; do
    if [ -f "$old/config.json" ]; then found="$old"; break; fi
  done
  if [ -n "$found" ]; then
    cp "$found/config.json" "$APP/data/config.json"
    [ -f "$found/.secret" ] && cp "$found/.secret" "$APP/data/.secret"
    ok "已从 $found 迁移 config.json 与 .secret（首启动会自动转多账号结构）"
  else
    ok "没有旧数据，全新部署"
  fi
fi

# ------------------------------------------------------------
# 3) Docker 分支
# ------------------------------------------------------------
if [ "$USE_DOCKER" = "1" ]; then
  say "3) Docker Compose 部署"
  command -v docker >/dev/null 2>&1 || { bad "没装 docker，先装或用默认 systemd 方式"; exit 1; }
  docker info >/dev/null 2>&1 || { bad "docker 守护进程没起来：systemctl start docker"; exit 1; }
  if [ "$PORT" != "8580" ]; then
    bad "Docker 方式端口固定 8580（compose 里写死了）。要换端口请改 docker-compose.yml 的 ports，或改用默认 systemd 方式"
    exit 1
  fi
  cd "$APP" || exit 1
  if [ -n "$PASSWORD" ]; then
    cat > "$APP/docker-compose.override.yml" <<EOF
services:
  teleagent-multi:
    environment:
      WEB_PASSWORD: "$PASSWORD"
EOF
    ok "已生成 docker-compose.override.yml（面板密码生效）"
  fi
  docker compose down --remove-orphans >/dev/null 2>&1 || true
  docker compose up -d --build || { bad "构建失败"; exit 1; }
  say "等待健康检查"
  for i in $(seq 1 40); do
    sleep 2
    code=$(probe)
    [ "$code" = "200" ] && { ok "面板已就绪（HTTP 200）"; break; }
    [ "$i" = "40" ] && { bad "80 秒仍未就绪，日志："; docker logs --tail 40 "$SVC" 2>&1; exit 1; }
  done
  echo; echo "面板：http://<这台机器的IP>:$PORT"
  exit 0
fi

# ------------------------------------------------------------
# 4) 原生分支：装 Node
# ------------------------------------------------------------
say "3) 检查 Node.js"
need_install=1
if command -v node >/dev/null 2>&1; then
  cur=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "${cur:-0}" -ge 18 ]; then
    ok "已装 Node $(node -v)"; need_install=0
  else
    warn "Node $(node -v) 太旧（要 >= 18），装新版"
  fi
fi
if [ "$need_install" = "1" ]; then
  arch=$(uname -m); case "$arch" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; esac
  GLIBC=$(ldd --version 2>/dev/null | awk 'NR==1{print $NF}')
  if [ -n "$GLIBC" ] && ! awk -v v="$GLIBC" 'BEGIN{split(v,a,".");exit !(a[1]>2||(a[1]==2&&a[2]>=28))}'; then
    bad "glibc $GLIBC 太旧（要 >= 2.28，CentOS 7 就是 2.17），Node 20 跑不起来"
    bad "这台机器建议改用 Docker：bash $0 --docker"
    exit 1
  fi
  url="https://npmmirror.com/mirrors/node/$NODE_VER/node-$NODE_VER-linux-$arch.tar.xz"
  tmp=/tmp/node-$NODE_VER.tar.xz
  echo "下载 $url"
  if command -v curl >/dev/null 2>&1; then curl -fL --retry 3 -o "$tmp" "$url"; else wget -O "$tmp" "$url"; fi
  [ -s "$tmp" ] || { bad "Node 下载失败，请手动装 Node 18+ 后重跑"; exit 1; }
  mkdir -p /usr/local/lib/nodejs
  tar -xJf "$tmp" -C /usr/local/lib/nodejs || { bad "解压失败（缺 xz？apt install -y xz-utils）"; exit 1; }
  ln -sf "/usr/local/lib/nodejs/node-$NODE_VER-linux-$arch/bin/node" /usr/local/bin/node
  ln -sf "/usr/local/lib/nodejs/node-$NODE_VER-linux-$arch/bin/npm"  /usr/local/bin/npm
  ln -sf "/usr/local/lib/nodejs/node-$NODE_VER-linux-$arch/bin/npx"  /usr/local/bin/npx
  ok "Node $(node -v) 已装到 /usr/local/bin/node"
fi
NODE_BIN=$(command -v node)

say "4) 安装依赖"
cd "$APP" || exit 1
npm install --omit=dev --registry="$NPM_REG" --no-audit --no-fund 2>&1 | tail -3
[ -d "$APP/node_modules/ws" ] || { bad "依赖安装失败（ws 缺失）"; exit 1; }
ok "依赖就绪"

# ------------------------------------------------------------
# 5) 运行用户
# ------------------------------------------------------------
say "5) 运行用户"
if id teleagent >/dev/null 2>&1; then
  ok "用户 teleagent 已存在"
else
  useradd --system --home "$APP" --shell /usr/sbin/nologin teleagent 2>/dev/null \
    || useradd --system --home "$APP" --shell /sbin/nologin teleagent
  ok "已创建系统用户 teleagent"
fi
chown -R teleagent:teleagent "$APP"

# ------------------------------------------------------------
# 6) systemd
# ------------------------------------------------------------
say "6) 注册 systemd 服务"
ENV_PASSWORD=""
if [ -n "$PASSWORD" ]; then
  ENV_PASSWORD="Environment=WEB_PASSWORD=$PASSWORD"
fi

cat > "/etc/systemd/system/$SVC.service" <<EOF
[Unit]
Description=TeleAgent Keepalive (multi-account)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=teleagent
Group=teleagent
WorkingDirectory=$APP
Environment=NODE_ENV=production
Environment=TZ=Asia/Shanghai
Environment=PORT=$PORT
Environment=DATA_DIR=$APP/data
Environment=NODE_OPTIONS=--dns-result-order=ipv4first
$ENV_PASSWORD
ExecStart=$NODE_BIN src/index.js
Restart=always
RestartSec=5
LimitNOFILE=65535
StandardOutput=append:$APP/data/stdout.log
StandardError=append:$APP/data/stderr.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SVC" >/dev/null 2>&1
systemctl restart "$SVC"
ok "服务已注册并启动"

# ------------------------------------------------------------
# 7) 健康检查
# ------------------------------------------------------------
say "7) 等待启动"
for i in $(seq 1 30); do
  sleep 2
  code=$(probe)
  [ "$code" = "200" ] && { ok "面板已就绪（HTTP 200，等了 $((i*2)) 秒）"; break; }
  if [ "$i" = "30" ]; then
    bad "60 秒仍未就绪，最近日志："
    journalctl -u "$SVC" -n 40 --no-pager 2>/dev/null || tail -40 "$APP/data/stderr.log"
    exit 1
  fi
done

say "8) 当前账号"
"$NODE_BIN" -e "
fetch('http://127.0.0.1:$PORT/api/state').then(r=>r.json()).then(j=>{
  const list=(j.data&&j.data.accounts)||[];
  if(!list.length){ console.log('  （还没有账号，打开面板点「+ 新增账号」）'); return; }
  list.forEach(a=>console.log('  - '+a.name+' | '+a.phase+' | enabled='+a.enabled+' | '+a.mode+' | cookie 剩 '+(a.cookieDaysLeft==null?'—':a.cookieDaysLeft+' 天')));
}).catch(e=>console.log('  读取账号失败：'+e.message));
" 2>/dev/null

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
cat <<EOF

============================================================
部署完成
  面板      http://${IP:-<这台机器的IP>}:$PORT
  服务      systemctl status $SVC
  日志      journalctl -u $SVC -f      （或 tail -f $APP/data/stdout.log）
  数据      $APP/data/config.json
  重启      systemctl restart $SVC
  卸载      bash $APP/uninstall-linux.sh
============================================================
EOF
[ -z "$PASSWORD" ] && warn "面板没有设密码，公网机器建议加：bash $0 --password '改我'（会重建服务配置）"
[ -z "$PASSWORD" ] && warn "云服务器还要放行安全组/防火墙的 $PORT 端口"
exit 0
