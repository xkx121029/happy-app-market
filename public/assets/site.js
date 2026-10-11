import {
  api,
  thumbHtml,
  humanSize,
  formatCount,
  formatDate,
  escapeHtml,
  skeletonRows,
  setText,
  applySiteSettings,
  debounce,
  initTheme,
  toggleTheme
} from '/shared/ui.js';

const state = { q: '', category: '', sort: 'latest', page: 1, pageSize: 12 };

const entriesEl = document.getElementById('entries');
const chipsEl = document.getElementById('chips');
const countEl = document.getElementById('catalog-count');
const pagerEl = document.getElementById('pager');
const pageInfoEl = document.getElementById('pageinfo');
const prevBtn = document.getElementById('prev');
const nextBtn = document.getElementById('next');
const inputEl = document.getElementById('q');
const sortbarEl = document.getElementById('sortbar');
const suggestEl = document.getElementById('suggest');

document.getElementById('build-stamp').textContent =
  `BUILD ${new Date().toISOString().slice(0, 10).replace(/-/g, '.')}`;

// 明暗主题：内联脚本已先行设置 data-theme，这里只负责补强调色与绑定切换
initTheme();
document.getElementById('theme-toggle')?.addEventListener('click', () => toggleTheme());

/** 读取 URL 参数作为初始筛选条件，便于分享链接 */
function readUrl() {
  const params = new URLSearchParams(location.search);
  state.q = params.get('q') || '';
  state.category = params.get('category') || '';
  state.sort = params.get('sort') || 'latest';
  state.page = Math.max(1, Number(params.get('page')) || 1);
  inputEl.value = state.q;
}

function writeUrl() {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.category) params.set('category', state.category);
  if (state.sort !== 'latest') params.set('sort', state.sort);
  if (state.page > 1) params.set('page', String(state.page));
  const query = params.toString();
  history.replaceState(null, '', query ? `/?${query}` : '/');
}

async function loadMeta() {
  const [site, stats, cats] = await Promise.all([
    api('/api/site'),
    api('/api/stats'),
    api('/api/categories')
  ]);

  applySiteSettings(site);
  document.title = site.siteName;
  state.pageSize = Number(site.pageSize) || state.pageSize;
  setText('[data-stat-total]', formatCount(stats.total));
  setText('[data-stat-downloads]', formatCount(stats.downloads));

  const all = [{ name: '', label: '全部', count: stats.total }, ...cats.items.map((c) => ({
    name: c.name,
    label: c.name,
    count: c.count
  }))];
  chipsEl.innerHTML = all
    .map(
      (item) => `
      <button class="chip" type="button" data-category="${escapeHtml(item.name)}"
        aria-pressed="${item.name === state.category}">
        ${escapeHtml(item.label)}<sup>${item.count}</sup>
      </button>`
    )
    .join('');
}

function entryHtml(app, index) {
  const offset = (state.page - 1) * state.pageSize;
  const num = String(offset + index + 1).padStart(2, '0');
  return `
    <a class="entry rise" style="--i:${Math.min(index, 11)}" href="/app/${app.id}">
      <span class="entry__num">${num}</span>
      <span class="entry__main">
        ${thumbHtml(app, 'entry__icon', '1.1rem')}
        <span class="entry__text">
          <span class="entry__name">${escapeHtml(app.name)}${
            app.version ? `<span class="stamp">v${escapeHtml(app.version)}</span>` : ''
          }</span>
          <span class="entry__summary">${escapeHtml(app.summary || app.developer || '暂无简介')}</span>
        </span>
      </span>
      <span class="entry__meta col-cat">${escapeHtml(app.category || '未分类')}</span>
      <span class="entry__meta col-ver">${app.version ? 'v' + escapeHtml(app.version) : '—'}</span>
      <span class="entry__meta col-size">${humanSize(app.package_size)}</span>
      <span class="entry__meta col-dl">${formatCount(app.downloads)} 次</span>
      <span class="entry__go">${
        app.hasPackage ? '查看并下载' : '查看详情'
      }<span aria-hidden="true">▸</span></span>
    </a>`;
}

async function loadApps() {
  entriesEl.innerHTML = skeletonRows(6);
  try {
    const data = await api(
      `/api/apps?${new URLSearchParams({
        q: state.q,
        category: state.category,
        sort: state.sort,
        page: String(state.page),
        pageSize: String(state.pageSize)
      })}`
    );

    const pages = Math.max(1, Math.ceil(data.total / state.pageSize));
    if (state.page > pages) {
      state.page = pages;
      return loadApps();
    }

    if (!data.items.length) {
      entriesEl.innerHTML = `
        <div class="empty">
          <span class="empty__mark">空</span>
          <p>没有找到符合条件的应用。<br />换个关键词，或清空分类筛选再试一次。</p>
        </div>`;
    } else {
      entriesEl.innerHTML = data.items.map(entryHtml).join('');
    }

    countEl.textContent = state.q || state.category
      ? `筛选出 ${data.total} 款 · 第 ${state.page}/${pages} 页`
      : `共 ${data.total} 款在架应用`;

    pagerEl.hidden = pages <= 1;
    pageInfoEl.textContent = `${state.page} / ${pages}`;
    prevBtn.disabled = state.page <= 1;
    nextBtn.disabled = state.page >= pages;
  } catch (err) {
    entriesEl.innerHTML = `
      <div class="empty">
        <span class="empty__mark">!</span>
        <p>${escapeHtml(err.message)}</p>
      </div>`;
    countEl.textContent = '载入失败';
    pagerEl.hidden = true;
  }
}

/** 全部重载入口 */
function refresh() {
  writeUrl();
  loadApps();
}

chipsEl.addEventListener('click', (event) => {
  const chip = event.target.closest('.chip');
  if (!chip) return;
  state.category = chip.dataset.category;
  state.page = 1;
  chipsEl.querySelectorAll('.chip').forEach((node) => {
    node.setAttribute('aria-pressed', String(node.dataset.category === state.category));
  });
  refresh();
});

inputEl.addEventListener(
  'input',
  debounce(() => {
    state.q = inputEl.value.trim();
    state.page = 1;
    refresh();
  })
);

/* ============================== 搜索联想与快捷键 ============================== */

let suggestItems = [];
let activeIndex = -1;

function closeSuggest() {
  suggestEl.hidden = true;
  suggestEl.innerHTML = '';
  inputEl.setAttribute('aria-expanded', 'false');
  suggestItems = [];
  activeIndex = -1;
}

function renderSuggest(items) {
  if (!items.length) {
    suggestEl.innerHTML = '<p class="suggest__empty">没有匹配的应用</p>';
  } else {
    suggestEl.innerHTML = items
      .map(
        (app, index) => `
        <button class="suggest__item" type="button" role="option" data-id="${app.id}" data-index="${index}">
          <span class="suggest__name">${escapeHtml(app.name)}</span>
          <span class="suggest__meta">${escapeHtml(app.category || '未分类')}${
            app.version ? ' · v' + escapeHtml(app.version) : ''
          }</span>
        </button>`
      )
      .join('');
  }
  suggestEl.hidden = false;
  inputEl.setAttribute('aria-expanded', 'true');
  suggestItems = items;
  activeIndex = -1;
}

function highlight(next) {
  const nodes = suggestEl.querySelectorAll('.suggest__item');
  if (!nodes.length) return;
  activeIndex = (next + nodes.length) % nodes.length;
  nodes.forEach((node, index) => node.classList.toggle('is-active', index === activeIndex));
  nodes[activeIndex].scrollIntoView({ block: 'nearest' });
}

const fetchSuggest = debounce(async () => {
  const q = inputEl.value.trim();
  if (!q) return closeSuggest();
  try {
    const data = await api(`/api/apps?${new URLSearchParams({ q, pageSize: '6', sort: 'downloads' })}`);
    if (inputEl.value.trim() !== q) return; // 请求期间输入已变，丢弃旧结果
    renderSuggest(data.items);
  } catch {
    closeSuggest();
  }
}, 180);

inputEl.addEventListener('input', fetchSuggest);

inputEl.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' && !suggestEl.hidden) {
    event.preventDefault();
    highlight(activeIndex + 1);
  } else if (event.key === 'ArrowUp' && !suggestEl.hidden) {
    event.preventDefault();
    highlight(activeIndex - 1);
  } else if (event.key === 'Enter' && activeIndex >= 0 && suggestItems[activeIndex]) {
    event.preventDefault();
    location.href = `/app/${suggestItems[activeIndex].id}`;
  } else if (event.key === 'Escape') {
    if (inputEl.value) {
      inputEl.value = '';
      state.q = '';
      state.page = 1;
      refresh();
    }
    closeSuggest();
  }
});

// 用 mousedown 而非 click，避免输入框先失焦导致候选框提前关闭
suggestEl.addEventListener('mousedown', (event) => {
  const item = event.target.closest('.suggest__item');
  if (!item) return;
  event.preventDefault();
  location.href = `/app/${item.dataset.id}`;
});

document.addEventListener('mousedown', (event) => {
  if (!event.target.closest('.searchbar__box')) closeSuggest();
});

// 按 / 聚焦搜索框（正在输入时不触发）
document.addEventListener('keydown', (event) => {
  if (event.key !== '/') return;
  const tag = (event.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || event.target.isContentEditable) return;
  event.preventDefault();
  inputEl.focus();
  inputEl.select();
});

sortbarEl.addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-sort]');
  if (!btn) return;
  state.sort = btn.dataset.sort;
  state.page = 1;
  sortbarEl.querySelectorAll('button').forEach((node) => {
    node.setAttribute('aria-pressed', String(node.dataset.sort === state.sort));
  });
  refresh();
});

prevBtn.addEventListener('click', () => {
  if (state.page <= 1) return;
  state.page -= 1;
  refresh();
  window.scrollTo({ top: document.querySelector('.catalog').offsetTop - 70, behavior: 'smooth' });
});

nextBtn.addEventListener('click', () => {
  state.page += 1;
  refresh();
  window.scrollTo({ top: document.querySelector('.catalog').offsetTop - 70, behavior: 'smooth' });
});

readUrl();
loadMeta()
  .catch(() => {
    /* 站点信息拿不到也照常展示列表 */
  })
  .finally(() => {
    sortbarEl.querySelectorAll('button').forEach((node) => {
      node.setAttribute('aria-pressed', String(node.dataset.sort === state.sort));
    });
    loadApps();
  });