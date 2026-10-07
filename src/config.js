import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CONFIG_FILE = path.join(ROOT, 'config.json');

const DEFAULTS = {
  siteName: '开心软件市场',
  siteSlogan: '纯净分发 · 直接下载安装包',
  publicPort: 8080,
  adminPort: 8081,
  host: '0.0.0.0',
  maxUploadMB: 800,
  defaultPageSize: 12
};

function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export const config = readConfig();

export const DIRS = {
  public: path.join(ROOT, 'public'),
  admin: path.join(ROOT, 'admin'),
  shared: path.join(ROOT, 'shared'),
  uploads: path.join(ROOT, 'uploads'),
  icons: path.join(ROOT, 'uploads', 'icons'),
  screenshots: path.join(ROOT, 'uploads', 'screenshots'),
  packages: path.join(ROOT, 'uploads', 'packages'),
  data: path.join(ROOT, 'data')
};

export const MAX_UPLOAD_BYTES = Math.max(1, Number(config.maxUploadMB) || 800) * 1024 * 1024;

/** 一次性创建所有运行期目录 */
export function ensureDirs() {
  for (const dir of Object.values(DIRS)) fs.mkdirSync(dir, { recursive: true });
}

export const DB_FILE = path.join(DIRS.data, 'market.db');