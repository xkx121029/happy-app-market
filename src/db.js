import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS apps (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  package_name TEXT    NOT NULL DEFAULT '',
  version      TEXT    NOT NULL DEFAULT '',
  developer    TEXT    NOT NULL DEFAULT '',
  category     TEXT    NOT NULL DEFAULT '',
  summary      TEXT    NOT NULL DEFAULT '',
  description  TEXT    NOT NULL DEFAULT '',
  icon         TEXT    NOT NULL DEFAULT '',
  screenshots  TEXT    NOT NULL DEFAULT '[]',
  package_path TEXT    NOT NULL DEFAULT '',
  package_file TEXT    NOT NULL DEFAULT '',
  package_size INTEGER NOT NULL DEFAULT 0,
  status       INTEGER NOT NULL DEFAULT 0,
  downloads    INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT '',
  updated_at   TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_apps_status ON apps(status);
CREATE INDEX IF NOT EXISTS idx_apps_category ON apps(category);
`;

/** 数据库字段白名单：可由接口写入的字段 */
const WRITABLE = [
  'name',
  'package_name',
  'version',
  'developer',
  'category',
  'summary',
  'description',
  'icon'
];

export function createDb(dbFile) {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return new MarketStore(db);
}

function now() {
  return new Date().toISOString();
}

function parseShots(raw) {
  try {
    const list = JSON.parse(raw || '[]');
    return Array.isArray(list) ? list.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function toPublicApp(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    package_name: row.package_name,
    version: row.version,
    developer: row.developer,
    category: row.category,
    summary: row.summary,
    description: row.description,
    icon: row.icon,
    screenshots: parseShots(row.screenshots),
    hasPackage: Boolean(row.package_path),
    package_path: row.package_path,
    package_file: row.package_file,
    package_size: row.package_size,
    status: row.status,
    downloads: row.downloads,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export class MarketStore {
  constructor(db) {
    this.db = db;
  }

  close() {
    this.db.close();
  }

  /** 前台列表：只返回已上架应用 */
  listPublished({ q = '', category = '', sort = 'latest', page = 1, pageSize = 12 } = {}) {
    const where = ['status = 1'];
    const params = [];
    if (q) {
      where.push('(name LIKE ? OR summary LIKE ? OR developer LIKE ? OR package_name LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }
    if (category) {
      where.push('category = ?');
      params.push(category);
    }
    const orderBy =
      sort === 'downloads' ? 'downloads DESC, id DESC' : sort === 'name' ? 'name ASC, id DESC' : 'id DESC';
    const clause = where.join(' AND ');
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM apps WHERE ${clause}`).get(...params).n;
    const size = Math.max(1, Math.min(100, Number(pageSize) || 12));
    const offset = Math.max(0, (Math.max(1, Number(page) || 1) - 1) * size);
    const rows = this.db
      .prepare(`SELECT * FROM apps WHERE ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
      .all(...params, size, offset);
    return { total, page: Math.max(1, Number(page) || 1), pageSize: size, items: rows.map(toPublicApp) };
  }

  /** 后台列表：返回全部应用（含未上架） */
  listAll({ q = '', status = '', category = '' } = {}) {
    const where = ['1 = 1'];
    const params = [];
    if (q) {
      where.push('(name LIKE ? OR summary LIKE ? OR developer LIKE ? OR package_name LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }
    if (status === '0' || status === '1') {
      where.push('status = ?');
      params.push(Number(status));
    }
    if (category) {
      where.push('category = ?');
      params.push(category);
    }
    const rows = this.db
      .prepare(`SELECT * FROM apps WHERE ${where.join(' AND ')} ORDER BY id DESC`)
      .all(...params);
    return rows.map(toPublicApp);
  }

  get(id) {
    return toPublicApp(this.db.prepare('SELECT * FROM apps WHERE id = ?').get(Number(id)));
  }

  /** 前台详情：仅已上架可见 */
  getPublished(id) {
    const row = this.db.prepare('SELECT * FROM apps WHERE id = ? AND status = 1').get(Number(id));
    return toPublicApp(row);
  }

  create(data = {}) {
    const ts = now();
    const info = this.db
      .prepare(
        `INSERT INTO apps (name, package_name, version, developer, category, summary, description, icon, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        String(data.name || '').trim(),
        String(data.package_name || ''),
        String(data.version || ''),
        String(data.developer || ''),
        String(data.category || ''),
        String(data.summary || ''),
        String(data.description || ''),
        String(data.icon || ''),
        ts,
        ts
      );
    return this.get(info.lastInsertRowid);
  }

  /** 更新元数据字段，只接受白名单字段 */
  update(id, data = {}) {
    const fields = [];
    const params = [];
    for (const key of WRITABLE) {
      if (data[key] === undefined) continue;
      fields.push(`${key} = ?`);
      params.push(String(data[key] ?? ''));
    }
    if (!fields.length) return this.get(id);
    fields.push('updated_at = ?');
    params.push(now(), Number(id));
    this.db.prepare(`UPDATE apps SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    return this.get(id);
  }

  setPackage(id, { path: pkgPath, file, size }) {
    this.db
      .prepare(
        'UPDATE apps SET package_path = ?, package_file = ?, package_size = ?, updated_at = ? WHERE id = ?'
      )
      .run(pkgPath, file, Number(size) || 0, now(), Number(id));
    return this.get(id);
  }

  clearPackage(id) {
    this.db
      .prepare("UPDATE apps SET package_path = '', package_file = '', package_size = 0, updated_at = ? WHERE id = ?")
      .run(now(), Number(id));
    return this.get(id);
  }

  setIcon(id, url) {
    this.db.prepare('UPDATE apps SET icon = ?, updated_at = ? WHERE id = ?').run(url, now(), Number(id));
    return this.get(id);
  }

  addScreenshot(id, url) {
    const app = this.get(id);
    if (!app) return null;
    const list = [...app.screenshots, url];
    this.db
      .prepare('UPDATE apps SET screenshots = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(list), now(), Number(id));
    return this.get(id);
  }

  removeScreenshot(id, url) {
    const app = this.get(id);
    if (!app) return null;
    const list = app.screenshots.filter((item) => item !== url);
    this.db
      .prepare('UPDATE apps SET screenshots = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(list), now(), Number(id));
    return this.get(id);
  }

  setStatus(id, status) {
    this.db.prepare('UPDATE apps SET status = ?, updated_at = ? WHERE id = ?').run(status ? 1 : 0, now(), Number(id));
    return this.get(id);
  }

  remove(id) {
    const app = this.get(id);
    if (!app) return null;
    this.db.prepare('DELETE FROM apps WHERE id = ?').run(Number(id));
    return app;
  }

  incrementDownload(id) {
    this.db.prepare('UPDATE apps SET downloads = downloads + 1 WHERE id = ?').run(Number(id));
  }

  categories() {
    const rows = this.db
      .prepare("SELECT category AS name, COUNT(*) AS count FROM apps WHERE status = 1 AND category <> '' GROUP BY category ORDER BY count DESC, name ASC")
      .all();
    return rows;
  }

  stats() {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END) AS published,
           SUM(CASE WHEN status = 0 THEN 1 ELSE 0 END) AS draft,
           COALESCE(SUM(downloads), 0) AS downloads,
           COALESCE(SUM(CASE WHEN package_path <> '' THEN 1 ELSE 0 END), 0) AS withPackage
         FROM apps`
      )
      .get();
    return {
      total: Number(row.total) || 0,
      published: Number(row.published) || 0,
      draft: Number(row.draft) || 0,
      downloads: Number(row.downloads) || 0,
      withPackage: Number(row.withPackage) || 0
    };
  }

  publicStats() {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total, COALESCE(SUM(downloads), 0) AS downloads
         FROM apps WHERE status = 1`
      )
      .get();
    return { total: Number(row.total) || 0, downloads: Number(row.downloads) || 0 };
  }
}