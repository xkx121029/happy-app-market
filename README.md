# 开心软件市场

一个自托管的应用程序分发市场。前台供访客浏览并下载应用安装包；后台供管理员上架、编辑、下架应用（应用名、应用介绍、应用图片、应用包体）。

整个项目**零第三方依赖**，只使用 Node.js 内置模块，克隆下来 `npm start` 即可运行。

## 特性

- **零第三方依赖**：数据库使用 Node 22.5+ 内置的 `node:sqlite`（`DatabaseSync`），HTTP 服务使用 `node:http`，无需 `npm install`，无需构建步骤。
- **双端口隔离**：前台下载站与管理台分别占用独立端口，互不干扰。前台只暴露已上架应用，后台承载管理页面与全部管理接口，并开放 CORS 便于跨端口调用。
- **文件上传不走 multipart**：请求体直接是文件二进制，原始文件名放在 `x-file-name` 请求头（URL 编码以支持中文名），因此服务端不需要任何 multipart 解析库。
- **Range 断点续传**：下载接口支持 `Range` 请求，仅统计完整下载次数。
- **包体不公开直链**：`/uploads/packages/*` 在前台端口被拦截，包体只能通过下载接口获取。
- **铅印档案风格的前台界面**：暖纸底、浓墨字、单色朱红、纸面颗粒与发丝分隔线；背景为手写 WebGL 流体（指针驱动的 fbm 域扭曲着色器），WebGL 不可用时静默降级为 CSS 渐变。
- **本地化存储**：上传文件存本地文件系统，元数据存 SQLite。

## 界面截图

仓库暂未内置截图文件。如需补充，请将图片放入 `docs/images/` 目录，并按下表命名，本段可同步替换为实际图片引用。

| 文件名 | 内容说明 |
| --- | --- |
| `docs/images/public-home.png` | 前台首页：WebGL 流体首屏、概览大数字、应用目录列表 |
| `docs/images/public-app.png` | 前台应用详情页：图标、截图、介绍与下载入口 |
| `docs/images/admin-list.png` | 后台应用列表：上架状态、包体状态与操作入口 |
| `docs/images/admin-edit.png` | 后台编辑弹窗：应用元数据、图标/截图与包体上传 |

## 目录结构

```
开心软件市场/
├── config.json            端口与站点配置
├── server.js              启动入口（同时拉起前台与后台两个端口）
├── src/
│   ├── config.js          配置、路径与上传体积上限
│   ├── db.js              SQLite 数据层（node:sqlite）
│   ├── util.js            响应、二进制上传、静态文件与 Range 支持
│   ├── public-server.js   前台服务（列表/详情/下载/分类/统计）
│   └── admin-server.js    后台服务（上架/编辑/下架/上传包体与图片）
├── shared/                前台后台共用资源
│   ├── design.css         共享设计令牌与基础组件
│   └── ui.js              请求、格式化等前端工具
├── public/                前台页面 index.html + app.html + assets/
├── admin/                 后台页面 index.html + assets/
├── docs/API.md            接口文档
├── uploads/               上传文件（icons / screenshots / packages），运行时自动创建
└── data/market.db         SQLite 数据库，运行时自动创建
```

## 快速开始

环境要求：**Node.js 22.5 或更高版本**（依赖内置 `node:sqlite`），无需安装任何第三方依赖。

```bash
# 正式启动
npm start

# 开发模式：文件变更自动重启
npm run dev
```

启动后终端会打印前台、后台的访问地址。若端口被占用，请修改 `config.json` 后重试。

## 配置说明

站点配置集中在根目录 `config.json`，修改后重启生效：

```json
{
  "siteName": "开心软件市场",
  "siteSlogan": "纯净分发 · 直接下载安装包",
  "publicPort": 8080,
  "adminPort": 8081,
  "host": "0.0.0.0",
  "maxUploadMB": 800,
  "defaultPageSize": 12
}
```

| 字段 | 说明 |
| --- | --- |
| `siteName` | 站点名称，前台标题与后台概览使用 |
| `siteSlogan` | 站点标语，前台首页展示 |
| `publicPort` | 前台下载站端口，默认 `8080` |
| `adminPort` | 后台管理台端口，默认 `8081` |
| `host` | 监听地址，`0.0.0.0` 表示允许局域网访问 |
| `maxUploadMB` | 单个文件上传体积上限（MB），对包体与图片均生效 |
| `defaultPageSize` | 前台列表默认每页条数 |

## 端口与访问

| 角色 | 默认端口 | 地址 | 用途 |
| --- | --- | --- | --- |
| 前台下载站 | `8080` | `http://localhost:8080` | 访客浏览、查看详情、下载安装包 |
| 后台管理台 | `8081` | `http://localhost:8081` | 上架 / 编辑 / 下架应用，上传包体与图片 |

两个端口由 `server.js` 同时拉起，互不影响。后台端口已开放 CORS，可从任意页面跨端口调用其接口。

## 接口文档

完整的接口说明（前台公共接口、后台管理接口、上传约定与磁盘结构）见 [docs/API.md](docs/API.md)。

## 开源协议

本项目基于 [MIT License](LICENSE) 开源。