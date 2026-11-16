# TeleAgent 保活 · 多账号版

一个进程里同时保活多个天翼云电脑实例，互不干扰。控制台在 `http://localhost:8580`。

## 和单账号版的区别

| 项目 | 单账号版 | 多账号版 |
|---|---|---|
| 账号数量 | 1 个 | 不限（每个账号独立循环、独立 WebSocket） |
| 控制台 | 单页配置 | 左侧账号列表 + 右侧详情，一眼看全部状态 |
| 通知 | 全局一个机器人 | 全局默认 + 每账号可单独指定机器人 |
| 配置文件 | `config.json` 平铺 | `config.json` 里 `accounts[]` 数组，旧结构启动时自动迁移 |
| 密码密钥 | `data/.secret` | 同样 `data/.secret`，多账号共用一把钥匙 |

## 目录结构

```
teleagent-multi/
├── src/
│   ├── index.js       入口：起 Web 控制台 + 拉起所有账号
│   ├── store.js       配置读写（v1 → v2 自动迁移）
│   ├── manager.js     多账号调度器
│   ├── teleagent.js   单个账号的保活内核（换票 / claim / 心跳 / 自愈）
│   ├── login.js       账号密码登录 + 滑块识别（已修 bandFromJigsaw）
│   ├── crypto.js      AES-256-GCM 密码加解密
│   ├── notify.js      企业微信机器人推送
│   ├── logger.js      内存环形日志 + 文件轮转
│   └── web.js         HTTP 接口 + 静态页
├── public/            控制台前端（原生 JS，无构建）
├── Dockerfile
├── docker-compose.yml
├── deploy.sh          一键部署（WSL/Docker：构建 + 迁移旧数据 + 起容器）
├── rollback.sh        回滚到旧版单账号容器
├── install-linux.sh   Linux 一键部署（systemd，也可 --docker）
└── uninstall-linux.sh Linux 卸载
```

## 部署（在本机 WSL 里）

```bash
wsl -d Ubuntu2404 -u root -- bash /opt/teleagent/teleagent-multi/deploy.sh
```

脚本会：
1. 把源码同步到 `/opt/teleagent/teleagent-multi`
2. 首次部署时把旧版 `data/config.json`、`data/.secret` 搬过来（日志不搬）
3. 停掉旧容器 `teleagent-keepalive`（不删，便于回滚）
4. `docker compose down && up -d --build`，然后等 `/api/state` 返回 200

旧容器想拉回来：`bash /opt/teleagent/teleagent-multi/rollback.sh`

## 部署到 Linux 服务器（systemd，不需要 Docker）

把 `teleagent-multi/` 目录和 `install-linux.sh` 放到同一目录，然后：

```bash
sudo bash install-linux.sh                        # 默认 8580 端口，systemd 托管
sudo bash install-linux.sh --password 'your-pass' # 给面板加 Basic 认证（公网机器强烈建议）
sudo bash install-linux.sh --port 8590            # 换端口
sudo bash install-linux.sh --docker               # 改用 Docker Compose 部署
```

脚本做的事：

1. 复制程序到 `/opt/teleagent/teleagent-multi`
2. 若这台机器以前跑过单账号版，自动搬 `config.json` + `.secret`（已有 `data/config.json` 则不动）
3. 没 Node 就装 Node 20（走 npmmirror 镜像，不依赖 apt 源）
4. `npm install --omit=dev`
5. 建系统用户 `teleagent`，注册 `teleagent-multi.service`（`Restart=always`，崩溃 5 秒拉起，开机自启）
6. 轮询 `/api/state` 直到 200，打印面板地址与账号清单

日常运维：

```bash
systemctl status teleagent-multi
systemctl restart teleagent-multi
journalctl -u teleagent-multi -f
tail -f /opt/teleagent/teleagent-multi/data/stdout.log
sudo bash /opt/teleagent/teleagent-multi/uninstall-linux.sh           # 卸载，保留数据
sudo bash /opt/teleagent/teleagent-multi/uninstall-linux.sh --purge   # 连数据一起删
```

**公网机器务必注意**：面板默认无鉴权，`8580` 暴露在公网等于把账号和 Cookie 送给所有人。两种处理——只监听本机再走 frp/nginx 反代，或部署时带 `--password`。云服务器还要在安全组放行对应端口。

## 部署到 Linux（Docker 方式）

```bash
# 装 docker（Debian/Ubuntu，官方脚本）
curl -fsSL https://get.docker.com | bash

cd /opt/teleagent/teleagent-multi
docker compose up -d --build
docker compose logs -f --tail 30
```

Linux 服务器上不需要手动调 MTU（`docker-compose.yml` 里的 1400 只在那台 Windows 云电脑上才有意义，Linux 上保持默认也能跑，脚本里写死 1400 不会造成问题）。

### 提示「缺少 docker compose」怎么办

发行版仓库里的 `docker.io` 只装引擎，不带 compose 插件。三条路，任选：

```bash
# A. 手动装 compose v2 插件（走 ghfast 代理，国内可下）
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fL https://ghfast.top/https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-x86_64 \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
docker compose version

# B. 直接用 docker.sh（现在会自动兜底，装不上 compose 就改走 docker build + docker run）
bash docker.sh --password 'xxx'

# C. 完全不碰 compose
cd /opt/teleagent/teleagent-multi
docker build -t teleagent-multi:latest .
docker rm -f teleagent-multi 2>/dev/null
docker run -d --name teleagent-multi --restart unless-stopped \
  -p 8580:8580 -e TZ=Asia/Shanghai -e DATA_DIR=/app/data \
  -e WEB_PASSWORD='xxx' \
  -v /opt/teleagent/teleagent-multi/data:/app/data \
  teleagent-multi:latest
```

## 纯 Docker 部署（不用 compose、不用 deploy.sh）

全程在 WSL 里执行。Windows 侧加前缀 `wsl -d Ubuntu2404 -u root --`。

**1. 构建镜像**

```bash
cd /opt/teleagent/teleagent-multi
docker build -t teleagent-multi:latest .
```

拉不到 `node:22-alpine` 就换镜像源：

```bash
docker build --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:22-alpine -t teleagent-multi:latest .
```

**2. 准备数据目录并迁移旧数据**

```bash
mkdir -p /opt/teleagent/teleagent-multi/data/logs
cp /opt/teleagent/teleagent-keepalive/data/config.json /opt/teleagent/teleagent-multi/data/
cp /opt/teleagent/teleagent-keepalive/data/.secret     /opt/teleagent/teleagent-multi/data/
```

旧配置是 v1 单账号结构，容器首次启动会自动转成 `accounts[0]`。全新装机器跳过这步。

**3. 停旧容器（保留可回滚）**

```bash
docker update --restart=no teleagent-keepalive
docker stop teleagent-keepalive
```

**4. 起新容器**

```bash
docker run -d \
  --name teleagent-multi \
  --restart unless-stopped \
  -p 8580:8580 \
  -e TZ=Asia/Shanghai \
  -e PORT=8580 \
  -e DATA_DIR=/app/data \
  -e NODE_OPTIONS=--dns-result-order=ipv4first \
  -v /opt/teleagent/teleagent-multi/data:/app/data \
  teleagent-multi:latest
```

**5. 验证**

```bash
docker ps --filter name=teleagent-multi
docker logs --tail 30 teleagent-multi
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8580/api/state   # 要 200
```

**6. 更新代码后重建**

```bash
cd /opt/teleagent/teleagent-multi
docker compose down            # 或 docker rm -f teleagent-multi
docker build -t teleagent-multi:latest .
docker run -d ...（同上）
```

### docker run 和 compose 的差别

compose 那份 `docker-compose.yml` 多做了两件事，用 `docker run` 时要自己补：

| 配置 | 作用 | 手动补法 |
|---|---|---|
| `networks.default.driver_opts` MTU 1400 | 这台机器物理网卡 MTU 1450，容器默认 1500 会导致大包被静默丢弃、TLS 握手失败 | 或先 `docker network create --opt com.docker.network.driver.mtu=1400 ta-net` 再用 `--network ta-net` |
| `healthcheck` | `docker ps` 里能看到 healthy/unhealthy | `--health-cmd` 加一行，不加也能跑 |

## 常用接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/state` | 全部账号状态 + 全局通知配置 |
| GET | `/api/logs?limit=120&account=<id>` | 日志，可按账号过滤 |
| POST | `/api/accounts` | 新增账号 `{name, account, password | cookie, enabled}` |
| POST | `/api/accounts/<id>/config` | 改配置（`enabled` / `mode` / `cookie` / `authMode` / 重登天数…） |
| POST | `/api/accounts/<id>/login` | 手动登录（不传密码则用已存密文） |
| POST | `/api/accounts/<id>/restart` | 重载该账号的保活循环 |
| POST | `/api/accounts/<id>/checkin` | 签到 |
| POST | `/api/accounts/<id>/points` | 刷新剩余积分 + 每日领取状态 |
| POST | `/api/accounts/<id>/points-claim` | 立即领取每日积分 |
| POST | `/api/accounts/<id>/desktop-url` | 生成网页版云电脑入口（claim 模式会让位） |
| POST | `/api/accounts/<id>/delete` | 删除账号 |
| POST | `/api/notify` | 全局通知配置 |
| POST | `/api/notify/test` | 发测试消息（可带 `account` 指定用哪个机器人） |
| GET | `/api/notify/templates` | 通知模板目录（事件、可用变量、默认值、当前值） |
| POST | `/api/notify/templates` | 保存模板 `{id, title, body}`，或只改前缀 `{headTemplate}` |
| POST | `/api/notify/templates/reset` | 所有模板恢复默认 |
| POST | `/api/notify/templates/preview` | 预览渲染结果 `{id, title?, body?, vars?}` |
| POST | `/api/notify/templates/test` | 按模板发一条真实测试消息 `{id}` |

## 通知模板：文案可以自己改

推送内容不再写死在代码里，面板右上角「通知设置 → 模板管理」里可以逐条编辑，改完立刻生效。

**怎么用**

1. 点「通知设置」→「模板管理」
2. 左边选一个事件，右边改「标题模板」和「正文模板」
3. 正文里用 `{{变量}}` 占位，点下面的变量按钮直接插入
4. 下方「预览」实时显示最终发出去的样子
5. 点「保存这条」落盘；要退回默认就点「恢复默认」

模板存在 `data/config.json` 的 `notify.templates` 里，只存你改过的那几条，其余走内置默认值。

**标题前缀**

左边「标题前缀」默认是 `【TeleAgent保活·{{账号}}】`，多账号时自动带上是哪个账号出的事。也可以改成任意文字，比如 `[{{账号}}] 保活告警`。

**有哪些事件和变量**

| 事件 | 什么时候触发 | 可用变量 |
|---|---|---|
| `desktop` | 云电脑掉线，正在自动拉起 | 账号、实例、状态、距上次换票、时间 |
| `desktop-fail` | 多轮 start 后仍未回到运行中 | 账号、实例、时间 |
| `desktop-ok` | 掉线之后又拉起来了 | 账号、实例、时间 |
| `account` | 登录态失效，账号掉线 | 账号、原因、处理、时间 |
| `login-fail` | 账号密码自动续期失败 | 账号、原因、时间 |
| `cookie-expire` | Cookie 快过期 | 账号、剩余天数、时间 |
| `relogin` | 自动重新登录成功 | 账号、到期、时间 |
| `points` | 每日积分自动领取成功 | 账号、本次、剩余、累计、时间 |

模板里写了该事件不支持的变量时，编辑页会标黄提示「未知变量」，发送时该变量替换成空串。

## 积分：自动领取 + 剩余显示

每个账号都能自动领「积分福利社」的每日积分（默认 100 分/天），并在面板上显示余额。

**面板在哪看**

- 左侧账号卡片：`积分 6300`
- 右侧详情统计条：`剩余积分` / `今日领取`（已领 / 未领）
- 「积分福利社」一栏：勾选「每天自动领取每日积分」后点 `保存设置`；`立即领取` 手动补领，`刷新积分` 只拉余额不动账
- 小字提示：每日可领多少、本期已领几天累计多少分、上次领取时间、积分最早到期还有几天

**自动领取的时机**

保活循环每轮成功换票后检查一次：

- 余额超过 10 分钟没刷新 → 拉一次 `points/detail`
- 今天还没领且距上次尝试超过 20 分钟 → 调 `checkTask?type=daily_login` 领取，成功后推送一条通知

领取前会先读 `checkDayTask`，`claimed_today=true` 就直接跳过，不会重复打接口。积分接口用的是 `/meter/super-agent`，与实例管理接口不同源，但共用同一个 Cookie；Cookie 失效时积分接口报 401，会和保活一起触发自动重登。

**对应接口**

```bash
# 余额
curl -H "Cookie: $COOKIE" https://agent.teleai.com.cn/meter/super-agent/user/portal/points/detail
# 今日领取状态
curl -H "Cookie: $COOKIE" https://agent.teleai.com.cn/meter/super-agent/user/portal/companyStore/checkDayTask
# 领取
curl -H "Cookie: $COOKIE" "https://agent.teleai.com.cn/meter/super-agent/user/portal/companyStore/checkTask?type=daily_login"
```

## 两种保活模式

- **ticket（推荐）**：每 `refreshSec` 秒换票刷新活跃，不占客户端位，不会挤掉你正在用的网页/客户端
- **claim**：保持长连接占用客户端位，能拿到实时连接地址，但会和你抢位置

面板默认 ticket。需要临时进云电脑操作时，用「网页入口」按钮，claim 模式下会自动让位 `pauseMin` 分钟。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8580 | 监听端口 |
| `DATA_DIR` | `./data` | 数据目录 |
| `WEB_PASSWORD` | 空 | 设置后整站启用 HTTP Basic 认证 |
| `WEB_USER` | admin | Basic 用户名 |
| `WECOM_WEBHOOK` | 空 | 全局默认机器人 |
| `TZ` | Asia/Shanghai | 时区 |

## 密码解不开怎么办

`passwordEnc` 是用 `data/.secret` 加密的，换机器时两把钥匙不同就会解不开。三种处理：

1. 在面板重新填一次密码（最简单，会用本机钥匙重新加密）
2. 把老机器的 `data/.secret` 拷过来覆盖
3. 干脆用 Cookie 模式，不碰密码
