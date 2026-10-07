import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, MAX_UPLOAD_BYTES, config } from './config.js';
import { json, fail, readJson, saveStream, pickFileName, uniqueName, safeJoin, serveFile, str } from './util.js';

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

/** 后台管理服务：独立端口，承载管理页面与全部管理 API */
export function createAdminServer(store) {
  const routes = [
    { method: 'GET', pattern: /^\/api\/overview$/, handler: adminOverview },
    { method: 'GET', pattern: /^\/api\/apps$/, handler: adminListApps },
    { method: 'POST', pattern: /^\/api\/apps$/, handler: adminCreateApp },
    { method: 'GET', pattern: /^\/api\/apps\/(\d+)$/, handler: adminGetApp },
    { method: 'PUT', pattern: /^\/api\/apps\/(\d+)$/, handler: adminUpdateApp },
    { method: 'PATCH', pattern: /^\/api\/apps\/(\d+)$/, handler: adminUpdateApp },
    { method: 'DELETE', pattern: /^\/api\/apps\/(\d+)$/, handler: adminDeleteApp },
    { method: 'POST', pattern: /^\/api\/apps\/(\d+)\/status$/, handler: adminSetStatus },
    { method: 'POST', pattern: /^\/api\/apps\/(\d+)\/package$/, handler: adminUploadPackage },
    { method: 'DELETE', pattern: /^\/api\/apps\/(\d+)\/package$/, handler: adminDeletePackage },
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
    siteName: config.siteName,
    ports: { public: config.publicPort, admin: config.adminPort },
    stats: store.stats(),
    categories: store.categories()
  });
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
    icon: str(body.icon, 500)
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
  const updated = store.setPackage(params[0], { path: `/uploads/packages/${stored}`, file: original, size });
  if (oldAbs && path.basename(oldAbs) !== stored) await removeQuiet(oldAbs);
  return json(res, 200, { ok: true, app: updated });
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