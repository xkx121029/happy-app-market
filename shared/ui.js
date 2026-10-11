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

/**
 * 首屏标题允许两种轻量写法：回车换行、用 *星号* 包住要强调的词。
 * 其余内容一律先转义，避免自定义文案把标签带进页面。
 */
export function heroTitleHtml(raw) {
  return escapeHtml(raw)
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br />');
}

/** 把后台保存的站点设置应用到当前页面 */
export function applySiteSettings(site = {}) {
  if (site.accentColor) accentBase = site.accentColor;
  applyAccent();
  setText('[data-site-name]', site.siteName || '');
  setText('[data-site-slogan]', site.slogan || '');
  setText('[data-hero-kicker]', site.heroKicker || '');
  setText('[data-hero-sub]', site.heroSubtitle || '');
  setText('[data-stat-apps-label]', site.statAppsLabel || '');
  setText('[data-stat-downloads-label]', site.statDownloadsLabel || '');
  setText('[data-footer-note]', site.footerNote || '');
  const title = document.querySelector('[data-hero-title]');
  if (title) title.innerHTML = heroTitleHtml(site.heroTitle || '');
}

/* ============================== 明暗主题 ============================== */

const THEME_KEY = 'kx-theme';
let accentBase = '#2f6f9f';

function clampByte(n) {
  return Math.max(0, Math.min(255, Math.round(n)));
}

/** 把颜色朝白（amount>0）或黑（amount<0）方向混合，amount 取 0~1 */
function shiftHex(hex, amount) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!match) return hex;
  const n = parseInt(match[1], 16);
  const to = amount >= 0 ? 255 : 0;
  const k = Math.abs(amount);
  const mix = (channel) => clampByte(channel + (to - channel) * k);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

export function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

/** 依据当前主题把强调色写到根节点；深色下自动提亮，保证可读 */
export function applyAccent() {
  const dark = currentTheme() === 'dark';
  const accent = dark ? shiftHex(accentBase, 0.32) : accentBase;
  document.documentElement.style.setProperty('--accent', accent);
}

export function setTheme(theme) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* 隐私模式下忽略写入失败 */
  }
  applyAccent();
  return next;
}

export function toggleTheme() {
  return setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
}

/** 页面启动时同步一次；首次访问跟随系统偏好 */
export function initTheme() {
  let stored = null;
  try {
    stored = localStorage.getItem(THEME_KEY);
  } catch {
    /* 忽略 */
  }
  if (!stored) {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = prefersDark ? 'dark' : 'light';
  }
  applyAccent();
  return currentTheme();
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