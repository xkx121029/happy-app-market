import {
  api,
  thumbHtml,
  humanSize,
  formatCount,
  formatDate,
  escapeHtml,
  skeletonRows,
  setText,
  debounce
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

document.getElementById('build-stamp').textContent =
  `BUILD ${new Date().toISOString().slice(0, 10).replace(/-/g, '.')}`;

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

  setText('[data-site-name]', site.siteName);
  document.title = site.siteName;
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
loadMeta().then(() => {
  sortbarEl.querySelectorAll('button').forEach((node) => {
    node.setAttribute('aria-pressed', String(node.dataset.sort === state.sort));
  });
});
loadApps();