import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, config } from './config.js';
import { json, fail, safeJoin, serveFile, str } from './util.js';

/** 前台服务：面向访客，只暴露已上架应用 */
export function createPublicServer(store) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);

    try {
      // 前台接口
      if (pathname === '/api/apps') {
        const data = store.listPublished({
          q: str(url.searchParams.get('q'), 100),
          category: str(url.searchParams.get('category'), 60),
          sort: str(url.searchParams.get('sort'), 20) || 'latest',
          page: Number(url.searchParams.get('page')) || 1,
          pageSize: Number(url.searchParams.get('pageSize')) || config.defaultPageSize
        });
        return json(res, 200, { ok: true, ...data });
      }

      const detailMatch = /^\/api\/apps\/(\d+)$/.exec(pathname);
      if (detailMatch) {
        const app = store.getPublished(detailMatch[1]);
        if (!app) return fail(res, 404, '应用不存在或已下架');
        return json(res, 200, { ok: true, app });
      }

      const downloadMatch = /^\/api\/apps\/(\d+)\/download$/.exec(pathname);
      if (downloadMatch) {
        const app = store.getPublished(downloadMatch[1]);
        if (!app) return fail(res, 404, '应用不存在或已下架');
        if (!app.hasPackage) return fail(res, 404, '该应用暂无可下载的包体');
        const abs = path.join(DIRS.packages, path.basename(app.package_path));
        if (!fs.existsSync(abs)) return fail(res, 404, '包体文件已丢失，请联系管理员');
        // 仅统计完整下载（非 Range 续传请求），避免重复计数
        if (!req.headers.range) store.incrementDownload(app.id);
        return serveFile(req, res, abs, {
          downloadName: app.package_file || `app-${app.id}.bin`,
          cache: 'no-store',
          extraHeaders: { 'Content-Type': 'application/octet-stream' }
        });
      }

      if (pathname === '/api/categories') {
        return json(res, 200, { ok: true, items: store.categories() });
      }

      if (pathname === '/api/stats') {
        return json(res, 200, { ok: true, ...store.publicStats() });
      }

      if (pathname === '/api/site') {
        return json(res, 200, { ok: true, siteName: config.siteName, slogan: config.siteSlogan });
      }

      if (pathname.startsWith('/api/')) return fail(res, 404, '接口不存在');

      // 前台与后台共用的设计层
      if (pathname.startsWith('/shared/')) {
        const abs = safeJoin(DIRS.shared, pathname.slice('/shared/'.length));
        if (!abs) return fail(res, 400, '非法路径');
        return serveFile(req, res, abs, { cache: 'public, max-age=3600' });
      }

      // 上传资源的公开只读访问（图标、截图）
      if (pathname.startsWith('/uploads/')) {
        const abs = safeJoin(DIRS.uploads, pathname.slice('/uploads/'.length));
        if (!abs) return fail(res, 400, '非法路径');
        // 包体不做公开直链，统一走下载接口统计
        if (abs.startsWith(DIRS.packages + path.sep)) return fail(res, 404, '文件不存在');
        return serveFile(req, res, abs, { cache: 'public, max-age=86400' });
      }

      // 应用详情页：/app/12 与 /app/12/xxx 都交给同一个页面，由前端读取 id
      if (/^\/app\/\d+/.test(pathname) || pathname === '/app') {
        return serveFile(req, res, path.join(DIRS.public, 'app.html'), { cache: 'no-cache' });
      }

      const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
      const abs = safeJoin(DIRS.public, rel);
      if (!abs) return fail(res, 400, '非法路径');
      return serveFile(req, res, abs, { cache: 'no-cache' });
    } catch (err) {
      return fail(res, 500, err?.message || '服务异常');
    }
  });
}