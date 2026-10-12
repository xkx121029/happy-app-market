import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

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

/** 可以压缩传输的文本类型，二进制（包体、图片）一律不压 */
const COMPRESSIBLE = /^(text\/|application\/(?:json|javascript|xml|manifest)|image\/svg\+)/i;

/** 小于该体积不压缩，省下的字节抵不过压缩开销 */
const MIN_GZIP_BYTES = 1024;

/** 客户端是否接受 gzip 编码 */
function acceptsGzip(req) {
  return /\bgzip\b/i.test(String(req?.headers?.['accept-encoding'] || ''));
}

/** 用「体积 + 修改时间」生成协商缓存标记 */
function etagOf(stat) {
  return `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

/** 判断协商缓存是否命中：优先比对 If-None-Match，其次回落 If-Modified-Since */
function isFresh(req, etag, mtimeMs) {
  const inm = req.headers['if-none-match'];
  if (inm) {
    return String(inm)
      .split(',')
      .some((tag) => {
        const t = tag.trim();
        return t === '*' || t === etag || t === `W/${etag}`;
      });
  }
  const ims = req.headers['if-modified-since'];
  if (ims) {
    const since = Date.parse(String(ims));
    // HTTP 日期只有秒级精度，比较前先把修改时间截断到秒
    return Number.isFinite(since) && Math.floor(mtimeMs / 1000) * 1000 <= since;
  }
  return false;
}

/**
 * 发送 JSON 响应。
 * 体积超过阈值且客户端支持时改走 gzip，减少接口传输量。
 */
export function json(res, status, data) {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  const baseHeaders = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  };
  const req = res.req;
  if (body.length < MIN_GZIP_BYTES || !acceptsGzip(req)) {
    res.writeHead(status, { ...baseHeaders, 'Content-Length': body.length });
    return res.end(body);
  }
  return zlib.gzip(body, (err, gzipped) => {
    if (res.writableEnded || res.destroyed) return;
    if (err) {
      res.writeHead(status, { ...baseHeaders, 'Content-Length': body.length });
      return res.end(body);
    }
    res.writeHead(status, {
      ...baseHeaders,
      'Content-Encoding': 'gzip',
      'Content-Length': gzipped.length,
      Vary: 'Accept-Encoding'
    });
    res.end(gzipped);
  });
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

/** 提供文件下载/静态访问，支持 Range 断点续传、304 协商缓存与 gzip 压缩 */
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
  const etag = etagOf(stat);
  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': options.cache || 'public, max-age=3600',
    'Last-Modified': stat.mtime.toUTCString(),
    ETag: etag,
    Vary: 'Accept-Encoding'
  };
  if (options.downloadName) headers['Content-Disposition'] = contentDisposition(options.downloadName);
  if (options.extraHeaders) Object.assign(headers, options.extraHeaders);

  // 已有最新副本：直接回 304，不传正文
  if (isFresh(req, etag, stat.mtimeMs)) {
    res.writeHead(304, {
      ETag: etag,
      'Last-Modified': headers['Last-Modified'],
      'Cache-Control': headers['Cache-Control'],
      Vary: 'Accept-Encoding'
    });
    return res.end();
  }

  const range = req.headers.range;
  // 附件下载不压缩：同一文件两种编码会让 Range 续传的字节偏移失去参照
  const useGzip =
    !range &&
    !options.downloadName &&
    req.method === 'GET' &&
    total >= MIN_GZIP_BYTES &&
    COMPRESSIBLE.test(type) &&
    acceptsGzip(req);
  if (useGzip) {
    // 压缩后长度未知，交给 Node 走 chunked 传输
    headers['Content-Encoding'] = 'gzip';
    delete headers['Content-Length'];
  }

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
    return pipeOut(req, res, absPath, { start, end });
  }

  if (!useGzip) headers['Content-Length'] = total;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  return pipeOut(req, res, absPath, { gzip: useGzip });
}

/** 读文件流出到响应；gzip 时中间插入压缩流，客户端断开时同步释放文件流 */
function pipeOut(req, res, absPath, { start, end, gzip = false } = {}) {
  const source = fs.createReadStream(absPath, start === undefined ? undefined : { start, end });
  source.on('error', () => res.destroy());
  res.on('close', () => source.destroy());
  if (!gzip) return source.pipe(res);
  const compressor = zlib.createGzip({ level: zlib.constants.Z_DEFAULT_COMPRESSION });
  compressor.on('error', () => res.destroy());
  return source.pipe(compressor).pipe(res);
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