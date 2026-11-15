#!/usr/bin/env bash
# 卸载 TeleAgent 保活（保留 data 目录，想彻底删加 --purge）
set -uo pipefail
APP=/opt/teleagent/teleagent-multi
SVC=teleagent-multi
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

[ "$(id -u)" = "0" ] || { echo "请用 root 执行"; exit 1; }

if systemctl list-unit-files 2>/dev/null | grep -q "^$SVC.service"; then
  systemctl stop "$SVC" 2>/dev/null
  systemctl disable "$SVC" 2>/dev/null
  rm -f "/etc/systemd/system/$SVC.service"
  systemctl daemon-reload
  echo "[ok] systemd 服务已移除"
fi

if command -v docker >/dev/null 2>&1 && docker ps -a --format '{{.Names}}' | grep -qx "$SVC"; then
  docker rm -f "$SVC" >/dev/null 2>&1 && echo "[ok] 容器已删除"
fi

if [ "$PURGE" = "1" ]; then
  rm -rf "$APP"
  id teleagent >/dev/null 2>&1 && userdel teleagent 2>/dev/null
  echo "[ok] 程序与数据已彻底删除"
else
  echo "[ok] 程序保留在 $APP（数据未动）。彻底删除：bash $0 --purge"
fi
