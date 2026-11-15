#!/usr/bin/env bash
# ============================================================
# TeleAgent 保活 · 多账号版 一键部署（在 WSL 里以 root 运行）
# ------------------------------------------------------------
# 用法：
#   bash deploy.sh                          # 从当前目录部署
#   bash deploy.sh /path/to/teleagent-multi # 从指定源码目录部署
#
# 做的事：
#   1. 把源码同步到 /opt/teleagent/teleagent-multi
#   2. 第一次部署时，把旧版单账号的 data（config.json / .secret / logs）搬过来
#   3. 停掉旧容器（保留，方便回滚），构建并启动新容器
#   4. 等健康检查通过，打印面板地址
# ============================================================
set -uo pipefail

SRC="${1:-$(cd "$(dirname "$0")" && pwd)}"
APP=/opt/teleagent/teleagent-multi
OLD=/opt/teleagent/teleagent-keepalive
PORT=8580
STAMP=$(date +%Y%m%d-%H%M%S)

say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
ok()  { printf '\033[1;32m[ok]\033[0m %s\n' "$*"; }
bad() { printf '\033[1;31m[!!]\033[0m %s\n' "$*"; }

command -v docker >/dev/null 2>&1 || { bad "docker 不在 PATH，先跑 ensure-stack.sh"; exit 1; }
docker info >/dev/null 2>&1 || { bad "dockerd 没起来，先跑 ensure-stack.sh"; exit 1; }

say "1) 同步源码 → $APP"
if [ ! -f "$SRC/src/index.js" ]; then bad "源码目录不对：$SRC 里没有 src/index.js"; exit 1; fi
mkdir -p "$APP"
SRC_REAL=$(readlink -f "$SRC" 2>/dev/null || echo "$SRC")
APP_REAL=$(readlink -f "$APP" 2>/dev/null || echo "$APP")
if [ "$SRC_REAL" = "$APP_REAL" ]; then
  ok "源码已在 $APP，跳过同步"
elif command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --exclude data --exclude node_modules --exclude test-data \
        --exclude 'test-*' --exclude '*.log' "$SRC"/ "$APP"/
else
  for item in src public package.json Dockerfile docker-compose.yml README.md; do
    [ -e "$SRC/$item" ] && cp -r "$SRC/$item" "$APP"/
  done
fi
ok "源码已就位"

say "2) 数据目录"
if [ -f "$APP/data/config.json" ]; then
  cp "$APP/data/config.json" "$APP/data/config.json.bak.$STAMP"
  ok "已有 data/config.json，先备份为 config.json.bak.$STAMP"
else
  mkdir -p "$APP/data"
  if [ -f "$OLD/data/config.json" ]; then
    # 只搬配置与密钥，日志不搬（避免旧日志混进新控制台）
    cp "$OLD/data/config.json" "$APP/data/config.json"
    [ -f "$OLD/data/.secret" ] && cp "$OLD/data/.secret" "$APP/data/.secret"
    ok "已从旧版 $OLD/data 迁移 config.json 与 .secret（首次启动会自动转成多账号结构）"
  else
    ok "没有旧数据，按全新部署"
  fi
fi
mkdir -p "$APP/data/logs"

say "3) 停旧容器（保留镜像与数据，可回滚）"
if docker ps -a --format '{{.Names}}' | grep -qx teleagent-keepalive; then
  docker update --restart=no teleagent-keepalive >/dev/null 2>&1 || true
  docker stop teleagent-keepalive >/dev/null 2>&1 || true
  ok "旧容器 teleagent-keepalive 已停止（rollback.sh 可拉回）"
else
  ok "没有旧容器"
fi

say "4) 构建并启动"
cd "$APP" || exit 1
if ! docker compose version >/dev/null 2>&1; then bad "docker compose 不可用"; exit 1; fi

# 网络重建后 DNAT 会失效，先 down 再 up
docker compose down --remove-orphans >/dev/null 2>&1 || true
if ! docker compose up -d --build; then
  bad "构建/启动失败，看上面的报错"
  exit 1
fi

say "5) 等健康检查"
for i in $(seq 1 40); do
  sleep 2
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "http://127.0.0.1:$PORT/api/state" || echo 000)
  if [ "$code" = "200" ]; then
    ok "面板已就绪（HTTP 200，等了 $((i*2)) 秒）"
    break
  fi
  if [ "$i" = "40" ]; then
    bad "等了 80 秒还是 $code，打印最近日志："
    docker logs --tail 40 teleagent-multi 2>&1
    exit 1
  fi
done

say "6) 当前账号"
curl -s --max-time 6 "http://127.0.0.1:$PORT/api/state" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const d=JSON.parse(s).data;(d.accounts||[]).forEach(a=>console.log(' - '+a.name+' | '+a.phase+' | enabled='+a.enabled+' | '+(a.authMode==='cookie'?'Cookie':'账号密码')+' | cookie剩'+(a.cookieDaysLeft==null?'—':a.cookieDaysLeft+'天')));}catch(e){console.log(s.slice(0,300))}})" \
  2>/dev/null || true

cat <<EOF

============================================================
部署完成
  面板      http://localhost:$PORT
  容器      teleagent-multi
  数据      $APP/data/config.json
  回滚      bash /opt/teleagent/teleagent-multi/rollback.sh
============================================================
EOF
