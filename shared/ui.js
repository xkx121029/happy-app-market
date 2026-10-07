/** 前台与后台共用的小工具：接口请求、格式化、DOM 片段 */

/** 统一的接口请求，失败时抛出可读中文错误 */
export async function api(path, options) {
  const res = await fetch(path, options);
  let data = null;
  try {
    data = await res.json();
  } catch {
    throw new Error(`服务返回异常（HTTP ${res.status}）`);
  }
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error || `请求失败（HTTP ${res.status}）`);
  }
  return data;
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[ch]);
}

/** 人类可读体积 */
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
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)}${units[i]}`;
}

export function formatCount(n) {
  const value = Number(n) || 0;
  if (value >= 10000) return `${(value / 10000).toFixed(1)}w`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

export function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 取应用名的首字，作为无图标时的占位 */
export function initialOf(name) {
  const text = String(name || '?').trim();
  return text ? Array.from(text)[0].toUpperCase() : '?';
}

/** 生成图标缩略图 DOM 片段 */
export function thumbHtml(app, className, fallbackSize) {
  if (app.icon) {
    return `<div class="thumb ${className}"><img src="${escapeHtml(app.icon)}" alt="" loading="lazy" /></div>`;
  }
  return `<div class="thumb ${className}"><span class="thumb__fallback" style="font-size:${fallbackSize}">${escapeHtml(
    initialOf(app.name)
  )}</span></div>`;
}

/** 骨架屏行 */
export function skeletonRows(count) {
  return Array.from({ length: count })
    .map(() => '<div class="skeleton"><i></i><i class="tall"></i><i></i><i></i><i></i><i></i><i></i></div>')
    .join('');
}

export function setText(selector, text) {
  document.querySelectorAll(selector).forEach((node) => {
    node.textContent = text;
  });
}

export function debounce(fn, delay = 260) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

/**
 * 上传文件：请求体直接是文件二进制，原始文件名放在 x-file-name 头里。
 * 用 XHR 以便拿到上传进度（大包体必需）。
 */
export function uploadFile(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name || 'file.bin'));
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    if (xhr.upload && onProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(event.loaded / event.total);
      };
    }
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        return reject(new Error(`服务返回异常（HTTP ${xhr.status}）`));
      }
      if (xhr.status >= 200 && xhr.status < 300 && data?.ok !== false) return resolve(data);
      reject(new Error(data?.error || `上传失败（HTTP ${xhr.status}）`));
    };
    xhr.onerror = () => reject(new Error('网络中断，上传未完成'));
    xhr.onabort = () => reject(new Error('上传已取消'));
    xhr.send(file);
  });
}