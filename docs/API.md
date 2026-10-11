# 开心软件市场 · 接口文档

项目以两个端口对外提供服务，互不干扰：

| 角色 | 默认端口 | 地址 | 用途 |
| --- | --- | --- | --- |
| 前台下载站 | `8080` | `http://<host>:8080` | 访客浏览、查看详情、下载安装包 |
| 后台管理台 | `8081` | `http://<host>:8081` | 上架 / 编辑 / 下架应用，上传包体与图片 |

端口、上传上限等部署参数在项目根目录的 `config.json` 中配置，改动后重启生效。

```json
{
  "siteName": "开心软件市场",
  "siteSlogan": "自己写的软件都放在这里",
  "publicPort": 8080,
  "adminPort": 8081,
  "host": "0.0.0.0",
  "maxUploadMB": 800,
  "defaultPageSize": 12
}
```

站点文案、强调色、首屏内容与每页条数属于**运行时可改**的设置项，存在数据库里，在后台「站点设置」页修改即时生效，无需重启，也无需改文件（见后台 `GET/PUT /api/settings`）。`config.json` 里的同名字段只作为缺省值兜底。

统一约定：

- 请求与响应均为 `JSON`，字符集 `UTF-8`。
- 成功响应包含 `"ok": true`，失败响应为 `{ "ok": false, "error": "中文错误说明" }`。
- 失败时 HTTP 状态码同步反映原因：`400` 参数问题或上传超限、`404` 不存在、`405` 方法不支持。
- 后台端口已开放 CORS（`Access-Control-Allow-Origin` 回显来源），可从任意页面跨端口调用。

---

## 一、前台接口（公共端口 8080）

### GET /api/apps

分页查询**已上架**应用。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `q` | string | 空 | 关键词，匹配应用名 / 简介 / 开发者 / 包名 |
| `category` | string | 空 | 分类精确匹配 |
| `sort` | string | `latest` | `latest` 最新上架、`downloads` 最多下载、`name` 名称排序 |
| `page` | number | `1` | 页码 |
| `pageSize` | number | `12` | 每页条数，上限 100 |

```json
{
  "ok": true,
  "total": 1,
  "page": 1,
  "pageSize": 12,
  "items": [
    {
      "id": 1,
      "name": "开心笔记",
      "package_name": "com.kxkj.notes",
      "version": "1.2.0",
      "developer": "开心科技",
      "category": "效率办公",
      "summary": "极简卡片式笔记。",
      "description": "完整介绍文本…",
      "icon": "/uploads/icons/xxx.png",
      "screenshots": ["/uploads/screenshots/a.png"],
      "open_source_urls": ["https://github.com/xxx/happy-notes"],
      "hasPackage": true,
      "package_path": "/uploads/packages/xxx.apk",
      "package_file": "开心笔记-1.2.0.apk",
      "package_size": 1048576,
      "status": 1,
      "downloads": 2,
      "created_at": "2026-10-07T13:35:48.996Z",
      "updated_at": "2026-10-07T13:37:27.615Z"
    }
  ]
}
```

### GET /api/apps/:id

返回单个已上架应用的完整信息（结构同列表中的单个 `app`）。应用不存在或已下架时返回 `404`。

### GET /api/apps/:id/download

下载安装包。

- 响应带 `Content-Disposition: attachment`，中文文件名通过 `filename*=UTF-8''` 编码传递。
- 支持 `Range` 断点续传，命中时返回 `206` 与 `Content-Range`。
- **仅统计完整下载**（不含 `Range` 请求）到 `downloads` 计数。
- 包体目录不允许公开直链，`/uploads/packages/*` 在前台端口一律 `404`。

```bash
curl -O -J http://localhost:8080/api/apps/1/download
curl -H "Range: bytes=0-1023" http://localhost:8080/api/apps/1/download
```

### GET /api/categories

已上架应用的分类聚合，按应用数量倒序。

```json
{ "ok": true, "items": [{ "name": "效率办公", "count": 1 }] }
```

### GET /api/stats

站点概览，用于首页显示收录数与累计下载数。

```json
{ "ok": true, "total": 1, "downloads": 2 }
```

### GET /api/site

站点设置，供前台页面填充文案、强调色与列表分页。内容取自数据库中的设置项，未设置的项回落到 `config.json` 默认值。

```json
{
  "ok": true,
  "siteName": "开心软件市场",
  "slogan": "自己写的软件都放在这里",
  "heroKicker": "自己写的软件",
  "heroTitle": "挑一个\n*趁手*的软件",
  "heroSubtitle": "看中哪个点进去，直接下载安装包。",
  "statAppsLabel": "在架应用",
  "statDownloadsLabel": "累计下载",
  "footerNote": "下载前请核对版本与体积",
  "accentColor": "#2f6f9f",
  "pageSize": 12
}
```

`heroTitle` 支持两种轻量写法：`\n` 代表换行，用 `*星号*` 包住的词会渲染成强调色。

---

## 二、后台接口（管理端口 8081）

### GET /api/overview

后台首页概览：全量统计、分类、站点名与两个端口号。

```json
{
  "ok": true,
  "siteName": "开心软件市场",
  "ports": { "public": 8080, "admin": 8081 },
  "stats": { "total": 3, "published": 2, "draft": 1, "downloads": 42, "withPackage": 2 },
  "categories": [{ "name": "效率办公", "count": 2 }]
}
```

`stats` 字段含义：`total` 应用总数、`published` 已上架、`draft` 未上架、`withPackage` 已上传包体、`downloads` 累计下载。

### GET /api/settings

读取全部站点设置，并附带每一项的默认值（供「恢复默认」使用）。

```json
{
  "ok": true,
  "settings": {
    "siteName": "开心软件市场",
    "siteSlogan": "自己写的软件都放在这里",
    "heroKicker": "自己写的软件",
    "heroTitle": "挑一个\n*趁手*的软件",
    "heroSubtitle": "看中哪个点进去，直接下载安装包。",
    "statAppsLabel": "在架应用",
    "statDownloadsLabel": "累计下载",
    "footerNote": "下载前请核对版本与体积",
    "accentColor": "#2f6f9f",
    "defaultPageSize": "12"
  },
  "defaults": { "siteName": "开心软件市场", "accentColor": "#2f6f9f" }
}
```

### PUT /api/settings

更新站点设置，**只传需要改动的字段**，未传的保持不变。校验规则：

| 字段 | 说明 |
| --- | --- |
| `siteName` | 站点名称，不能为空，上限 60 字符 |
| `siteSlogan` | 站点标语，上限 120 字符 |
| `heroKicker` | 首屏小标签，上限 60 字符 |
| `heroTitle` | 首屏大标题，上限 120 字符；支持 `\n` 换行与 `*强调*` |
| `heroSubtitle` | 首屏副标题，上限 200 字符 |
| `statAppsLabel` | 统计标签 · 上架数，上限 20 字符 |
| `statDownloadsLabel` | 统计标签 · 下载数，上限 20 字符 |
| `footerNote` | 页脚说明，上限 120 字符 |
| `accentColor` | 强调色，需为 `#RRGGBB` 形式的十六进制颜色，非法返回 `400` |
| `defaultPageSize` | 每页条数，1 到 100 之间的整数，非法返回 `400` |

```bash
curl -X PUT http://localhost:8081/api/settings \
  -H "Content-Type: application/json" \
  -d '{"accentColor":"#2f6f4e","defaultPageSize":6}'
```

返回 `200` 与更新后的完整 `settings`。

### POST /api/settings/reset

把所有站点设置恢复为默认值。

```json
{ "ok": true, "settings": { "siteName": "开心软件市场", "accentColor": "#2f6f9f" } }
```

### GET /api/apps

后台列表，返回**全部**应用（含未上架），按 `id` 倒序。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `q` | string | 关键词搜索 |
| `status` | string | `1` 只看已上架，`0` 只看未上架，留空为全部 |
| `category` | string | 分类精确匹配 |

```json
{ "ok": true, "total": 3, "items": [] }
```

### GET /api/apps/:id

返回单个应用（含未上架）。

### POST /api/apps

新建应用记录。文件不在此接口上传，见下方上传接口。

| 字段 | 必填 | 上限 | 说明 |
| --- | --- | --- | --- |
| `name` | 是 | 120 | 应用名，空白字符会被去除 |
| `package_name` | 否 | 120 | 包名 |
| `version` | 否 | 40 | 版本号 |
| `developer` | 否 | 120 | 开发者 |
| `category` | 否 | 60 | 分类 |
| `summary` | 否 | 300 | 一句话简介 |
| `description` | 否 | 20000 | 应用介绍，保留换行 |
| `open_source_urls` | 否 | 12 条 | 开源仓库地址数组，每项需以 `http://` 或 `https://` 开头，自动去重；非法地址会返回 `400` |

```bash
curl -X POST http://localhost:8081/api/apps \
  -H "Content-Type: application/json" \
  -d '{"name":"开心笔记","version":"1.2.0","summary":"极简卡片式笔记。","open_source_urls":["https://github.com/xxx/happy-notes"]}'
```

返回 `201` 与新建的 `app`。

### PUT /api/apps/:id

更新元数据，字段与新建一致，**只传需要改动的字段**，未传字段保持不变。`name` 若传空字符串会被拒绝（`400`）。`icon` 字段仅接受空字符串（用于清空图标），图标文件的增删由上传接口负责。

### DELETE /api/apps/:id

删除应用，并级联清理磁盘上的图标、截图与包体文件。

```json
{ "ok": true, "removed": 1 }
```

### POST /api/apps/:id/status

上架 / 下架。

```json
{ "status": 1 }
```

`1` 上架、`0` 下架。**未上传包体的应用不允许上架**，会返回 `400`。

### POST /api/apps/:id/package

上传应用包体（APK / IPA / EXE / ZIP 等任意格式）。

- 请求体直接是**文件二进制**，不使用 `multipart/form-data`。
- 原始文件名放在 `x-file-name` 请求头，需 URL 编码以支持中文：

```
x-file-name: %E5%BC%80%E5%BF%83%E7%AC%94%E8%AE%B0-1.2.0.apk
```

- 上传上限由 `config.json` 的 `maxUploadMB` 控制，超出会中断连接并返回错误。
- 重复上传会替换旧包体，并删除磁盘上的旧文件。

```bash
curl -X POST http://localhost:8081/api/apps/1/package \
  -H "x-file-name: %E5%BC%80%E5%BF%83%E7%AC%94%E8%AE%B0-1.2.0.apk" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @happy-notes.apk
```

### DELETE /api/apps/:id/package

移除包体，记录保留但回到「未上传」状态。

### GET /api/apps/:id/download

后台侧的包体下载，用于上架前自测。行为与前台下载接口一致，但不校验上架状态、不累加下载计数。

### POST /api/apps/:id/icon

上传应用图标，覆盖式（一张图）。同样使用二进制请求体 + `x-file-name` 头。

- 仅接受图片扩展名（`png` / `jpg` / `jpeg` / `gif` / `webp` / `avif` / `svg` / `bmp`），否则 `400`。
- 单文件上限 20 MB。

### POST /api/apps/:id/screenshots

追加一张应用截图，可重复调用。约束与图标一致（图片格式、20 MB）。

### DELETE /api/apps/:id/screenshots

删除指定截图，同时删除磁盘文件。

```json
{ "url": "/uploads/screenshots/xxx.png" }
```

---

## 三、磁盘结构

```
开心软件市场/
├── config.json            端口与站点配置
├── server.js              启动入口（同时拉起两个端口）
├── src/                   后端源码
│   ├── config.js          配置与路径
│   ├── db.js              SQLite 数据层
│   ├── util.js            响应、上传、静态文件与 Range 支持
│   ├── public-server.js   前台服务
│   └── admin-server.js    后台服务
├── shared/                前台后台共用资源
│   ├── design.css         设计令牌与基础组件
│   └── ui.js              请求、格式化等前端工具
├── public/                前台页面（index.html / app.html）
├── admin/                 后台页面（index.html）
├── uploads/               上传文件，均由服务自动创建
│   ├── icons/             应用图标
│   ├── screenshots/       应用截图
│   └── packages/          应用包体（不对外直链）
└── data/market.db         SQLite 数据库
```

`/uploads/icons/*` 与 `/uploads/screenshots/*` 在两个端口都可公开读取（后台用于预览）；`/uploads/packages/*` 在前台端口被拦截，只能通过下载接口获取。

数据库为单文件 SQLite，含两张表：`apps`（应用记录）与 `settings`（键值形式的站点设置，字段名以 `key` / `value` 两列存储）。

---

## 四、启动

```bash
npm start          # 正式启动
npm run dev        # 文件变更自动重启
```

依赖 Node.js 22.5 及以上版本（使用内置 `node:sqlite`，无需安装任何第三方依赖）。