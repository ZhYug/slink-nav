# 🚀 SLink Nav 1.0.0

> 一个基于 Cloudflare Pages / Workers + D1 的单文件短链接与个人导航管理项目。

---

## 📖 项目简介

**SLink Nav** 是一个轻量、现代化的短链接与导航管理系统，运行于 Cloudflare 边缘平台，使用 Cloudflare D1 保存业务数据。

项目采用**单文件 Worker** 架构，运行时所需的 HTML、CSS、JavaScript、PWA 资源以及数据库初始化逻辑均内置在 `_worker.js` 中，无需额外的前端构建流程。

### ✨ 核心特性

- 🔗 **短链接系统**：创建、编辑、删除、启用/禁用短链接，并支持自定义短码。
- 🧭 **导航管理**：支持分类、收藏、排序、启用/禁用以及关联短链接。
- 🌐 **首页导航**：首页导航项目继续使用短链接访问，保持短链接统计能力。
- 🎯 **真实目标地址**：导航管理页面显示关联短链接对应的真实目标网址，不影响首页短链接行为。
- 📊 **点击统计**：记录短链接总点击量，并保存每日点击统计。
- 📥 **CSV 导入/导出**：支持 CSV 数据导入；导出按照服务器端完整数据集生成，不受当前分页影响。
- 💾 **JSON 备份/恢复**：支持完整业务数据备份、合并恢复及覆盖恢复。
- 🎨 **主题设置**：支持后台深色/浅色主题及站点相关设置。
- 📱 **移动端适配**：后台及前台适配手机、平板和桌面浏览器。
- 📦 **PWA**：支持 Service Worker、Manifest 和移动端安装体验。
- 🖼️ **同源图标代理**：通过 `/api/favicon` 获取目标站点图标，减少浏览器直接访问第三方 favicon 服务的问题。
- ⚡ **D1 批处理优化**：统计写入、批量导航操作等场景使用 D1 Batch，降低请求次数。
- 📄 **分页管理**：后台短链接和导航列表采用服务端分页，适合较多数据量的使用场景。

---

## 📦 项目结构

```text
slink-nav/
├── _worker.js
├── wrangler.toml
└── README.md
```

其中：

- `_worker.js`：完整 Worker、前端资源、API、数据库初始化及升级逻辑。
- `README.md`：项目说明及部署文档。

---

## 💡 快速部署

>[!TIP]
> 推荐使用 **Cloudflare Pages 上传部署**。项目无需额外构建，上传项目目录即可运行。

>[!WARNING]
> 首次部署前请先创建 D1 数据库，并正确配置 

### 🛠 Pages 上传部署方法

<details>
<summary><code><strong>「 Pages 上传文件部署文字教程 」</strong></code></summary>

1. 创建 Cloudflare D1 数据库：
   - 创建一个数据库，例如命名为 `slink-nav`。

2. 部署 CF Pages：
   - 在 Cloudflare Pages 中选择 **上传资产**。
   - 上传 `slinknav` 项目目录或打包后的项目文件。
   - 项目不需要执行前端构建命令。
   - 部署完成后访问你的 Pages 域名。

3. 配置环境变量/Secrets：
   - `ADMIN_PASSWORD`：后台管理员登录密码。
   
4. 绑定D1数据库 变量必须填写 `DB` 选择刚刚你创建的d1数据库 例如命名为 `slink-nav` 的数据库

5. 访问后台：
   - 打开：
     ```text
     https://你的域名/admin
     ```
   - 输入 `ADMIN_PASSWORD` 设置的密码即可进入管理后台。

</details>

### 🛠 Pages + GitHub 部署方法

<details>
<summary><code><strong>「 Pages + GitHub 部署文字教程 」</strong></code></summary>

1. 将本项目上传到 GitHub 仓库。
2. 在 Cloudflare Pages 中选择 **连接到 Git**。
3. 选择 SLink Nav 所在的 GitHub 仓库。
4. 构建设置无需复杂的前端构建流程，项目运行入口为 `_worker.js`。
5. 配置生产环境变量/Secrets：
   - `ADMIN_PASSWORD`
6. 确认 D1 Binding 使用变量名：
   ```text
   DB
   ```
7. 保存并部署。

</details>


## 🔑 环境变量说明

| 变量名 | 必填 | 示例 | 详细备注 |
| :--- | :---: | :--- | :--- |
| **ADMIN_PASSWORD** | ✅ | `YourStrongPassword` | 管理后台登录密码 |
| **SESSION_SECRET** | ✅ | `随机高强度字符串` | 后台 Session 签名/安全密钥，建议使用 Cloudflare Secret |
| **DB** | ✅ | `D1 Binding` |绑定d1数据库 |

> [!WARNING]
> `ADMIN_PASSWORD` 和 `SESSION_SECRET` 不建议直接写入 `_worker.js` 或提交到公开仓库，推荐使用 Cloudflare Secrets / 环境变量配置。

---

## 🗄️ 数据库说明

当前项目数据库已经正式合并为 **v1**。

```text
数据库版本：v1
项目版本：1.0.0
```

### 核心数据表

| 数据表 | 用途 |
| :--- | :--- |
| `links` | 短链接及真实目标地址 |
| `link_daily_stats` | 短链接每日点击统计 |
| `navigation` | 首页导航项目 |
| `settings` | 系统及站点设置 |
| `_stnav_migrations` | 数据库版本标记 |

### 数据库初始化

新数据库首次运行时会直接创建当前最终结构，不再按照旧版本的 v2/v3/v4/v5 逐级初始化。

### 旧数据库兼容

如果从旧版 SLink / ST Nav 数据库升级：

- 不删除业务表。
- 不清空短链接数据。
- 不清空导航数据。
- 不清空点击统计。
- 不清空系统设置。
- 历史数据库版本标记会兼容处理为当前基线 `v1`。
- 后续数据库结构变化从 `v2` 开始继续使用正向 Migration。

因此升级时**不要删除 D1 数据库重新创建**。

---

## 🔗 短链接与导航关系

SLink Nav 对首页和后台的 URL 展示进行了区分：

### 首页

首页导航关联短链接时，继续使用：

```text
https://你的域名/短码
```

这样可以正常记录短链接点击统计。

### 导航管理

导航管理页面显示关联短链接的：

```text
真实目标地址
```

例如：

```text
首页访问：
https://nav.example.com/github

导航管理显示：
https://github.com/example/project
```

两者互不影响。

---

## 📥 CSV 导入与导出

### CSV 导入

后台支持 CSV 导入，并提供：

- 导入预览
- 重复短码跳过
- 重复短码覆盖
- 自动生成新短码
- 大量数据分批导入

### CSV 导出

CSV 导出采用服务器端查询方式，不依赖当前后台列表分页。

例如：

```text
数据库有 1000 条短链接
当前页面显示第 1 页的 20 条

点击导出 CSV
        ↓
服务器端查询全部符合条件的数据
        ↓
生成完整 CSV
```

因此不会因为当前页面分页而只导出当前页数据。

如果当前使用了搜索条件，导出会按照当前搜索条件导出完整结果集。

---

## 💾 JSON 备份与恢复

后台支持 JSON 完整备份。

备份内容包括：

- 短链接
- 导航
- 系统设置

支持两种恢复方式：

| 恢复方式 | 说明 |
| :--- | :--- |
| **合并恢复** | 保留现有数据，并新增/更新备份中的数据 |
| **完全覆盖恢复** | 清空当前业务数据后恢复备份内容 |

>[!WARNING]
> 使用完全覆盖恢复前，请先执行一次当前数据 JSON 备份。

---

## 🖼️ 图标代理

为改善部分网络环境下第三方 favicon 服务无法正常加载的问题，项目提供同源图标代理：

```text
/api/favicon?url=目标网址
```

Worker 会尝试获取目标网站 favicon；如果无法取得有效图标，则生成基于域名首字母的 SVG 备用图标。

图标请求由当前 SLink Nav 域名提供，前端不再必须直接访问 Google/DuckDuckGo 等第三方 favicon 服务。

---

## 📱 访问方式

### 前台

```text
https://你的域名/
```

### 管理后台

```text
https://你的域名/admin
```

### 健康检查

```text
https://你的域名/api/health
```

---

## 🔄 项目升级说明

SLink Nav 当前正式版本为：

```text
1.0.0
```

数据库当前版本为：

```text
v1
```

以后如果增加数据库字段或表结构，应使用正向 Migration：

```text
v1 → v2 → v3 → ...
```

升级原则：

1. 保留现有业务数据。
2. 只执行当前数据库尚未执行的 Migration。
3. 不删除 D1 数据库。
4. 不通过重建业务表实现升级。
5. 不改变已有短链接的真实目标地址。
6. 升级前建议先执行 JSON 数据备份。

---

## 🔧 开发说明

项目采用单文件 Worker 架构：

```text
_worker.js
```

运行时资源均嵌入 Worker，包括：

- HTML
- CSS
- JavaScript
- SVG
- Web Manifest
- Service Worker
- API 路由
- D1 初始化及 Migration 逻辑

因此不需要 Node.js 前端构建工具，也不需要单独部署前端静态资源。

---

## 📋 版本信息

| 项目 | 信息 |
| :--- | :--- |
| 项目名称 | `slink-nav` |
| 显示名称 | `SLink Nav` |
| 当前版本 | `1.0.0` |
| 数据库版本 | `v1` |
| 运行平台 | Cloudflare Pages / Workers |
| 数据库 | Cloudflare D1 |
| 运行入口 | `_worker.js` |
| D1 Binding | `DB` |

---

## ⚠️ 免责声明

1. 本项目仅供个人学习、研究及合法的网站导航、短链接管理等用途。
2. 使用者应遵守所在地区的法律法规以及 Cloudflare 的相关服务条款。
3. 请妥善保管管理员密码、Session Secret 及 D1 数据。
4. 作者及项目维护者不对因错误配置、数据丢失、滥用或第三方服务异常造成的损失承担责任。
5. 在生产环境使用前，请先完成数据备份并确认 Cloudflare D1 与项目配置正确。

---

## ⭐ 项目支持

如果 SLink Nav 对你有帮助，欢迎提交 Issue、Pull Request 或 Star 项目。

---

**SLink Nav · 1.0.0**
