#!/usr/bin/env bash
# ============================================================
# TeleAgent 保活 · 多账号版  ·  Linux Docker 一键部署
# ------------------------------------------------------------
# 用法（root 执行）：
#   bash docker.sh                          # 装 Docker（如缺）+ 构建 + 起容器
#   bash docker.sh --password 'your-pass'   # 同时给面板加 Basic 认证
#   bash docker.sh --port 8590              # 换宿主机端口
#   bash docker.sh --no-install-docker      # 已装好 Docker，只部署
#   bash docker.sh --no-compose             # 不用 compose，纯 docker build+run
#
# 说明：compose 可有可无。没装 compose 时脚本自动改用 docker build + docker run，
#       部署结果完全一样（同样 restart、端口、数据卷、密码）。
#
# 产物：
#   /opt/teleagent/teleagent-multi/            程序 + .env
#   /opt/teleagent/teleagent-multi/data/       数据（配置 / 密钥 / 日志）
#   容器 teleagent-multi，镜像 teleagent-multi:latest
# ============================================================
set -uo pipefail

APP=/opt/teleagent/teleagent-multi
NAME=teleagent-multi
PORT=8580
PASSWORD=""
WEBUSER="admin"
INSTALL_DOCKER=1
USE_COMPOSE=1

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --password) PASSWORD="$2"; shift 2 ;;
    --user) WEBUSER="$2"; shift 2 ;;
    --no-install-docker) INSTALL_DOCKER=0; shift ;;
    --no-compose) USE_COMPOSE=0; shift ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "未知参数：$1"; exit 1 ;;
  esac
done

printf '\033[1;36mTeleAgent 多账号 · Docker 部署脚本 %s\033[0m\n' "$VERSION"

VERSION="2026-11-14-v3"

say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
ok()  { printf '\033[1;32m[ok]\033[0m %s\n' "$*"; }
bad() { printf '\033[1;31m[!!]\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;33m[!]\033[0m %s\n' "$*"; }

[ "$(id -u)" = "0" ] || { bad "请用 root 执行：sudo bash $0"; exit 1; }

# 源码目录：脚本同级有 teleagent-multi/ 就用它，否则脚本自己就在源码目录里
BASE="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$BASE/teleagent-multi/src/index.js" ]; then
  SRC="$BASE/teleagent-multi"
elif [ -f "$BASE/src/index.js" ]; then
  SRC="$BASE"
else
  bad "找不到源码（$BASE 下既没有 teleagent-multi/src/index.js 也没有 src/index.js）"; exit 1
fi
ok "源码目录 $SRC"

probe() {
  if command -v curl >/dev/null 2>&1; then
    curl -s -o /dev/null -w '%{http_code}' --max-time 4 "http://127.0.0.1:$PORT/api/state" 2>/dev/null || echo 000
  else
    echo 000
  fi
}

# ------------------------------------------------------------
# 1) Docker
# ------------------------------------------------------------
say "1) 检查 Docker"
if ! command -v docker >/dev/null 2>&1; then
  if [ "$INSTALL_DOCKER" != "1" ]; then bad "没装 docker，去掉 --no-install-docker 或手动装"; exit 1; fi
  warn "没有 docker，开始安装（apt/dnf/yum 或官方脚本）"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq || true
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl gnupg >/dev/null 2>&1 || true
  fi
  # 官方脚本 + 阿里云镜像（国内快很多）
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh || { bad "下载 get.docker.sh 失败"; exit 1; }
  else
    wget -O /tmp/get-docker.sh https://get.docker.com || { bad "下载失败"; exit 1; }
  fi
  sh /tmp/get-docker.sh --mirror Aliyun || { bad "Docker 安装失败"; exit 1; }
  systemctl enable --now docker >/dev/null 2>&1 || true
  ok "Docker $(docker -v 2>/dev/null | cut -d, -f1)"
else
  ok "已有 $(docker -v 2>/dev/null | cut -d, -f1)"
fi

if ! systemctl is-active --quiet docker 2>/dev/null; then
  systemctl start docker 2>/dev/null || true
fi
docker info >/dev/null 2>&1 || { bad "docker 守护进程没起来：systemctl start docker 后重跑"; exit 1; }

# ------------------------------------------------------------
# compose 只是可选加速器：有就用，没有就走纯 docker（效果完全一样）
# ------------------------------------------------------------
COMPOSE=""
if [ "$USE_COMPOSE" = "0" ]; then
  warn "按参数跳过 compose，直接走纯 docker（build + run）"
elif docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
  ok "docker compose 可用（$(docker compose version --short 2>/dev/null || echo v2)）"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
  warn "只有 v1 的 docker-compose，用它代跑"
else
  warn "本机没有 docker compose —— 不影响部署，自动改用纯 docker（build + run）"
fi

# 镜像加速（国内构建/拉基础镜像容易超时）
if [ ! -f /etc/docker/daemon.json ]; then
  cat > /etc/docker/daemon.json <<'EOF'
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://docker.1ms.run",
    "https://docker.xuanyuan.me"
  ],
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "3" }
}
EOF
  systemctl restart docker >/dev/null 2>&1 || true
  ok "已写入 /etc/docker/daemon.json（镜像加速）"
elif grep -q 'registry-mirrors' /etc/docker/daemon.json; then
  ok "已有镜像加速配置，保持不动"
else
  cp /etc/docker/daemon.json "/etc/docker/daemon.json.bak.$(date +%s)"
  warn "已有 daemon.json 但没配镜像加速，已备份。需要的话手动加："
  warn '  "registry-mirrors": ["https://docker.m.daocloud.io","https://docker.1ms.run"]'
fi

# ------------------------------------------------------------
# 2) 程序与数据
# ------------------------------------------------------------
say "2) 安装程序到 $APP"
mkdir -p "$APP"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --exclude data --exclude node_modules "$SRC"/ "$APP"/
else
  for item in src public package.json Dockerfile docker-compose.yml README.md; do
    [ -e "$SRC/$item" ] && cp -r "$SRC/$item" "$APP"/
  done
fi
mkdir -p "$APP/data/logs"
ok "程序文件就位"

if [ -f "$APP/data/config.json" ]; then
  ok "沿用已有 $APP/data/config.json"
else
  found=""
  for old in /opt/teleagent/teleagent-keepalive/data /opt/teleagent/data /root/teleagent-keepalive/data; do
    [ -f "$old/config.json" ] && { found="$old"; break; }
  done
  if [ -n "$found" ]; then
    cp "$found/config.json" "$APP/data/config.json"
    [ -f "$found/.secret" ] && cp "$found/.secret" "$APP/data/.secret"
    ok "已从 $found 迁移配置与密钥（首次启动自动转多账号结构）"
  else
    ok "没有旧数据，全新部署"
  fi
fi
# 容器内以 root 跑，数据目录给足权限
chmod -R u+rwX,go+rX "$APP/data" 2>/dev/null || true

# ------------------------------------------------------------
# 3) .env
# ------------------------------------------------------------
say "3) 生成 .env"
{
  echo "PANEL_PORT=$PORT"
  echo "WEB_PASSWORD=$PASSWORD"
  echo "WEB_USER=$WEBUSER"
} > "$APP/.env"
chmod 600 "$APP/.env"
ok ".env 已写入（PANEL_PORT=$PORT，面板密码${PASSWORD:+已设置}${PASSWORD:-未设置}）"

# ------------------------------------------------------------
# 4) 构建并启动
# ------------------------------------------------------------
say "4) 构建镜像并启动容器"
cd "$APP" || exit 1

MIRROR_IMAGE=docker.m.daocloud.io/library/node:22-alpine

if [ -n "$COMPOSE" ]; then
  $COMPOSE down --remove-orphans >/dev/null 2>&1 || true
  if ! $COMPOSE up -d --build; then
    warn "第一次构建失败，改用国内镜像重试"
    docker pull "$MIRROR_IMAGE" >/dev/null 2>&1 && docker tag "$MIRROR_IMAGE" node:22-alpine || true
    if ! $COMPOSE up -d --build; then
      bad "构建/启动仍失败，把上面的报错发我"
      exit 1
    fi
  fi
else
  # 没有 compose 也能跑：build + run（效果与 compose 完全一致）
  warn "走纯 docker 部署（build + run，不依赖 compose）"
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  if ! docker build -t "$NAME:latest" .; then
    warn "第一次构建失败，改用国内镜像重试"
    if docker pull "$MIRROR_IMAGE" >/dev/null 2>&1; then
      docker tag "$MIRROR_IMAGE" node:22-alpine
      docker build -t "$NAME:latest" . || { bad "镜像构建仍失败"; exit 1; }
    else
      bad "拉基础镜像失败（node:22-alpine）。手动执行后重跑："
      bad "  docker pull $MIRROR_IMAGE"
      bad "  docker tag  $MIRROR_IMAGE node:22-alpine"
      exit 1
    fi
  fi
  if ! docker run -d --name "$NAME" \
      --restart unless-stopped \
      --log-driver json-file --log-opt max-size=20m --log-opt max-file=3 \
      -p "$PORT:8580" \
      -e TZ=Asia/Shanghai -e PORT=8580 -e DATA_DIR=/app/data \
      -e LOG_MAX=300 -e LOG_FILE_MAX_MB=5 \
      -e NODE_OPTIONS=--dns-result-order=ipv4first \
      -e WEB_PASSWORD="$PASSWORD" -e WEB_USER="$WEBUSER" \
      -v "$APP/data:/app/data" \
      "$NAME:latest"; then
    bad "容器启动失败，看：docker logs $NAME"; exit 1
  fi
  warn "以后想要 compose 的 up/down 便利，可装插件："
  warn "  mkdir -p /usr/local/lib/docker/cli-plugins && curl -fL https://ghfast.top/https://github.com/docker/compose/releases/latest/download/docker-compose-linux-\$(uname -m) -o /usr/local/lib/docker/cli-plugins/docker-compose && chmod +x /usr/local/lib/docker/cli-plugins/docker-compose"
fi
ok "容器已启动"

# ------------------------------------------------------------
# 5) 健康检查
# ------------------------------------------------------------
say "5) 等待健康检查"
for i in $(seq 1 45); do
  sleep 2
  code=$(probe)
  if [ "$code" = "200" ]; then ok "面板已就绪（HTTP 200，等了 $((i*2)) 秒）"; break; fi
  if [ "$i" = "45" ]; then
    bad "90 秒仍未就绪（$code），最近日志："
    docker logs --tail 40 "$NAME" 2>&1
    exit 1
  fi
done

say "6) 运行状态"
docker ps --filter "name=$NAME" --format '  容器 {{.Names}} | {{.Status}} | {{.Ports}}'
echo
docker exec "$NAME" node -e "
fetch('http://127.0.0.1:8580/api/state').then(r=>r.json()).then(j=>{
  const list=(j.data&&j.data.accounts)||[];
  if(!list.length){ console.log('  （还没有账号，打开面板点「+ 新增账号」）'); return; }
  list.forEach(a=>console.log('  - '+a.name+' | '+a.phase+' | enabled='+a.enabled+' | '+a.mode+' | cookie 剩 '+(a.cookieDaysLeft==null?'—':a.cookieDaysLeft+' 天')));
}).catch(e=>console.log('  读取账号失败：'+e.message));
" 2>/dev/null

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
if [ -n "$COMPOSE" ]; then
  RUN_HINT="  $COMPOSE up -d --build      # 更新代码后重建"
  STOP_HINT="  $COMPOSE down               # 停（数据不动）"
else
  RUN_HINT="  docker build -t $NAME:latest $APP && docker rm -f $NAME && docker run -d ...（重跑本脚本即可）"
  STOP_HINT="  docker rm -f $NAME          # 停（数据不动）"
fi
cat <<EOF

============================================================
Docker 部署完成（模式：${COMPOSE:-纯 docker}）
  面板      http://${IP:-<这台机器的IP>}:$PORT
  容器      $NAME（restart: unless-stopped，随 docker 自启）
  目录      $APP
  数据      $APP/data/config.json
  配置      $APP/.env（端口 / 面板密码）
------------------------------------------------------------
常用：
  docker logs -f --tail 50 $NAME
  docker restart $NAME
$RUN_HINT
$STOP_HINT
  docker exec $NAME ls /app/data               # 看数据卷
============================================================
EOF
[ -z "$PASSWORD" ] && warn "面板没设密码，公网机器很危险：编辑 $APP/.env 填 WEB_PASSWORD 后重跑本脚本"
[ -z "$PASSWORD" ] && warn "记得在云安全组/防火墙放行 $PORT"
exit 0
