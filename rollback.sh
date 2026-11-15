#!/usr/bin/env bash
# 回滚到旧版单账号容器：停新版、起旧版
set -uo pipefail
PORT=8580

echo "== 停掉多账号容器 =="
docker update --restart=no teleagent-multi >/dev/null 2>&1 || true
docker stop teleagent-multi >/dev/null 2>&1 || true

echo "== 拉起旧版单账号容器 =="
if docker ps -a --format '{{.Names}}' | grep -qx teleagent-keepalive; then
  docker update --restart=unless-stopped teleagent-keepalive >/dev/null 2>&1 || true
  docker start teleagent-keepalive
  for i in $(seq 1 20); do
    sleep 2
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "http://127.0.0.1:$PORT/api/status" || echo 000)
    if [ "$code" = "200" ]; then echo "[ok] 旧版已恢复（HTTP 200）"; exit 0; fi
  done
  echo "[!!] 旧版起来了但探测不到 $PORT，看 docker logs teleagent-keepalive"
  exit 1
fi

echo "[!!] 找不到旧容器 teleagent-keepalive，无法回滚"
exit 1
