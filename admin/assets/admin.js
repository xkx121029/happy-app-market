import {
  api,
  escapeHtml,
  humanSize,
  formatCount,
  thumbHtml,
  uploadFile,
  initialOf,
  debounce
} from '/shared/ui.js';

const rowsEl = document.getElementById('rows');
const countEl = document.getElementById('board-count');
const qEl = document.getElementById('q');
const statusEl = document.getElementById('status-filter');
const createBtn = document.getElementById('create');
const modalRoot = document.getElementById('modal-root');
const toaster = document.getElementById('toaster');
const categoryList = document.getElementById('category-list');

const state = { q: '', status: '', items: [] };

/* 编辑态：currentApp 为已落库的记录，pending* 为待保存后上传的文件 */
let currentApp = null;
let pendingIcon = null;
let pendingShots = [];
let pendingPkg = null;
let overlayEl = null;

/* ============================== 提示与确认 ============================== */

function toast(message, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  el.innerHTML = `<div><b>${kind === 'err' ? '操作失败' : '操作完成'}</b>${escapeHtml(message)}</div>`;
  toaster.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(10px)';
    setTimeout(() => el.remove(), 320);
  }, kind === 'err' ? 4200 : 2400);
}

function confirmDialog({ title, body, confirmText = '确认', danger = false }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'overlay overlay--dialog';
    wrap.innerHTML = `
      <div class="panel panel--sm" role="alertdialog" aria-modal="true">
        <div class="dialog__body">
          <h3>${escapeHtml(title)}</h3>
          <p>${escapeHtml(body)}</p>
        </div>
        <div class="dialog__foot">
          <button class="btn btn--sm" type="button" data-act="no">取消</button>
          <button class="btn btn--sm ${danger ? 'btn--accent' : 'btn--solid'}" type="button" data-act="yes">${escapeHtml(
            confirmText
          )}</button>
        </div>
      </div>`;
    const done = (value) => {
      document.removeEventListener('keydown', onKey);
      wrap.remove();
      resolve(value);
    };
    function onKey(event) {
      if (event.key === 'Escape') done(false);
    }
    wrap.addEventListener('click', (event) => {
      if (event.target === wrap) return done(false);
      const act = event.target.closest('[data-act]')?.dataset.act;
      if (act === 'yes') done(true);
      if (act === 'no') done(false);
    });
    document.addEventListener('keydown', onKey);
    modalRoot.appendChild(wrap);
  });
}

/* ============================== 数据加载 ============================== */

async function loadOverview() {
  try {
    const data = await api('/api/overview');
    for (const [key, value] of Object.entries(data.stats)) {
      const node = document.querySelector(`[data-stat="${key}"]`);
      if (node) node.textContent = formatCount(value);
    }
    categoryList.innerHTML = data.categories
      .map((item) => `<option value="${escapeHtml(item.name)}"></option>`)
      .join('');

    const host = location.hostname;
    document.getElementById('rail-public').textContent = `${host}:${data.ports.public}`;
    document.getElementById('rail-admin').textContent = `${host}:${data.ports.admin}`;
    document.title = `管理台 · ${data.siteName}`;
  } catch (err) {
    toast(`概览加载失败：${err.message}`, 'err');
  }
}

function rowHtml(app, index) {
  const num = String(index + 1).padStart(2, '0');
  const statusStamp = app.status
    ? '<span class="stamp stamp--ok">已上架</span>'
    : '<span class="stamp stamp--warn">未上架</span>';
  const pkgHint = app.hasPackage
    ? escapeHtml(app.package_file || '已上传包体')
    : '尚未上传包体';
  return `
    <div class="row" data-id="${app.id}">
      <span class="row__num">${num}</span>
      <span class="row__app">
        ${thumbHtml(app, 'row__icon', '1rem')}
        <span style="min-width:0">
          <span class="row__name">${escapeHtml(app.name)}</span>
          <span class="row__pkg">${pkgHint}</span>
        </span>
      </span>
      <span class="row__cell col-hide">${escapeHtml(app.category || '未分类')}</span>
      <span class="row__cell col-hide">${app.version ? 'v' + escapeHtml(app.version) : '—'}</span>
      <span class="row__cell col-hide">${humanSize(app.package_size)}</span>
      <span class="row__status">${statusStamp}</span>
      <span class="row__cell col-hide">${formatCount(app.downloads)}</span>
      <span class="row__ops">
        <button class="btn btn--quiet" type="button" data-op="edit">编辑</button>
        <button class="btn btn--quiet" type="button" data-op="toggle">${app.status ? '下架' : '上架'}</button>
        <button class="btn btn--quiet btn--ghost-danger" type="button" data-op="delete">删除</button>
      </span>
    </div>`;
}

function renderRows() {
  if (!state.items.length) {
    rowsEl.innerHTML = `
      <div class="empty" style="margin:20px 0">
        <span class="empty__mark">空</span>
        <p>还没有符合条件的应用。<br />点击右上角「新建应用」开始上架第一款。</p>
      </div>`;
  } else {
    rowsEl.innerHTML = state.items.map(rowHtml).join('');
  }
  const published = state.items.filter((item) => item.status).length;
  countEl.textContent = `当前视图 ${state.items.length} 条 · 已上架 ${published} 条`;
}

async function loadApps() {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.status !== '') params.set('status', state.status);
  try {
    const data = await api(`/api/apps?${params}`);
    state.items = data.items;
    renderRows();
  } catch (err) {
    rowsEl.innerHTML = `<div class="empty" style="margin:20px 0"><span class="empty__mark">!</span><p>${escapeHtml(
      err.message
    )}</p></div>`;
    countEl.textContent = '载入失败';
  }
}

function findApp(id) {
  return state.items.find((item) => String(item.id) === String(id));
}

/* ============================== 编辑器 ============================== */

const val = (selector) => overlayEl.querySelector(selector).value;
const setProgress = (text) => {
  const node = overlayEl.querySelector('#upload-progress');
  if (node) node.textContent = text;
};

function iconSlot() {
  const slot = overlayEl.querySelector('#icon-slot');
  const preview = currentApp?.icon
    ? `<div class="upload__preview thumb"><img src="${escapeHtml(currentApp.icon)}" alt="" /></div>`
    : `<div class="upload__preview thumb"><span class="thumb__fallback">${escapeHtml(
        initialOf(currentApp?.name || val('#f-name') || '新')
      )}</span></div>`;

  let info;
  if (pendingIcon) {
    info = `<div class="upload__name">${escapeHtml(pendingIcon.name)}</div><div class="upload__meta">${humanSize(
      pendingIcon.size
    )} · 保存后自动上传</div>`;
  } else if (currentApp?.icon) {
    info = `<div class="upload__name">已设置图标</div><div class="upload__meta">${escapeHtml(
      currentApp.icon.split('/').pop()
    )}</div>`;
  } else {
    info = '<div class="upload__name">尚未设置图标</div><div class="upload__meta">建议 1:1 正方形 · PNG / JPG / WEBP</div>';
  }

  const hasOne = Boolean(currentApp?.icon || pendingIcon);
  slot.innerHTML = `${preview}
    <div class="upload__info">${info}</div>
    <div class="upload__ops">
      <button class="btn btn--quiet" type="button" data-act="pick-icon">${hasOne ? '替换' : '选择图片'}</button>
      ${hasOne ? '<button class="btn btn--quiet" type="button" data-act="clear-icon">移除</button>' : ''}
    </div>`;
}

function shotSlot() {
  const slot = overlayEl.querySelector('#shot-slot');
  const existing = currentApp?.screenshots || [];
  const items = [
    ...existing.map(
      (url) => `
      <div class="shotgrid__item" data-url="${escapeHtml(url)}">
        <img src="${escapeHtml(url)}" alt="" loading="lazy" />
        <button class="shotgrid__del" type="button" data-act="del-shot" title="删除截图">✕</button>
      </div>`
    ),
    ...pendingShots.map(
      (file, index) => `
      <div class="shotgrid__item" data-pending="${index}">
        <img src="${URL.createObjectURL(file)}" alt="" />
        <button class="shotgrid__del" type="button" data-act="del-pending-shot" title="移除">✕</button>
        <span class="stamp" style="position:absolute;left:4px;bottom:4px;background:var(--paper-card)">待上传</span>
      </div>`
    )
  ];
  slot.innerHTML =
    items.join('') +
    `<button class="shotgrid__add" type="button" data-act="pick-shots"><b>＋</b>添加截图</button>`;
}

function pkgSlot() {
  const slot = overlayEl.querySelector('#pkg-slot');
  const name = pendingPkg ? pendingPkg.name : currentApp?.package_file || '';
  const size = pendingPkg ? pendingPkg.size : currentApp?.package_size || 0;

  const info = name
    ? `<div class="upload__name">${escapeHtml(name)}</div><div class="upload__meta">${
        size ? humanSize(size) : '大小未知'
      }${pendingPkg ? ' · 保存后自动上传' : ' · 已上架供下载'}</div>`
    : '<div class="upload__name">尚未上传包体</div><div class="upload__meta">支持 APK / IPA / EXE / ZIP 等任意格式</div>';

  slot.innerHTML = `
    <div class="upload__info">${info}</div>
    <div class="upload__ops">
      <button class="btn btn--quiet" type="button" data-act="pick-pkg">${name ? '替换包体' : '选择包体'}</button>
      ${name ? '<button class="btn btn--quiet" type="button" data-act="clear-pkg">移除</button>' : ''}
    </div>`;
}

function pickFiles({ accept, multiple, onDone }) {
  const input = document.createElement('input');
  input.type = 'file';
  if (accept) input.accept = accept;
  input.multiple = Boolean(multiple);
  input.addEventListener('change', () => {
    const files = Array.from(input.files || []);
    if (files.length) onDone(files);
  });
  input.click();
}

async function putMeta(patch) {
  const data = await api(`/api/apps/${currentApp.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch)
  });
  currentApp = data.app;
  return currentApp;
}

async function handleIcon(files) {
  const file = files[0];
  if (!currentApp) {
    pendingIcon = file;
    iconSlot();
    return;
  }
  try {
    setProgress('正在上传图标…');
    const data = await uploadFile(`/api/apps/${currentApp.id}/icon`, file, (p) =>
      setProgress(`正在上传图标… ${Math.round(p * 100)}%`)
    );
    currentApp = data.app;
    setProgress('');
    iconSlot();
    toast('图标已更新');
  } catch (err) {
    setProgress('');
    toast(err.message, 'err');
  }
}

async function clearIcon() {
  if (!currentApp) {
    pendingIcon = null;
    return iconSlot();
  }
  try {
    await putMeta({ icon: '' });
    iconSlot();
    toast('图标已移除');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function handleShots(files) {
  if (!currentApp) {
    pendingShots.push(...files);
    return shotSlot();
  }
  for (const file of files) {
    try {
      setProgress(`正在上传截图 ${file.name}…`);
      const data = await uploadFile(`/api/apps/${currentApp.id}/screenshots`, file, (p) =>
        setProgress(`正在上传截图… ${Math.round(p * 100)}%`)
      );
      currentApp = data.app;
    } catch (err) {
      toast(err.message, 'err');
    }
  }
  setProgress('');
  shotSlot();
  toast('截图已更新');
}

async function handlePkg(files) {
  const file = files[0];
  if (!currentApp) {
    pendingPkg = file;
    pkgSlot();
    return;
  }
  try {
    const button = overlayEl.querySelector('[data-act="pick-pkg"]');
    if (button) button.classList.add('busy');
    const data = await uploadFile(`/api/apps/${currentApp.id}/package`, file, (p) =>
      setProgress(`正在上传包体… ${Math.round(p * 100)}%`)
    );
    currentApp = data.app;
    if (button) button.classList.remove('busy');
    setProgress('');
    pkgSlot();
    toast('包体已更新');
  } catch (err) {
    const button = overlayEl.querySelector('[data-act="pick-pkg"]');
    if (button) button.classList.remove('busy');
    setProgress('');
    toast(err.message, 'err');
  }
}

function closeEditor() {
  overlayEl?.remove();
  overlayEl = null;
  currentApp = null;
  pendingIcon = null;
  pendingShots = [];
  pendingPkg = null;
}

async function saveEditor() {
  const name = val('#f-name').trim();
  if (!name) {
    toast('应用名是必填项', 'err');
    overlayEl.querySelector('#f-name').focus();
    return;
  }

  const payload = {
    name,
    package_name: val('#f-package').trim(),
    version: val('#f-version').trim(),
    developer: val('#f-developer').trim(),
    category: val('#f-category').trim(),
    summary: val('#f-summary').trim(),
    description: val('#f-desc')
  };

  const saveBtn = overlayEl.querySelector('[data-act="save"]');
  saveBtn.disabled = true;
  const isNew = !currentApp;

  try {
    if (isNew) {
      const created = await api('/api/apps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      currentApp = created.app;
    } else {
      await putMeta(payload);
    }

    if (pendingIcon) {
      setProgress('正在上传图标…');
      const data = await uploadFile(`/api/apps/${currentApp.id}/icon`, pendingIcon);
      currentApp = data.app;
      pendingIcon = null;
    }
    for (const file of pendingShots) {
      setProgress(`正在上传截图 ${file.name}…`);
      const data = await uploadFile(`/api/apps/${currentApp.id}/screenshots`, file);
      currentApp = data.app;
    }
    pendingShots = [];
    if (pendingPkg) {
      setProgress('正在上传包体…');
      const data = await uploadFile(`/api/apps/${currentApp.id}/package`, pendingPkg, (p) =>
        setProgress(`正在上传包体… ${Math.round(p * 100)}%`)
      );
      currentApp = data.app;
      pendingPkg = null;
    }
    setProgress('');

    const wantPublish = overlayEl.querySelector('#f-publish').checked;
    if (wantPublish) {
      if (!currentApp.hasPackage) {
        toast('未上传包体，已保存为「未上架」', 'err');
      } else {
        await api(`/api/apps/${currentApp.id}/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 1 })
        });
      }
    }

    toast(isNew ? `已新建「${name}」` : `已保存「${name}」`);
    closeEditor();
    await Promise.all([loadOverview(), loadApps()]);
  } catch (err) {
    saveBtn.disabled = false;
    setProgress('');
    toast(err.message, 'err');
  }
}

function openEditor(app) {
  currentApp = app ? { ...app } : null;
  pendingIcon = null;
  pendingShots = [];
  pendingPkg = null;
  const isNew = !currentApp;

  const wrap = document.createElement('div');
  wrap.className = 'overlay';
  wrap.innerHTML = `
    <div class="panel" role="dialog" aria-modal="true">
      <header class="panel__head">
        <h2>${isNew ? '新建应用' : '编辑应用'}</h2>
        <span>${isNew ? 'NEW RECORD' : `ID ${currentApp.id} · 创建于 ${escapeHtml(
          (currentApp.created_at || '').slice(0, 10)
        )}`}</span>
        <button class="iconbtn" type="button" data-act="close" aria-label="关闭">✕</button>
      </header>
      <div class="panel__body">
        <p class="fieldset-title">基本信息</p>
        <div class="field">
          <label for="f-name">应用名 <b>*</b></label>
          <input id="f-name" type="text" maxlength="120" placeholder="例如：开心笔记" value="${escapeHtml(
            currentApp?.name || ''
          )}" />
        </div>
        <div class="grid2">
          <div class="field">
            <label for="f-package">包名</label>
            <input id="f-package" type="text" placeholder="com.example.app" value="${escapeHtml(
              currentApp?.package_name || ''
            )}" />
          </div>
          <div class="field">
            <label for="f-version">版本号</label>
            <input id="f-version" type="text" placeholder="1.0.0" value="${escapeHtml(
              currentApp?.version || ''
            )}" />
          </div>
        </div>
        <div class="grid2">
          <div class="field">
            <label for="f-developer">开发者</label>
            <input id="f-developer" type="text" placeholder="开发者或团队名称" value="${escapeHtml(
              currentApp?.developer || ''
            )}" />
          </div>
          <div class="field">
            <label for="f-category">分类</label>
            <input id="f-category" type="text" list="category-list" placeholder="工具 / 影音 / 办公…" value="${escapeHtml(
              currentApp?.category || ''
            )}" />
          </div>
        </div>
        <div class="field">
          <label for="f-summary">一句话简介</label>
          <input id="f-summary" type="text" maxlength="300" placeholder="出现在列表与详情页顶部" value="${escapeHtml(
            currentApp?.summary || ''
          )}" />
        </div>
        <div class="field">
          <label for="f-desc">应用介绍</label>
          <textarea id="f-desc" placeholder="支持换行，前台会按原样排版">${escapeHtml(
            currentApp?.description || ''
          )}</textarea>
        </div>

        <p class="fieldset-title">应用图标</p>
        <div class="upload" id="icon-slot"></div>

        <p class="fieldset-title">应用截图</p>
        <div class="shotgrid" id="shot-slot"></div>

        <p class="fieldset-title">应用包体</p>
        <div class="upload" id="pkg-slot"></div>
        <p class="field__hint" id="upload-progress"></p>
      </div>
      <footer class="panel__foot">
        <button class="btn btn--ghost-danger" type="button" data-act="close">取消</button>
        <span class="spacer"></span>
        <label class="stamp" style="cursor:pointer;gap:8px">
          <input type="checkbox" id="f-publish" /> 保存后立即上架
        </label>
        <button class="btn btn--accent" type="button" data-act="save">保存</button>
      </footer>
    </div>`;

  overlayEl = wrap;
  modalRoot.appendChild(wrap);
  iconSlot();
  shotSlot();
  pkgSlot();

  wrap.addEventListener('click', async (event) => {
    if (event.target === wrap) return closeEditor();
    const target = event.target.closest('[data-act]');
    if (!target) return;
    const act = target.dataset.act;

    if (act === 'close') return closeEditor();
    if (act === 'save') return saveEditor();
    if (act === 'pick-icon') return pickFiles({ accept: 'image/*', onDone: handleIcon });
    if (act === 'clear-icon') return clearIcon();
    if (act === 'pick-shots') return pickFiles({ accept: 'image/*', multiple: true, onDone: handleShots });
    if (act === 'pick-pkg') return pickFiles({ onDone: handlePkg });

    if (act === 'clear-pkg') {
      if (!currentApp) {
        pendingPkg = null;
        return pkgSlot();
      }
      try {
        const data = await api(`/api/apps/${currentApp.id}/package`, { method: 'DELETE' });
        currentApp = data.app;
        pkgSlot();
        toast('包体已移除');
      } catch (err) {
        toast(err.message, 'err');
      }
      return;
    }

    if (act === 'del-shot') {
      const url = target.closest('.shotgrid__item').dataset.url;
      try {
        const data = await api(`/api/apps/${currentApp.id}/screenshots`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url })
        });
        currentApp = data.app;
        shotSlot();
      } catch (err) {
        toast(err.message, 'err');
      }
      return;
    }

    if (act === 'del-pending-shot') {
      const index = Number(target.closest('.shotgrid__item').dataset.pending);
      pendingShots.splice(index, 1);
      shotSlot();
    }
  });

  wrap.querySelector('#f-name').focus();
}

/* ============================== 行操作 ============================== */

async function toggleStatus(app) {
  if (!app.status && !app.hasPackage) {
    toast('该应用还没有上传包体，无法上架', 'err');
    return;
  }
  try {
    await api(`/api/apps/${app.id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: app.status ? 0 : 1 })
    });
    toast(app.status ? `已下架「${app.name}」` : `已上架「${app.name}」`);
    await Promise.all([loadOverview(), loadApps()]);
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function removeApp(app) {
  const ok = await confirmDialog({
    title: `删除「${app.name}」？`,
    body: '该应用的图标、截图与包体文件会一并从磁盘删除，且无法恢复。',
    confirmText: '永久删除',
    danger: true
  });
  if (!ok) return;
  try {
    await api(`/api/apps/${app.id}`, { method: 'DELETE' });
    toast(`已删除「${app.name}」`);
    await Promise.all([loadOverview(), loadApps()]);
  } catch (err) {
    toast(err.message, 'err');
  }
}

rowsEl.addEventListener('click', (event) => {
  const button = event.target.closest('[data-op]');
  if (!button) return;
  const app = findApp(button.closest('.row').dataset.id);
  if (!app) return;
  const op = button.dataset.op;
  if (op === 'edit') openEditor(app);
  if (op === 'toggle') toggleStatus(app);
  if (op === 'delete') removeApp(app);
});

createBtn.addEventListener('click', () => openEditor(null));

qEl.addEventListener(
  'input',
  debounce(() => {
    state.q = qEl.value.trim();
    loadApps();
  })
);

statusEl.addEventListener('change', () => {
  state.status = statusEl.value;
  loadApps();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && overlayEl) closeEditor();
});

loadOverview();
loadApps();