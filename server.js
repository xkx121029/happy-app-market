import os from 'node:os';
import { config, ensureDirs, DB_FILE, DIRS } from './src/config.js';
import { createDb } from './src/db.js';
import { createPublicServer } from './src/public-server.js';
import { createAdminServer } from './src/admin-server.js';

ensureDirs();
const store = createDb(DB_FILE);
const publicServer = createPublicServer(store);
const adminServer = createAdminServer(store);

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) return item.address;
    }
  }
  return '127.0.0.1';
}

function listen(server, port, label) {
  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`${label}端口 ${port} 已被占用，请修改 config.json 后重试`));
      } else {
        reject(err);
      }
    });
    server.listen(port, config.host, () => resolve());
  });
}

const host = lanAddress();

try {
  await listen(publicServer, config.publicPort, '前台');
  await listen(adminServer, config.adminPort, '后台');
} catch (err) {
  console.error(`\n启动失败：${err.message}\n`);
  process.exit(1);
}

const line = '─'.repeat(52);
console.log(`
┌${line}┐
  ${config.siteName} 已启动

  前台下载站   http://localhost:${config.publicPort}
               http://${host}:${config.publicPort}
  后台管理台   http://localhost:${config.adminPort}
               http://${host}:${config.adminPort}

  数据文件     ${DB_FILE}
  上传目录     ${DIRS.uploads}
  上传上限     ${config.maxUploadMB} MB
└${line}┘
`);

function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在关闭服务…`);
  publicServer.close();
  adminServer.close(() => {
    try {
      store.close();
    } catch {
      /* 忽略关闭异常 */
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));