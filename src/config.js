import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CONFIG_FILE = path.join(ROOT, 'config.json');

const DEFAULTS = {
  siteName: '开心软件市场',
  siteSlogan: '自己写的软件都放在这里',
  heroKicker: '自己写的软件',
  heroTitle: '挑一个\n*趁手*的软件',
  heroSubtitle: '看中哪个点进去，直接下载安装包。',
  statAppsLabel: '在架应用',
  statDownloadsLabel: '累计下载',
  footerNote: '下载前请核对版本与体积',
  accentColor: '#2f6f9f',
  publicPort: 8080,
  adminPort: 8081,
  host: '0.0.0.0',
  maxUploadMB: 800,
  defaultPageSize: 12
};

/**
 * 可在后台「站点设置」里修改的字段。
 * 这里只列内容项，端口、上传上限等部署参数仍留在 config.json 里。
 */
export const SETTING_KEYS = [
  'siteName',
  'siteSlogan',
  'heroKicker',
  'heroTitle',
  'heroSubtitle',
  'statAppsLabel',
  'statDownloadsLabel',
  'footerNote',
  'accentColor',
  'defaultPageSize'
];

/** 各设置项的默认值，后台可据此一键恢复 */
export const SETTING_DEFAULTS = Object.fromEntries(SETTING_KEYS.map((key) => [key, DEFAULTS[key]]));

/** 把数据库里的设置与默认值合并成一份完整设置 */
export function mergeSettings(stored = {}) {
  const merged = {};
  for (const key of SETTING_KEYS) {
    const value = stored[key];
    merged[key] = value === undefined || value === '' ? config[key] ?? DEFAULTS[key] : value;
  }
  return merged;
}

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