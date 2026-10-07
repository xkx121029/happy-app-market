import {
  api,
  escapeHtml,
  thumbHtml,
  humanSize,
  formatCount,
  formatDate,
  setText
} from '/shared/ui.js';

const root = document.getElementById('sheet-root');
document.getElementById('build-stamp').textContent =
  `BUILD ${new Date().toISOString().slice(0, 10).replace(/-/g, '.')}`;

const id = (location.pathname.match(/\/app\/(\d+)/) || [])[1];

function specRow(label, value) {
  return `<div class="spec__row"><dt>${label}</dt><dd>${escapeHtml(value || '—')}</dd></div>`;
}

function render(app) {
  const shots = app.screenshots || [];
  const desc = (app.description || '').trim();

  root.innerHTML = `
    <div class="sheet">
      <aside class="sheet__card rise" style="--i:0">
        ${thumbHtml(app, 'sheet__icon', '2.4rem')}
        <h1 class="sheet__name">${escapeHtml(app.name)}</h1>
        <p class="sheet__dev">${escapeHtml(app.developer || '未标注开发者')}</p>

        <dl class="spec">
          ${specRow('分类', app.category || '未分类')}
          ${specRow('版本', app.version ? 'v' + app.version : '—')}
          ${specRow('包体大小', humanSize(app.package_size))}
          ${specRow('累计下载', `${formatCount(app.downloads)} 次`)}
          ${specRow('更新时间', formatDate(app.updated_at))}
          ${app.package_name ? specRow('包名', app.package_name) : ''}
        </dl>

        <div class="sheet__actions">
          ${
            app.hasPackage
              ? `<a class="btn btn--accent btn--block" href="/api/apps/${app.id}/download">下载安装包<span aria-hidden="true">▾</span></a>`
              : `<button class="btn btn--block" type="button" disabled>暂未提供包体</button>`
          }
          <a class="btn btn--block" href="/"><span aria-hidden="true">◂</span> 浏览其他应用</a>
        </div>
        <p class="sheet__note">${
          app.hasPackage
            ? `下载文件名：${escapeHtml(app.package_file || '安装包')}`
            : '管理员尚未上架该应用的安装包。'
        }</p>
      </aside>

      <section class="sheet__main">
        <p class="lede rise" style="--i:1">${escapeHtml(
          app.summary || '这款应用还没有填写一句话简介。'
        )}</p>

        <div class="section rise" style="--i:2">
          <h2 class="section__title">应用介绍<sup>01</sup></h2>
          <div class="prose">${
            desc ? escapeHtml(desc) : '管理员尚未填写详细的应用介绍。'
          }</div>
        </div>

        <div class="section rise" style="--i:3">
          <h2 class="section__title">应用截图<sup>02</sup> <span style="color:var(--ink-faint);letter-spacing:.14em">${shots.length} 张</span></h2>
          ${
            shots.length
              ? `<div class="shots">${shots
                  .map(
                    (src, index) => `
                <figure>
                  <img src="${escapeHtml(src)}" alt="${escapeHtml(app.name)} 截图 ${index + 1}" loading="lazy" />
                  <figcaption>FIG. ${String(index + 1).padStart(2, '0')}</figcaption>
                </figure>`
                  )
                  .join('')}</div>`
              : `<div class="empty"><span class="empty__mark">无</span><p>该应用暂无截图。</p></div>`
          }
        </div>
      </section>
    </div>`;

  document.title = `${app.name} · 开心软件市场`;
}

async function boot() {
  try {
    const site = await api('/api/site');
    setText('[data-site-name]', site.siteName);
    const stats = await api('/api/stats');
    setText('[data-stat-total]', formatCount(stats.total));
    setText('[data-stat-downloads]', formatCount(stats.downloads));
  } catch {
    /* 站点信息失败不影响详情渲染 */
  }

  if (!id) {
    root.innerHTML = `<div class="empty"><span class="empty__mark">?</span><p>地址里没有指定应用编号。<br /><a class="backlink" href="/">回到应用目录</a></p></div>`;
    return;
  }

  try {
    const data = await api(`/api/apps/${id}`);
    render(data.app);
  } catch (err) {
    root.innerHTML = `
      <div class="empty">
        <span class="empty__mark">!</span>
        <p>${escapeHtml(err.message)}<br />它可能已被下架，或链接有误。</p>
        <p style="margin-top:18px"><a class="btn btn--sm" href="/">返回应用目录</a></p>
      </div>`;
  }
}

boot();