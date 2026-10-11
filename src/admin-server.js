import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DIRS,
  MAX_UPLOAD_BYTES,
  config,
  mergeSettings,
  SETTING_KEYS,
  SETTING_DEFAULTS
} from './config.js';
import { json, fail, readJson, saveStream, pickFileName, uniqueName, safeJoin, serveFile, str, mimeOf } from './util.js';
import { readApkMeta } from './apkmeta.js';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.bmp']);

function isImage(fileName) {
  return IMAGE_EXT.has(path.extname(fileName).toLowerCase());
}

async function removeQuiet(absPath) {
  if (!absPath) return;
  try {
    await fs.promises.rm(absPath, { force: true });
  } catch {
    /* 忽略清理失败 */
  }
}

/** 把 /uploads/... 形式的相对地址还原成磁盘绝对路径 */
function uploadPathOf(url) {
  if (typeof url !== 'string' || !url.startsWith('/uploads/')) return null;
  return safeJoin(DIRS.uploads, url.slice('/uploads/'.length));
}

/** 单个应用最多允许的开源链接条数 */
const MAX_OPEN_SOURCE = 12;

/**
 * 校验开源链接数组：忽略空串，仅接受 http/https 地址，去重并限制条数。
 * 传入 undefined 时返回 undefined（表示本次不改动该字段）。
 */
function cleanOpenSourceUrls(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('开源链接需要是数组');
  const list = [];
  for (const raw of value) {
    const url = String(raw ?? '').trim();
    if (!url) continue;
    if (!/^https?:\/\/\S+$/i.test(url)) {
      throw new Error(`开源链接需要以 http:// 或 https:// 开头：${url}`);
    }
    if (!list.includes(url)) list.push(url);
  }
  if (list.length > MAX_OPEN_SOURCE) throw new Error(`开源链接最多 ${MAX_OPEN_SOURCE} 条`);
  return list;
}

/** 后台管理服务：独立端口，承载管理页面与全部管理 API */
export function createAdminServer(store) {
  const routes = [
    { method: 'GET', pattern: /^\/api\/overview$/, handler: adminOverview },
    { method: 'GET', pattern: /^\/api\/settings$/, handler: adminGetSettings },
    { method: 'PUT', pattern: /^\/api\/settings$/, handler: adminUpdateSettings },
    { method: 'POST', pattern: /^\/api\/settings\/reset$/, handler: adminResetSettings },
    { method: 'GET', pattern: /^\/api\/apps$/, handler: adminListApps },
    { method: 'POST', pattern: /^\/api\/apps$/, handler: adminCreateApp },
    { method: 'GET', pattern: /^\/api\/apps\/(\d+)$/, handler: adminGetApp },
    { method: 'PUT', pattern: /^\/api\/apps\/(\d+)$/, handler: adminUpdateApp },
    { method: 'PATCH', pattern: /^\/api\/apps\/(\d+)$/, handler: adminUpdateApp },
    { method: 'DELETE', pattern: /^\/api\/apps\/(\d+)$/, handler: adminDeleteApp },
    { method: 'POST', pattern: /^\/api\/apps\/(\d+)\/status$/, handler: adminSetStatus },
    { method: 'POST', pattern: /^\/api\/apps\/(\d+)\/package$/, handler: adminUploadPackage },
    { method: 'DELETE', pattern: /^\/api\/apps\/(\d+)\/package$/, handler: adminDeletePackage },
    { method: 'POST', pattern: /^\/api\/apk\/inspect$/, handler: adminInspectApk },
    { method: 'GET', pattern: /^\/api\/apps\/(\d+)\/download$/, handler: adminDownload },
    { method: 'POST', pattern: /^\/api\/apps\/(\d+)\/icon$/, handler: adminUploadIcon },
    { method: 'POST', pattern: /^\/api\/apps\/(\d+)\/screenshots$/, handler: adminUploadScreenshot },
    { method: 'DELETE', pattern: /^\/api\/apps\/(\d+)\/screenshots$/, handler: adminDeleteScreenshot }
  ];

  return http.createServer(async (req, res) => {
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-file-name');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === '/api' || pathname === '/api/health') {
      return json(res, 200, {
        ok: true,
        service: config.siteName,
        role: 'admin',
        time: new Date().toISOString(),
        endpoints: routes.map((r) => `${r.method} ${r.pattern.source.replace(/^\^|\$$/g, '').replace(/\\\//g, '/').replace(/\(\?<(\w+)>/g, ':$1').replace(/\(\\d\+\)/g, ':id')}`)
      });
    }

    if (pathname.startsWith('/api/')) {
      try {
        let pathMatched = false;
        for (const route of routes) {
          const match = route.pattern.exec(pathname);
          if (!match) continue;
          pathMatched = true;
          if (route.method !== req.method) continue;
          return await route.handler(req, res, { store, params: match.slice(1), query: url.searchParams });
        }
        if (pathMatched) {
          const allowed = [...new Set(routes.filter((r) => r.pattern.test(pathname)).map((r) => r.method))];
          res.setHeader('Allow', allowed.join(', '));
          return fail(res, 405, `该地址仅支持 ${allowed.join(' / ')}，收到 ${req.method}`);
        }
        return fail(res, 404, `接口不存在：${req.method} ${pathname}`);
      } catch (err) {
        return fail(res, 400, err?.message || '请求处理失败');
      }
    }

    // 前台与后台共用的设计层
    if (pathname.startsWith('/shared/')) {
      const abs = safeJoin(DIRS.shared, pathname.slice('/shared/'.length));
      if (!abs) return fail(res, 400, '非法路径');
      return serveFile(req, res, abs, { cache: 'public, max-age=3600' });
    }

    // 图片等上传资源的只读访问（后台用于预览）
    if (pathname.startsWith('/uploads/')) {
      const abs = safeJoin(DIRS.uploads, pathname.slice('/uploads/'.length));
      if (!abs) return fail(res, 400, '非法路径');
      return serveFile(req, res, abs);
    }

    // 后台页面静态资源
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const abs = safeJoin(DIRS.admin, rel);
    if (!abs) return fail(res, 400, '非法路径');
    return serveFile(req, res, abs, { cache: 'no-cache' });
  });
}

/* ------------------------------- 处理函数 ------------------------------- */

async function adminOverview(req, res, { store }) {
  return json(res, 200, {
    ok: true,
    siteName: mergeSettings(store.settings()).siteName,
    ports: { public: config.publicPort, admin: config.adminPort },
    stats: store.stats(),
    categories: store.categories()
  });
}

/* ------------------------------ 站点设置 ------------------------------ */

/** 各文本设置项的最大长度，防止写入超长内容 */
const SETTING_MAX = {
  siteName: 60,
  siteSlogan: 120,
  heroKicker: 60,
  heroTitle: 120,
  heroSubtitle: 200,
  statAppsLabel: 20,
  statDownloadsLabel: 20,
  footerNote: 120
};

async function adminGetSettings(req, res, { store }) {
  return json(res, 200, {
    ok: true,
    settings: mergeSettings(store.settings()),
    defaults: SETTING_DEFAULTS
  });
}

async function adminUpdateSettings(req, res, { store }) {
  const body = await readJson(req);
  const patch = {};
  for (const key of SETTING_KEYS) {
    if (body[key] === undefined) continue;

    if (key === 'accentColor') {
      const color = str(body.accentColor, 20).toLowerCase();
      if (!/^#[0-9a-f]{6}$/.test(color)) return fail(res, 400, '强调色需要是 #RRGGBB 形式的十六进制颜色');
      patch.accentColor = color;
      continue;
    }

    if (key === 'defaultPageSize') {
      const size = Number(body.defaultPageSize);
      if (!Number.isFinite(size) || size < 1 || size > 100) return fail(res, 400, '每页条数需要在 1 到 100 之间');
      patch.defaultPageSize = String(Math.round(size));
      continue;
    }

    const value = str(body[key], SETTING_MAX[key] || 120).trim();
    if (key === 'siteName' && !value) return fail(res, 400, '站点名称不能为空');
    patch[key] = value;
  }
  store.saveSettings(patch);
  return json(res, 200, { ok: true, settings: mergeSettings(store.settings()) });
}

async function adminResetSettings(req, res, { store }) {
  store.saveSettings(SETTING_DEFAULTS);
  return json(res, 200, { ok: true, settings: mergeSettings(store.settings()) });
}

async function adminListApps(req, res, { store, query }) {
  const items = store.listAll({
    q: str(query.get('q'), 100),
    status: str(query.get('status'), 4),
    category: str(query.get('category'), 60)
  });
  return json(res, 200, { ok: true, total: items.length, items });
}

async function adminGetApp(req, res, { store, params }) {
  const app = store.get(params[0]);
  if (!app) return fail(res, 404, '应用不存在');
  return json(res, 200, { ok: true, app });
}

async function adminCreateApp(req, res, { store }) {
  const body = await readJson(req);
  const name = str(body.name, 120);
  if (!name) return fail(res, 400, '应用名称为必填项');
  const app = store.create({
    name,
    package_name: str(body.package_name, 120),
    version: str(body.version, 40),
    developer: str(body.developer, 120),
    category: str(body.category, 60),
    summary: str(body.summary, 300),
    description: str(body.description, 20000),
    icon: str(body.icon, 500),
    open_source_urls: cleanOpenSourceUrls(body.open_source_urls) || []
  });
  return json(res, 201, { ok: true, app });
}

async function adminUpdateApp(req, res, { store, params }) {
  const app = store.get(params[0]);
  if (!app) return fail(res, 404, '应用不存在');
  const body = await readJson(req);
  const patch = {};
  if (body.name !== undefined) {
    const name = str(body.name, 120);
    if (!name) return fail(res, 400, '应用名称不能为空');
    patch.name = name;
  }
  if (body.package_name !== undefined) patch.package_name = str(body.package_name, 120);
  if (body.version !== undefined) patch.version = str(body.version, 40);
  if (body.developer !== undefined) patch.developer = str(body.developer, 120);
  if (body.category !== undefined) patch.category = str(body.category, 60);
  if (body.summary !== undefined) patch.summary = str(body.summary, 300);
  if (body.description !== undefined) patch.description = str(body.description, 20000);
  if (body.icon !== undefined) {
    // 图标文件统一由 /icon 上传接口管理，这里只允许清空，避免产生孤儿文件
    const next = str(body.icon, 500);
    if (!next) patch.icon = '';
  }
  if (body.open_source_urls !== undefined) {
    patch.open_source_urls = cleanOpenSourceUrls(body.open_source_urls);
  }
  const updated = store.update(params[0], patch);
  return json(res, 200, { ok: true, app: updated });
}

async function adminDeleteApp(req, res, { store, params }) {
  const app = store.remove(params[0]);
  if (!app) return fail(res, 404, '应用不存在');
  await Promise.all([
    removeQuiet(uploadPathOf(app.icon)),
    removeQuiet(uploadPathOf(app.package_path) || app.package_path),
    ...app.screenshots.map((shot) => removeQuiet(uploadPathOf(shot)))
  ]);
  return json(res, 200, { ok: true, removed: app.id });
}

async function adminSetStatus(req, res, { store, params }) {
  const app = store.get(params[0]);
  if (!app) return fail(res, 404, '应用不存在');
  const body = await readJson(req);
  const status = Number(body.status) ? 1 : 0;
  if (status === 1 && !app.hasPackage) {
    return fail(res, 400, '尚未上传应用包体，无法上架');
  }
  const updated = store.setStatus(params[0], status);
  return json(res, 200, { ok: true, app: updated });
}

async function adminUploadPackage(req, res, { store, params }) {
  const app = store.get(params[0]);
  if (!app) return fail(res, 404, '应用不存在');
  const original = pickFileName(req);
  const stored = uniqueName(original);
  const abs = path.join(DIRS.packages, stored);
  const size = await saveStream(req, abs, MAX_UPLOAD_BYTES);

  // 替换包体时删除旧文件，避免磁盘堆积
  const oldAbs = app.package_path ? path.join(DIRS.packages, path.basename(app.package_path)) : null;
  let updated = store.setPackage(params[0], { path: `/uploads/packages/${stored}`, file: original, size });
  if (oldAbs && path.basename(oldAbs) !== stored) await removeQuiet(oldAbs);

  // APK 额外提取名称、版本号、包名与图标，能填的自动补上
  const apk = path.extname(original).toLowerCase() === '.apk' ? await applyApkMeta(store, updated, abs) : null;
  if (apk) {
    updated = apk.app;
    delete apk.app; // app 已在外层返回，避免响应里重复一份
  }
  return json(res, 200, { ok: true, app: updated, apk });
}

/**
 * 解析已落盘的 APK，把提取结果写回应用记录：
 * 版本号与包名以 APK 为准直接同步，应用名与图标只在为空时补上，
 * 避免覆盖后台手工填写的内容。解析失败静默返回 null，不影响上传。
 */
async function applyApkMeta(store, app, absPath) {
  const meta = await readApkMeta(absPath);
  if (!meta) return null;

  const applied = [];
  const patch = {};
  if (meta.version && meta.version !== app.version) {
    patch.version = meta.version;
    applied.push('version');
  }
  if (meta.package && meta.package !== app.package_name) {
    patch.package_name = meta.package;
    applied.push('package_name');
  }
  if (!app.name && meta.name) {
    patch.name = meta.name;
    applied.push('name');
  }
  if (!app.icon && meta.icon?.buffer?.length) {
    const iconStored = uniqueName(`apk-icon${meta.icon.ext}`);
    await fs.promises.writeFile(path.join(DIRS.icons, iconStored), meta.icon.buffer);
    patch.icon = `/uploads/icons/${iconStored}`;
    applied.push('icon');
  }

  const updated = applied.length ? store.update(app.id, patch) : app;
  return {
    name: meta.name,
    version: meta.version,
    versionCode: meta.versionCode,
    package: meta.package,
    hasIcon: Boolean(meta.icon),
    applied,
    app: updated
  };
}

/** 新建应用前的 APK 预读：只解析不落库，供前端回填表单 */
async function adminInspectApk(req, res) {
  const original = pickFileName(req, '.apk');
  const tmp = path.join(os.tmpdir(), `kx-apk-${uniqueName(original)}`);
  try {
    const size = await saveStream(req, tmp, MAX_UPLOAD_BYTES);
    if (!size) return fail(res, 400, '文件为空');
    const meta = await readApkMeta(tmp);
    if (!meta) return fail(res, 400, '无法解析该 APK，请确认文件完整后重试');
    return json(res, 200, {
      ok: true,
      apk: {
        name: meta.name,
        version: meta.version,
        versionCode: meta.versionCode,
        package: meta.package,
        icon: meta.icon?.buffer?.length
          ? {
              ext: meta.icon.ext,
              mime: mimeOf(`icon${meta.icon.ext}`),
              base64: meta.icon.buffer.toString('base64')
            }
          : null
      }
    });
  } catch (err) {
    return fail(res, 400, err?.message || 'APK 解析失败');
  } finally {
    await removeQuiet(tmp);
  }
}

async function adminDeletePackage(req, res, { store, params }) {
  const app = store.get(params[0]);
  if (!app) return fail(res, 404, '应用不存在');
  const abs = app.package_path ? path.join(DIRS.packages, path.basename(app.package_path)) : null;
  const updated = store.clearPackage(params[0]);
  await removeQuiet(abs);
  return json(res, 200, { ok: true, app: updated });
}

async function adminDownload(req, res, { store, params }) {
  const app = store.get(params[0]);
  if (!app || !app.hasPackage) return fail(res, 404, '该应用暂无可下载的包体');
  const abs = path.join(DIRS.packages, path.basename(app.package_path));
  if (!fs.existsSync(abs)) return fail(res, 404, '包体文件已丢失');
  return serveFile(req, res, abs, { downloadName: app.package_file || `app-${app.id}.bin`, cache: 'no-store' });
}

async function adminUploadIcon(req, res, { store, params }) {
  const app = store.get(params[0]);
  if (!app) return fail(res, 404, '应用不存在');
  const original = pickFileName(req, '.png');
  if (!isImage(original)) return fail(res, 400, '图标仅支持图片格式');
  const stored = uniqueName(original);
  const abs = path.join(DIRS.icons, stored);
  await saveStream(req, abs, 20 * 1024 * 1024);
  const oldAbs = uploadPathOf(app.icon);
  const updated = store.setIcon(params[0], `/uploads/icons/${stored}`);
  if (oldAbs && path.basename(oldAbs) !== stored) await removeQuiet(oldAbs);
  return json(res, 200, { ok: true, app: updated });
}

async function adminUploadScreenshot(req, res, { store, params }) {
  const app = store.get(params[0]);
  if (!app) return fail(res, 404, '应用不存在');
  const original = pickFileName(req, '.png');
  if (!isImage(original)) return fail(res, 400, '截图仅支持图片格式');
  const stored = uniqueName(original);
  const abs = path.join(DIRS.screenshots, stored);
  await saveStream(req, abs, 20 * 1024 * 1024);
  const updated = store.addScreenshot(params[0], `/uploads/screenshots/${stored}`);
  return json(res, 200, { ok: true, app: updated });
}

async function adminDeleteScreenshot(req, res, { store, params }) {
  const app = store.get(params[0]);
  if (!app) return fail(res, 404, '应用不存在');
  const body = await readJson(req);
  const target = str(body.url, 500);
  if (!target) return fail(res, 400, '缺少 url 参数');
  const updated = store.removeScreenshot(params[0], target);
  const abs = uploadPathOf(target);
  if (abs && path.dirname(abs) === DIRS.screenshots) await removeQuiet(abs);
  return json(res, 200, { ok: true, app: updated });
}