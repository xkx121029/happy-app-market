import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 常见文件类型的 MIME 映射表 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.apk': 'application/vnd.android.package-archive',
  '.ipa': 'application/octet-stream',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.dmg': 'application/x-apple-diskimage',
  '.zip': 'application/zip',
  '.txt': 'text/plain; charset=utf-8'
};

export function mimeOf(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/** 发送 JSON 响应 */
export function json(res, status, data) {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/** 发送纯文本错误 */
export function fail(res, status, message) {
  json(res, status, { ok: false, error: message });
}

/** 读取并解析 JSON 请求体 */
export function readJson(req, limitBytes = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** 将请求体作为二进制流写入目标文件，返回写入字节数 */
export function saveStream(req, destPath, maxBytes) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    let size = 0;
    let aborted = false;
    const cleanup = () => fs.promises.rm(destPath, { force: true }).catch(() => {});
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        aborted = true;
        req.destroy();
        out.destroy();
        cleanup().then(() => reject(new Error(`文件超过上限 ${Math.round(maxBytes / 1024 / 1024)} MB`)));
      }
    });
    req.on('error', (err) => {
      out.destroy();
      cleanup().then(() => reject(err));
    });
    out.on('error', (err) => {
      cleanup().then(() => reject(err));
    });
    out.on('close', () => {
      if (!aborted) resolve(size);
    });
    req.pipe(out);
  });
}

/** 从 URL 或请求头中还原原始文件名（前端用 encodeURIComponent 编码后放入 x-file-name） */
export function pickFileName(req, fallbackExt = '') {
  const raw = req.headers['x-file-name'];
  let name = '';
  if (raw) {
    try {
      name = decodeURIComponent(String(raw));
    } catch {
      name = String(raw);
    }
  }
  name = path.basename(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  if (!name) name = `file${fallbackExt}`;
  if (name.length > 120) {
    const ext = path.extname(name);
    name = name.slice(0, 100) + ext;
  }
  return name;
}

/** 生成不重复的存储文件名 */
export function uniqueName(originalName) {
  const ext = path.extname(originalName).toLowerCase() || '';
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}${ext}`;
}

/** 阻止路径穿越，把相对路径安全地拼到根目录下 */
export function safeJoin(rootDir, relative) {
  const target = path.resolve(rootDir, '.' + path.posix.normalize('/' + relative.replace(/\\/g, '/')));
  const root = path.resolve(rootDir);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

function contentDisposition(fileName) {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/** 提供文件下载/静态访问，支持 Range 断点续传 */
export async function serveFile(req, res, absPath, options = {}) {
  let stat;
  try {
    stat = await fs.promises.stat(absPath);
  } catch {
    return fail(res, 404, '文件不存在');
  }
  if (!stat.isFile()) return fail(res, 404, '文件不存在');

  const total = stat.size;
  const type = options.contentType || mimeOf(absPath);
  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': options.cache || 'public, max-age=3600',
    'Last-Modified': stat.mtime.toUTCString()
  };
  if (options.downloadName) headers['Content-Disposition'] = contentDisposition(options.downloadName);
  if (options.extraHeaders) Object.assign(headers, options.extraHeaders);

  const range = req.headers.range;
  if (range && /^bytes=/.test(range)) {
    const [startRaw, endRaw] = range.replace(/^bytes=/, '').split('-');
    let start = startRaw ? parseInt(startRaw, 10) : 0;
    let end = endRaw ? parseInt(endRaw, 10) : total - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      return res.end();
    }
    end = Math.min(end, total - 1);
    headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
    headers['Content-Length'] = end - start + 1;
    res.writeHead(206, headers);
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(absPath, { start, end }).pipe(res);
  }

  headers['Content-Length'] = total;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  return fs.createReadStream(absPath).pipe(res);
}

/** 规范化字符串字段 */
export function str(value, max = 4000) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\r\n/g, '\n').trim().slice(0, max);
}

/** 人类可读的体积文本 */
export function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let value = n;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}