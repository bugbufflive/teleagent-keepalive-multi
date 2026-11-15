/**
 * 入口（多账号版）：启动多个保活内核 + Web 控制台
 * 环境变量：
 *   PORT          监听端口，默认 8580
 *   DATA_DIR      数据目录，默认 ./data
 *   WEB_PASSWORD  设置后整站启用 HTTP Basic 认证
 *   WEB_USER      Basic 用户名，默认 admin
 *   TZ            时区，建议 Asia/Shanghai
 */
const path = require('path');
const logger = require('./logger');
const { Store } = require('./store');
const { Manager } = require('./manager');
const { createServer } = require('./web');

const PORT = Number(process.env.PORT) || 8580;
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');

const store = new Store(DATA_DIR);
if (store.migrated) {
  logger.write('检测到旧版单账号配置，已自动迁移为多账号结构', 'success', DATA_DIR);
}

const manager = new Manager({ dataDir: DATA_DIR, store, logger });
manager.startAll();

const server = createServer({ manager, store, logger, dataDir: DATA_DIR });
server.listen(PORT, '0.0.0.0', () => {
  const n = store.list().length;
  logger.write(`控制台已就绪：http://0.0.0.0:${PORT}（账号 ${n} 个，数据目录 ${DATA_DIR}）`, 'success', DATA_DIR);
});

function shutdown(sig) {
  logger.write(`收到 ${sig}，正在退出…`, 'warning', DATA_DIR);
  manager.stopAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
