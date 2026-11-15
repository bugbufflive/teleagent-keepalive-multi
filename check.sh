#!/usr/bin/env bash
# ============================================================
# TeleAgent 多账号版 · 部署环境自检（只读，不改任何东西）
# 用法： bash check.sh
# 把全部输出发回来，就能一次定位问题
# ============================================================
PORT="${1:-8580}"

line() { printf '\n---------- %s ----------\n' "$*"; }

echo "=============================="
echo " TeleAgent 环境自检  $(date '+%F %T')"
echo "=============================="

line "1. 系统"
. /etc/os-release 2>/dev/null && echo "OS      : ${PRETTY_NAME:-unknown}"
echo "Kernel  : $(uname -r)"
echo "Arch    : $(uname -m)"
echo "CPU/Mem : $(nproc 2>/dev/null || echo '?') 核 / $(free -m 2>/dev/null | awk '/Mem:/{print $2" MB"}')"
echo "Disk /  : $(df -h / 2>/dev/null | awk 'NR==2{print $4" 可用 / "$2" 总"}')"

line "2. 运行时"
for c in docker docker-compose node npm curl wget systemctl; do
  if command -v "$c" >/dev/null 2>&1; then
    printf '%-15s %s\n' "$c" "$(command -v $c)"
  else
    printf '%-15s %s\n' "$c" "缺失"
  fi
done
command -v docker >/dev/null 2>&1 && echo "docker -v       : $(docker -v 2>&1 | head -1)"
command -v node >/dev/null 2>&1 && echo "node -v         : $(node -v 2>&1)"

line "3. Docker 守护进程"
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    echo "状态      : 正常（$(docker info --format '{{.ServerVersion}} / {{.OperatingSystem}}' 2>/dev/null)）"
    echo "镜像数    : $(docker images -q 2>/dev/null | wc -l)"
    echo "容器数    : $(docker ps -aq 2>/dev/null | wc -l)"
  else
    echo "状态      : 不可用"
    echo "systemctl : $(systemctl is-active docker 2>&1)"
    echo "最近日志  :"
    journalctl -u docker -n 8 --no-pager 2>/dev/null | sed 's/^/    /'
  fi
else
  echo "状态      : 没装 docker"
fi

line "4. compose"
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  echo "docker compose : $(docker compose version --short 2>&1)"
elif command -v docker-compose >/dev/null 2>&1; then
  echo "docker-compose : $(docker-compose version 2>&1 | head -1)"
else
  echo "docker compose : 不可用（不影响，可用纯 docker build+run）"
fi

line "5. 镜像源连通性"
if command -v curl >/dev/null 2>&1; then
  for u in https://registry-1.docker.io/v2/ https://docker.m.daocloud.io/v2/ https://docker.1ms.run/v2/ https://registry.npmmirror.com; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$u" 2>/dev/null)
    printf '%-40s HTTP %s\n' "$u" "${code:-000}"
  done
else
  echo "没有 curl，跳过"
fi

line "6. 本地镜像"
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  docker images --format '  {{.Repository}}:{{.Tag}}  {{.Size}}' 2>/dev/null | head -20
else
  echo "docker 不可用，跳过"
fi

line "7. 容器状态"
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  docker ps -a --filter name=teleagent --format '  {{.Names}} | {{.Status}} | {{.Ports}}' 2>/dev/null
  if docker inspect teleagent-multi >/dev/null 2>&1; then
    echo "  restart策略 : $(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' teleagent-multi 2>/dev/null)"
    echo "  镜像        : $(docker inspect -f '{{.Config.Image}}' teleagent-multi 2>/dev/null)"
    echo "  挂载        : $(docker inspect -f '{{range .Mounts}}{{.Source}}->{{.Destination}} {{end}}' teleagent-multi 2>/dev/null)"
    echo "  最近日志 :"
    docker logs --tail 15 teleagent-multi 2>&1 | sed 's/^/    /'
  else
    echo "  （没有名为 teleagent-multi 的容器）"
  fi
else
  echo "docker 不可用，跳过"
fi

line "8. 端口与面板"
if command -v ss >/dev/null 2>&1; then
  ss -lntp 2>/dev/null | grep -E ":${PORT}\b" | sed 's/^/  /' || echo "  $PORT 没有监听"
elif command -v netstat >/dev/null 2>&1; then
  netstat -lntp 2>/dev/null | grep -E ":${PORT}\b" | sed 's/^/  /' || echo "  $PORT 没有监听"
fi
if command -v curl >/dev/null 2>&1; then
  echo "  http://127.0.0.1:$PORT/api/state -> HTTP $(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/api/state" 2>/dev/null || echo 000)"
fi
command -v systemctl >/dev/null 2>&1 && echo "  systemd 服务 teleagent-multi : $(systemctl is-active teleagent-multi 2>&1)"

line "9. 文件"
for d in /opt/teleagent/teleagent-multi /opt/teleagent/teleagent-keepalive; do
  if [ -d "$d" ]; then
    echo "存在 $d"
    ls -la "$d" 2>/dev/null | head -12 | sed 's/^/    /'
    [ -d "$d/data" ] && echo "    data/: $(ls -A "$d/data" 2>/dev/null | tr '\n' ' ')"
  else
    echo "不存在 $d"
  fi
done

line "10. 目录结构（/opt/teleagent/teleagent-multi）"
[ -f /opt/teleagent/teleagent-multi/src/index.js ] && echo "  src/index.js 存在" || echo "  src/index.js 缺失"
[ -f /opt/teleagent/teleagent-multi/Dockerfile ] && echo "  Dockerfile 存在" || echo "  Dockerfile 缺失"
[ -f /opt/teleagent/teleagent-multi/docker-compose.yml ] && echo "  docker-compose.yml 存在" || echo "  docker-compose.yml 缺失"

echo
echo "=========== 自检结束，把以上全部内容发回来 ==========="
