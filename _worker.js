/*
 * SLink Nav — single-file Cloudflare Worker build.
 * Runtime dependencies: D1 binding named DB, ADMIN_PASSWORD, SESSION_SECRET.
 * All HTML/CSS/JS/PWA assets and the database baseline/migration runner are embedded.
 * For future DB changes, append a forward-only entry to DATABASE_MIGRATIONS and bump its version.
 */


const VERSION = "1.0.0";
const SESSION_COOKIE = "__Host-stnav_session";
const SESSION_TTL = 86400;
const PUBLIC_CACHE_CONTROL = "public, max-age=0, s-maxage=30, stale-while-revalidate=60";
const DATABASE_BASELINE_VERSION = 1;
const REQUIRED_TABLES = ["links", "link_daily_stats", "navigation", "settings"];
const databaseReady = new WeakMap();
const DATABASE_SCHEMA = "-- SLink Nav final D1 schema\n-- Single source of truth for a fresh database.\n-- Schema version: 1\n\nCREATE TABLE IF NOT EXISTS links (\n  id INTEGER PRIMARY KEY,\n  code TEXT NOT NULL UNIQUE COLLATE BINARY,\n  url TEXT NOT NULL,\n  title TEXT,\n  description TEXT,\n  category TEXT,\n  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),\n  favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),\n  clicks INTEGER NOT NULL DEFAULT 0 CHECK (clicks >= 0),\n  last_clicked_at TEXT,\n  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\n);\n\nCREATE INDEX IF NOT EXISTS idx_links_clicks_id\n  ON links(clicks DESC, id DESC);\nCREATE INDEX IF NOT EXISTS idx_links_created_at\n  ON links(created_at DESC, id DESC);\n\nCREATE TABLE IF NOT EXISTS link_daily_stats (\n  link_id INTEGER NOT NULL,\n  day TEXT NOT NULL,\n  clicks INTEGER NOT NULL DEFAULT 0 CHECK (clicks >= 0),\n  PRIMARY KEY (link_id, day),\n  FOREIGN KEY (link_id) REFERENCES links(id) ON DELETE CASCADE\n);\n\nCREATE INDEX IF NOT EXISTS idx_link_daily_stats_day_link\n  ON link_daily_stats(day, link_id);\n\nCREATE TABLE IF NOT EXISTS navigation (\n  id INTEGER PRIMARY KEY,\n  title TEXT,\n  description TEXT,\n  url TEXT,\n  icon TEXT,\n  category TEXT,\n  sort_order INTEGER NOT NULL DEFAULT 0,\n  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),\n  favorite INTEGER CHECK (favorite IN (0, 1)),\n  link_id INTEGER,\n  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  CHECK (link_id IS NOT NULL OR (title IS NOT NULL AND url IS NOT NULL)),\n  FOREIGN KEY (link_id) REFERENCES links(id) ON DELETE CASCADE\n);\n\nCREATE INDEX IF NOT EXISTS idx_navigation_enabled_order\n  ON navigation(enabled, sort_order, id);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_navigation_link_unique\n  ON navigation(link_id)\n  WHERE link_id IS NOT NULL;\n\nCREATE TABLE IF NOT EXISTS settings (\n  key TEXT PRIMARY KEY,\n  value TEXT NOT NULL\n);\n\nINSERT OR IGNORE INTO settings(key, value) VALUES\n  ('site_title', 'My Navigation'),\n  ('site_subtitle', 'Personal navigation & short links'),\n  ('site_description', 'Everything you need, one click away.'),\n  ('hero_title', 'Everything you need, one click away.'),\n  ('hero_description', 'A fast, elegant home for your frequently used websites.'),\n  ('accent', '#8b6cff'),\n  ('nav_tag_style', 'pills'),\n  ('nav_columns_mobile', '2'),\n  ('nav_columns_tablet', '3'),\n  ('nav_columns_desktop', '4'),\n  ('nav_columns_wide', '6'),\n  ('nav_category_order', ''),\n  ('nav_hidden_categories', '');\n\nINSERT INTO navigation(title, description, url, icon, category, sort_order, enabled)\nSELECT 'GitHub', '代码仓库与开源项目', 'https://github.com', '', '开发', 0, 1\nWHERE (SELECT COUNT(*) FROM navigation) = 0\nUNION ALL\nSELECT 'Google', '搜索与常用服务', 'https://www.google.com', '', '工具', 1, 1\nWHERE (SELECT COUNT(*) FROM navigation) = 0\nUNION ALL\nSELECT 'Cloudflare', '网络与边缘服务', 'https://dash.cloudflare.com', '', '开发', 2, 1\nWHERE (SELECT COUNT(*) FROM navigation) = 0\nUNION ALL\nSELECT 'ChatGPT', 'AI 助手', 'https://chatgpt.com', '', 'AI', 3, 1\nWHERE (SELECT COUNT(*) FROM navigation) = 0;\n\n-- Reconcile the denormalized total for databases restored with daily statistics.\nUPDATE links\nSET clicks = COALESCE(\n  (SELECT SUM(clicks) FROM link_daily_stats WHERE link_daily_stats.link_id = links.id),\n  0\n)\nWHERE EXISTS (\n  SELECT 1 FROM link_daily_stats WHERE link_daily_stats.link_id = links.id\n);\n\n-- links.clicks is maintained by the application in the same D1 batch as daily stats.\n";;

// Database schema is consolidated into v1. Future schema changes should use v2, v3... forward migrations.
const DATABASE_MIGRATIONS = [];

function splitSqlStatements(sql) {
  const statements = [];
  let current = "";
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  let triggerBody = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (lineComment) {
      current += ch;
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      current += ch;
      if (ch === "*" && next === "/") {
        current += next;
        i++;
        blockComment = false;
      }
      continue;
    }
    if (!quote && ch === "-" && next === "-") {
      current += ch + next;
      i++;
      lineComment = true;
      continue;
    }
    if (!quote && ch === "/" && next === "*") {
      current += ch + next;
      i++;
      blockComment = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) {
        if (next === quote) {
          current += next;
          i++;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    current += ch;

    if (!triggerBody && /\bCREATE\s+TRIGGER\b/i.test(current)) triggerBody = true;

    if (ch === ";") {
      const trimmed = current.trim();
      if (triggerBody && !/\bEND\s*;$/i.test(trimmed)) continue;
      if (trimmed) statements.push(trimmed.slice(0, -1).trim());
      current = "";
      triggerBody = false;
    }
  }

  if (current.trim()) statements.push(current.trim());
  return statements;
}

async function getSchemaVersion(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS _stnav_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
  const row = await env.DB.prepare("SELECT COALESCE(MAX(version),0) AS version FROM _stnav_migrations").first();
  const recorded = Number(row?.version || 0);

  const tables = await env.DB.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_master
    WHERE type='table' AND name IN (?, ?, ?, ?)
  `).bind(...REQUIRED_TABLES).first();
  const hasBusinessTables = Number(tables?.count || 0) === REQUIRED_TABLES.length;

  if (recorded === 0 && hasBusinessTables) {
    // Databases created by pre-migration builds already have the current business schema.
    await env.DB.prepare("INSERT OR IGNORE INTO _stnav_migrations(version) VALUES(1)").run();
    return 1;
  }

  if (recorded > 1 && recorded <= 5 && hasBusinessTables) {
    // Versions 2-5 were intermediate internal builds. They are now consolidated into v1.
    // Only migration metadata is normalized; business data is never deleted or rebuilt.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM _stnav_migrations"),
      env.DB.prepare("INSERT INTO _stnav_migrations(version) VALUES(1)")
    ]);
    return 1;
  }

  return recorded;
}

const DATABASE_TARGET_VERSION = DATABASE_MIGRATIONS.length
  ? Math.max(DATABASE_BASELINE_VERSION, ...DATABASE_MIGRATIONS.map((migration) => Number(migration.version) || 0))
  : DATABASE_BASELINE_VERSION;

async function installFreshDatabase(env) {
  const statements = splitSqlStatements(DATABASE_SCHEMA)
    .filter((statement) => statement.trim())
    .map((statement) => env.DB.prepare(statement));
  await env.DB.batch(statements);
  await env.DB.prepare("INSERT OR IGNORE INTO _stnav_migrations(version) VALUES(?)").bind(DATABASE_BASELINE_VERSION).run();
}

async function runDatabaseMigrations(env) {
  const tables = await env.DB.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name IN (?, ?, ?, ?)
  `).bind(...REQUIRED_TABLES).all();
  const existing = new Set((tables.results ?? []).map((row) => row.name));

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS _stnav_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  if (!REQUIRED_TABLES.every((name) => existing.has(name))) {
    await installFreshDatabase(env);
  }

  let current = await getSchemaVersion(env);
  if (current > DATABASE_TARGET_VERSION) {
    throw new Error(`数据库版本 ${current} 高于 Worker 支持的版本 ${DATABASE_TARGET_VERSION}`);
  }

  const migrations = [...DATABASE_MIGRATIONS].sort((a, b) => a.version - b.version);
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version <= 0) {
      throw new Error(`无效数据库 migration version: ${migration.version}`);
    }
    if (migration.version <= current) continue;
    if (!migration.sql?.trim()) throw new Error(`数据库 migration ${migration.version} 缺少 SQL`);

    const statements = splitSqlStatements(migration.sql)
      .filter((statement) => statement.trim())
      .map((statement) => env.DB.prepare(statement));
    statements.push(env.DB.prepare("INSERT INTO _stnav_migrations(version) VALUES(?)").bind(migration.version));
    await env.DB.batch(statements);
    current = migration.version;
  }

  const result = await env.DB.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name IN (?, ?, ?, ?)
  `).bind(...REQUIRED_TABLES).all();
  const finalExisting = new Set((result.results ?? []).map((row) => row.name));
  const missing = REQUIRED_TABLES.filter((name) => !finalExisting.has(name));
  if (missing.length) throw new Error(`D1 数据库初始化后仍缺少数据表: ${missing.join(", ")}`);
}

async function ensureDatabase(env) {
  if (!env.DB) {
    throw new Error("D1 数据库绑定 DB 不存在，请检查 Cloudflare Worker 的 D1 Binding（变量名必须为 DB）。");
  }
  let promise = databaseReady.get(env);
  if (!promise) {
    promise = runDatabaseMigrations(env);
    databaseReady.set(env, promise);
    promise.catch(() => databaseReady.delete(env));
  }
  await promise;
}

const EMBEDDED_ASSETS = {"index.html":"<!doctype html>\n<html lang=\"zh-CN\">\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n  <meta name=\"theme-color\" content=\"#0b0d12\">\n  <meta name=\"description\" content=\"Personal navigation & short links\">\n  <title>My Navigation</title>\n  <link rel=\"icon\" href=\"/assets/favicon.svg\">\n  <link rel=\"manifest\" href=\"/manifest.webmanifest\">\n  <meta name=\"mobile-web-app-capable\" content=\"yes\">\n  <meta name=\"apple-mobile-web-app-capable\" content=\"yes\">\n  <meta name=\"apple-mobile-web-app-status-bar-style\" content=\"black-translucent\">\n  <link rel=\"preload\" href=\"/assets/styles.css?v=1.0.0\" as=\"style\">\n  <link rel=\"stylesheet\" href=\"/assets/styles.css?v=1.0.0\">\n</head>\n<body class=\"public-page\">\n  <div class=\"ambient ambient-a\"></div><div class=\"ambient ambient-b\"></div>\n  <header class=\"topbar shell\">\n    <a class=\"brand\" href=\"/\">\n      <span class=\"brand-mark\">S</span>\n      <span><b id=\"siteTitle\">My Navigation</b><small id=\"siteSubtitle\">Personal links</small></span>\n    </a>\n    <div class=\"top-actions\">\n      <button class=\"icon-btn\" id=\"themeBtn\" title=\"切换主题\">☾</button>\n      <a class=\"admin-link\" href=\"/admin\">管理</a>\n    </div>\n  </header>\n\n  <main class=\"shell public-main\">\n    <section class=\"hero\">\n      <div class=\"eyebrow\">PERSONAL DASHBOARD</div>\n      <h1 id=\"heroTitle\">Everything you need, one click away.</h1>\n      <p id=\"heroDesc\">A fast, elegant home for your frequently used websites.</p>\n      <div class=\"search-panel\" role=\"search\" aria-label=\"站内与外部搜索\">\n        <div class=\"search-engines\" role=\"tablist\" aria-label=\"搜索方式\">\n          <button class=\"search-engine active\" type=\"button\" data-search-engine=\"local\" role=\"tab\" aria-selected=\"true\">卡片搜索</button>\n          <button class=\"search-engine\" type=\"button\" data-search-engine=\"google\" role=\"tab\" aria-selected=\"false\">Google</button>\n          <button class=\"search-engine\" type=\"button\" data-search-engine=\"baidu\" role=\"tab\" aria-selected=\"false\">百度</button>\n          <button class=\"search-engine\" type=\"button\" data-search-engine=\"bing\" role=\"tab\" aria-selected=\"false\">Bing</button>\n          <button class=\"search-engine\" type=\"button\" data-search-engine=\"github\" role=\"tab\" aria-selected=\"false\">GitHub</button>\n        </div>\n        <div class=\"search-wrap\">\n          <span aria-hidden=\"true\">⌕</span>\n          <input id=\"searchInput\" autocomplete=\"off\" enterkeyhint=\"search\" placeholder=\"搜索导航、描述或分类…\" aria-label=\"搜索关键词\">\n          <kbd>⌘ K</kbd>\n          <button class=\"search-submit\" id=\"searchSubmit\" type=\"button\" aria-label=\"搜索\">搜索</button>\n        </div>\n      </div>\n    </section>\n\n    <section class=\"toolbar\">\n      <div class=\"chips\" id=\"categoryChips\"></div>\n      <button class=\"text-btn\" id=\"favoritesOnly\">☆ 收藏</button>\n    </section>\n\n    <section id=\"navGrid\" class=\"nav-grid\" aria-live=\"polite\"></section>\n    <nav id=\"pagination\" class=\"pagination public-pagination\" aria-label=\"首页分页\"></nav>\n    <div id=\"emptyState\" class=\"empty-state hidden\">\n      <div class=\"empty-icon\">⌕</div>\n      <h3>没有找到匹配内容</h3>\n      <p>换个关键词试试，或者清除筛选。</p>\n      <button class=\"btn secondary\" id=\"clearFilters\">清除筛选</button>\n    </div>\n\n    <section class=\"recent-section\">\n      <div class=\"section-heading\"><div><span class=\"eyebrow\">QUICK ACCESS</span><h2>最近访问</h2></div><button class=\"text-btn\" id=\"clearRecent\">清除</button></div>\n      <div id=\"recentGrid\" class=\"recent-grid\"></div>\n    </section>\n  </main>\n\n  <nav class=\"mobile-bottom-nav\" id=\"mobileBottomNav\" aria-label=\"移动端快捷导航\">\n    <button class=\"mobile-nav-item active\" data-mobile-action=\"home\"><span class=\"mobile-nav-icon\">⌂</span><span>首页</span></button>\n    <button class=\"mobile-nav-item\" data-mobile-action=\"favorites\"><span class=\"mobile-nav-icon\">☆</span><span>收藏</span></button>\n    <button class=\"mobile-nav-item\" data-mobile-action=\"recent\"><span class=\"mobile-nav-icon\">◷</span><span>最近</span></button>\n    <button class=\"mobile-nav-item\" data-mobile-action=\"search\"><span class=\"mobile-nav-icon\">⌕</span><span>搜索</span></button>\n  </nav>\n\n  <footer class=\"shell footer\">\n    <span id=\"footerText\">Personal navigation & short links</span>\n    <span>⌘K 快速搜索</span>\n  </footer>\n\n  <script src=\"/assets/common.js?v=1.0.0\" defer></script>\n  <script src=\"/assets/app.js?v=1.0.0\" defer></script>\n</body>\n</html>","admin.html":"<!doctype html>\n<html lang=\"zh-CN\">\n<head>\n  <meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n  <meta name=\"theme-color\" content=\"#0b0d12\"><title>管理后台</title>\n  <link rel=\"icon\" href=\"/assets/favicon.svg\"><link rel=\"stylesheet\" href=\"/assets/styles.css?v=1.0.0\">\n</head>\n<body class=\"admin-page\">\n  <div id=\"loginView\" class=\"login-view\">\n    <div class=\"login-card glass\">\n      <a class=\"brand\" href=\"/\"><span class=\"brand-mark\">S</span><span><b>SLink Nav</b><small>Admin Console</small></span></a>\n      <div class=\"eyebrow\">SECURE ACCESS</div><h1>欢迎回来</h1><p>输入管理员密码进入控制台。</p>\n      <form id=\"loginForm\"><label>管理员密码<input id=\"password\" type=\"password\" autocomplete=\"current-password\" required></label><button class=\"btn primary wide\">登录后台</button></form>\n      <div id=\"loginError\" class=\"form-error\"></div>\n    </div>\n  </div>\n  <div id=\"adminView\" class=\"admin-layout hidden\">\n    <aside class=\"sidebar\">\n      <a class=\"brand side-brand\" href=\"/\"><span class=\"brand-mark\">S</span><span><b>SLink Nav</b><small>Admin Console</small></span></a>\n      <nav>\n        <button class=\"side-item active\" data-section=\"overview\">⌂ <span>概览</span></button>\n        <button class=\"side-item\" data-section=\"links\">↗ <span>短链接管理</span></button>\n        <button class=\"side-item\" data-section=\"navigation\">▦ <span>导航管理</span></button>\n        <button class=\"side-item\" data-section=\"settings\">⚙ <span>系统管理</span></button>\n      </nav>\n      <div class=\"sidebar-bottom\"><a href=\"/\" target=\"_blank\">打开前台 ↗</a><button id=\"logoutBtn\">退出登录</button></div>\n    </aside>\n    <main class=\"admin-main\">\n      <header class=\"admin-header\"><div><span class=\"eyebrow\" id=\"sectionEyebrow\">OVERVIEW</span><h1 id=\"sectionTitle\">控制台</h1></div><div class=\"admin-header-actions\"><a class=\"mobile-home-btn\" href=\"/\" aria-label=\"打开前台\">首页</a><button class=\"icon-btn\" id=\"adminThemeBtn\">☾</button></div></header>\n      <section id=\"section-overview\" class=\"admin-section\">\n        <div class=\"stats-grid\" id=\"statsGrid\"></div>\n        <div class=\"dashboard-grid\">\n          <div class=\"panel\"><div class=\"panel-head\"><div><h3>点击趋势</h3><small>最近 14 天</small></div></div><div class=\"chart-wrap\"><canvas id=\"clickChart\"></canvas></div></div>\n          <div class=\"panel\"><div class=\"panel-head\"><div><h3>热门短链接</h3><small>按点击量排序</small></div></div><div id=\"topLinks\" class=\"mini-list\"></div></div>\n        </div>\n      </section>\n      <section id=\"section-links\" class=\"admin-section hidden\">\n        <div class=\"section-bar\"><div><h2>短链接管理</h2><p>创建、管理和分析你的短链接。</p></div><div class=\"bar-actions link-action-box\"><button class=\"btn secondary\" id=\"exportLinks\" type=\"button\">导出 CSV</button><button class=\"btn secondary\" id=\"importLinksBtn\" type=\"button\">导入 CSV</button><button class=\"btn primary\" id=\"addLinkBtn\" type=\"button\">+ 新建短链接</button></div></div>\n        <div class=\"panel table-panel\"><div class=\"table-tools\"><input id=\"linkSearch\" placeholder=\"搜索短链接…\"><div class=\"link-list-tools\"><label class=\"link-sort-control\" for=\"linkSort\">排序<select id=\"linkSort\"><option value=\"created_desc\">最新创建</option><option value=\"created_asc\">最早创建</option><option value=\"clicks_desc\">点击量从高到低</option><option value=\"clicks_asc\">点击量从低到高</option><option value=\"code_asc\">短码 A-Z</option><option value=\"code_desc\">短码 Z-A</option><option value=\"favorite_desc\">收藏优先</option></select></label><input id=\"csvFile\" class=\"csv-file-input\" type=\"file\" aria-label=\"选择 CSV 文件\"></div></div><div class=\"link-bulk-toolbar\" id=\"linkBulkToolbar\"><div class=\"link-bulk-selects\"><button class=\"text-btn\" id=\"selectPageLinks\" type=\"button\">选择本页</button><button class=\"text-btn\" id=\"selectAllLinks\" type=\"button\">选择全部</button><button class=\"text-btn\" id=\"clearSelectedLinks\" type=\"button\">取消选择</button><span id=\"linkSelectedCount\" class=\"bulk-count\">已选 0 项</span></div><div class=\"link-bulk-actions\"><button class=\"btn secondary\" id=\"bulkAddNav\" type=\"button\">加入导航</button><button class=\"btn secondary\" id=\"bulkRemoveNav\" type=\"button\">移出导航</button><button class=\"btn secondary\" id=\"bulkEnableLinks\" type=\"button\">启用</button><button class=\"btn secondary\" id=\"bulkDisableLinks\" type=\"button\">停用</button><button class=\"btn secondary danger-btn\" id=\"bulkDeleteLinks\" type=\"button\">删除</button></div></div><div class=\"table-scroll\"><table><thead><tr><th class=\"link-select-col\"><span class=\"sr-only\">选择</span></th><th>短码</th><th>目标</th><th>分类</th><th>点击</th><th>状态</th><th></th></tr></thead><tbody id=\"linksTable\"></tbody></table></div><div id=\"linksMobileList\" class=\"links-mobile-list\" aria-label=\"短链接列表\"></div><div id=\"linksPagination\" class=\"pagination\"></div></div>\n      </section>\n      <section id=\"section-navigation\" class=\"admin-section hidden\">\n        <div class=\"section-bar\"><div><h2>导航管理</h2><p>拖拽调整顺序；关联短链接会自动同步。<span id=\"navCount\" class=\"section-count\">0 项</span></p></div><div class=\"bar-actions\"><button class=\"btn secondary\" id=\"saveNavOrder\">保存排序</button><button class=\"btn primary\" id=\"addNavBtn\">+ 添加导航</button></div></div>\n        <div class=\"nav-admin-toolbar panel\">\n          <div class=\"nav-admin-search\"><span>⌕</span><input id=\"navSearch\" type=\"search\" placeholder=\"搜索标题、URL、分类…\" autocomplete=\"off\"></div>\n          <select id=\"navCategoryFilter\" aria-label=\"筛选分类\"><option value=\"\">全部分类</option></select>\n          <button class=\"text-btn\" id=\"clearNavFilter\" type=\"button\">清除</button>\n        </div>\n        <div id=\"navFilterHint\" class=\"nav-filter-hint hidden\">筛选状态下暂不支持拖拽排序，请清除筛选后调整顺序。</div>\n        <div class=\"link-bulk-toolbar nav-bulk-toolbar\" id=\"navAdminBulk\">\n          <div class=\"link-bulk-selects\">\n            <button class=\"text-btn\" id=\"selectPageNav\" type=\"button\">选择本页</button>\n            <button class=\"text-btn\" id=\"selectAllNav\" type=\"button\">选择全部</button>\n            <button class=\"text-btn\" id=\"clearSelectedNav\" type=\"button\">取消选择</button>\n            <span id=\"navSelectedCount\" class=\"bulk-count\">已选 0 项</span>\n          </div>\n          <div class=\"link-bulk-actions\">\n            <button class=\"btn secondary\" id=\"enableSelectedNav\" type=\"button\">启用</button>\n            <button class=\"btn secondary\" id=\"disableSelectedNav\" type=\"button\">停用</button>\n            <button class=\"btn secondary danger-btn\" id=\"deleteSelectedNav\" type=\"button\">删除</button>\n          </div>\n        </div>\n        <div id=\"navAdminGrid\" class=\"admin-nav-grid\"></div>\n        <div id=\"navPagination\" class=\"pagination\"></div>\n      </section>\n      <section id=\"section-settings\" class=\"admin-section hidden\">\n        <div class=\"section-bar\"><div><h2>系统管理</h2><p>按功能分区管理站点基础信息、导航显示以及数据备份恢复。</p></div></div>\n        <form id=\"settingsForm\" class=\"settings-settings-form\">\n        <div class=\"settings-tabs\" role=\"tablist\" aria-label=\"系统管理功能分类\">\n          <button class=\"settings-tab active\" type=\"button\" role=\"tab\" aria-selected=\"true\" aria-controls=\"settings-panel-basic\" data-settings-tab=\"basic\">⚙ 网站基础</button>\n          <button class=\"settings-tab\" type=\"button\" role=\"tab\" aria-selected=\"false\" aria-controls=\"settings-panel-navigation\" data-settings-tab=\"navigation\">▦ 导航显示</button>\n          <button class=\"settings-tab\" type=\"button\" role=\"tab\" aria-selected=\"false\" aria-controls=\"settings-panel-data\" data-settings-tab=\"data\">⇩ 数据管理</button>\n        </div>\n        <div class=\"settings-tab-panels\">\n          <section id=\"settings-panel-basic\" class=\"settings-tab-panel active\" data-settings-panel=\"basic\" role=\"tabpanel\">\n            <div class=\"settings-panel-head\"><span><strong>网站基础</strong><small>标题、首页文案、SEO 与视觉强调色</small></span></div>\n            <div class=\"settings-panel-content\">\n              <div class=\"settings-form settings-form-basic\">\n                <div class=\"settings-group\"><div><strong>网站基础</strong><small>前台首页的标题和说明。</small></div>\n                  <label>网站标题<input name=\"site_title\"></label>\n                  <label>副标题<input name=\"site_subtitle\"></label>\n                  <label>首页标题<input name=\"hero_title\" placeholder=\"Everything you need, one click away.\"></label>\n                  <label>首页描述<input name=\"hero_description\" placeholder=\"A fast, elegant home for your frequently used websites.\"></label>\n                  <label>SEO/站点描述<input name=\"site_description\" placeholder=\"用于站点描述\"></label>\n                  <label>强调色<input name=\"accent\" type=\"color\"></label>\n                </div>\n              </div>\n            </div>\n          </section>\n          <section id=\"settings-panel-navigation\" class=\"settings-tab-panel hidden\" data-settings-panel=\"navigation\" role=\"tabpanel\">\n            <div class=\"settings-panel-head\"><span><strong>导航显示</strong><small>分类标签、排序、隐藏分类与响应式布局</small></span></div>\n            <div class=\"settings-panel-content\">\n              <div class=\"settings-form settings-form-navigation\">\n                <div class=\"settings-group\"><div><strong>导航标签排版</strong><small>控制分类标签样式、分类顺序和隐藏分类。</small></div>\n                  <label>标签样式<select name=\"nav_tag_style\"><option value=\"pills\">胶囊标签</option><option value=\"tabs\">选项卡</option><option value=\"sections\">分类标题</option></select></label>\n                  <label>标签顺序<input name=\"nav_category_order\" placeholder=\"例如：常用,AI,工具,娱乐\"></label>\n                  <label>隐藏标签<input name=\"nav_hidden_categories\" placeholder=\"例如：其他,测试（多个用逗号分隔）\"></label>\n                </div>\n                <div class=\"settings-group\"><div><strong>每行显示数量</strong><small>手机、平板、电脑、大屏可以分别设置。</small></div>\n                  <div class=\"two settings-two\">\n                    <label>手机<input name=\"nav_columns_mobile\" type=\"number\" min=\"1\" max=\"6\"></label>\n                    <label>平板<input name=\"nav_columns_tablet\" type=\"number\" min=\"1\" max=\"6\"></label>\n                    <label>电脑<input name=\"nav_columns_desktop\" type=\"number\" min=\"1\" max=\"6\"></label>\n                    <label>大屏<input name=\"nav_columns_wide\" type=\"number\" min=\"1\" max=\"6\"></label>\n                  </div>\n                </div>\n              </div>\n            </div>\n          </section>\n          <section id=\"settings-panel-data\" class=\"settings-tab-panel hidden\" data-settings-panel=\"data\" role=\"tabpanel\">\n            <div class=\"settings-panel-head\"><span><strong>数据管理</strong><small>CSV 导入导出、JSON 备份与恢复</small></span></div>\n            <div class=\"settings-panel-content\">\n              <div class=\"settings-data-content\">\n                <div class=\"data-grid\">\n                  <div class=\"panel data-card\">\n                    <div class=\"panel-head\"><div><h3>CSV 导入</h3><small>先预览，再处理重复短码，不会直接写入数据库。</small></div></div>\n                    <div class=\"data-card-body\">\n                      <p class=\"data-note\">支持 <code>code,url,title,description,category,enabled</code>。重复短码可选择跳过、覆盖或自动生成新短码。</p>\n                      <div class=\"data-actions\"><button class=\"btn secondary\" id=\"dataExportCsvBtn\" type=\"button\">导出 CSV 文件</button><button class=\"btn secondary\" id=\"dataCsvBtn\" type=\"button\">导入 CSV 文件</button><input id=\"dataCsvFile\" class=\"csv-file-input\" type=\"file\" aria-label=\"选择 CSV 文件\"></div>\n                    </div>\n                  </div>\n                  <div class=\"panel data-card\">\n                    <div class=\"panel-head\"><div><h3>JSON 备份</h3><small>备份短链接、导航、设置及点击统计。</small></div></div>\n                    <div class=\"data-card-body\"><p class=\"data-note\">安全备份当前站点数据。备份文件可用于完整迁移或灾备，下载文件保存在你的设备上。</p><div class=\"data-actions\"><button class=\"btn primary\" id=\"backupJsonBtn\" type=\"button\">下载 JSON 备份</button></div></div>\n                  </div>\n                  <div class=\"panel data-card\">\n                    <div class=\"panel-head\"><div><h3>JSON 恢复</h3><small>支持合并恢复或完全覆盖恢复。</small></div></div>\n                    <div class=\"data-card-body\"><p class=\"data-note\">覆盖恢复会清空当前短链接、导航、统计和设置，再写入备份内容；操作前会再次确认。</p><div class=\"data-actions\"><button class=\"btn secondary\" id=\"restoreJsonBtn\" type=\"button\">选择 JSON 文件</button><input id=\"restoreJsonFile\" class=\"csv-file-input\" type=\"file\" accept=\".json,application/json\" aria-label=\"选择 JSON 备份文件\"></div></div>\n                  </div>\n                </div>\n                <div class=\"panel data-help\"><div class=\"panel-head\"><div><h3>恢复策略说明</h3><small>建议日常使用“合并恢复”，换站或灾难恢复使用“完全覆盖”。</small></div></div><div class=\"data-help-body\"><div><strong>合并恢复</strong><p>短链接按短码更新或新增；导航尽量按关联短链接恢复；设置覆盖同名项；不会删除当前未出现在备份中的数据。</p></div><div><strong>完全覆盖</strong><p>先清空现有业务数据，再恢复备份中的全部数据。适合将当前站点恢复到备份时的状态。</p></div></div></div>\n              </div>\n            </div>\n          </section>\n        </div>\n        <div class=\"settings-save-bar\"><button class=\"btn primary\" type=\"submit\">保存设置</button><div id=\"settingsMessage\" class=\"form-success\"></div></div>\n        </form>\n      </section>\n    </main>\n  </div>\n  <div id=\"modal\" class=\"modal hidden\"><div class=\"modal-backdrop\" data-close-modal></div><div class=\"modal-card\"><div class=\"modal-head\"><h3 id=\"modalTitle\"></h3><button class=\"icon-btn\" data-close-modal>×</button></div><div id=\"modalBody\"></div></div></div>\n  <div id=\"toastRoot\" class=\"toast-root\"></div>\n  <script>\n    // Keep the admin page out of stale service-worker caches. The public\n    // homepage can remain cached, but management assets must always update.\n    if (\"serviceWorker\" in navigator) {\n      navigator.serviceWorker.register(\"/sw.js?v=1.0.0\", { updateViaCache: \"none\" }).catch(() => {});\n    }\n  </script>\n  <script src=\"/assets/common.js?v=1.0.0\" defer></script>\n  <script src=\"/assets/admin.js?v=1.0.0\" defer></script>\n</body>\n</html>\n","styles.css":":root{--bg:#090b10;--bg2:#0f1219;--surface:rgba(19,23,32,.72);--surface2:rgba(255,255,255,.055);--surface3:rgba(255,255,255,.09);--text:#f5f7fb;--muted:#98a1b2;--faint:#687184;--border:rgba(255,255,255,.09);--border2:rgba(255,255,255,.16);--primary:#8b6cff;--primary2:#6c8cff;--cyan:#56d6ff;--success:#51d69b;--danger:#ff6f82;--shadow:0 24px 70px rgba(0,0,0,.28);--radius:20px;--max:1180px;--nav-columns-mobile:2;--nav-columns-tablet:3;--nav-columns-desktop:4;--nav-columns-wide:6;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif}\nhtml{scroll-behavior:smooth}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 15% 0,rgba(139,108,255,.13),transparent 30%),radial-gradient(circle at 90% 15%,rgba(86,214,255,.08),transparent 28%),linear-gradient(145deg,var(--bg),var(--bg2));color:var(--text);font-size:15px}body:before{content:\"\";position:fixed;inset:0;pointer-events:none;opacity:.28;background-image:radial-gradient(rgba(255,255,255,.18) .5px,transparent .5px);background-size:4px 4px;mask-image:linear-gradient(to bottom,black,transparent 85%)}a{color:inherit;text-decoration:none}button,input,textarea,select{font:inherit}button{cursor:pointer}.shell{width:min(calc(100% - 40px),var(--max));margin:auto}.topbar{position:sticky;top:14px;z-index:20;height:68px;display:flex;align-items:center;justify-content:space-between;padding:0 14px;border:1px solid var(--border);border-radius:18px;background:var(--surface);backdrop-filter:blur(24px);box-shadow:0 14px 40px rgba(0,0,0,.16)}.brand{display:flex;align-items:center;gap:12px}.brand-mark{display:grid;place-items:center;width:38px;height:38px;border-radius:12px;background:linear-gradient(135deg,var(--primary),var(--primary2));box-shadow:0 10px 30px rgba(124,92,255,.3);font-weight:800}.brand b{display:block;font-size:14px;letter-spacing:.01em}.brand small{display:block;color:var(--faint);font-size:11px;margin-top:2px}.top-actions,.admin-header-actions{display:flex;align-items:center;gap:10px}.icon-btn,.text-btn{border:1px solid var(--border);background:var(--surface2);color:var(--muted);border-radius:12px}.icon-btn{width:40px;height:40px}.text-btn{padding:8px 12px}.admin-link{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;padding:0;border:1px solid var(--border2);border-radius:12px;color:var(--text);background:var(--surface2);font-size:12px;font-weight:650;white-space:nowrap}.hero{padding:82px 0 48px;max-width:820px}.eyebrow{font-size:10px;font-weight:800;letter-spacing:.18em;color:var(--primary);margin-bottom:14px}.hero h1{font-size:clamp(38px,6vw,70px);line-height:.98;letter-spacing:-.055em;margin:0 0 22px}.hero p{font-size:17px;color:var(--muted);max-width:650px;margin:0 0 30px;line-height:1.7}.search-panel{width:100%;min-width:0}.search-engines{display:flex;align-items:stretch;gap:8px;margin-bottom:10px;overflow-x:auto;scrollbar-width:none}.search-engines::-webkit-scrollbar{display:none}.search-engine{flex:0 0 auto;min-height:44px;padding:0 19px;border:1px solid var(--border);border-radius:12px;background:var(--surface2);color:var(--muted);font-weight:650;white-space:nowrap;transition:.2s ease}.search-engine:hover{border-color:var(--border2);color:var(--text)}.search-engine.active{color:#fff;border-color:rgba(139,108,255,.65);background:var(--primary);box-shadow:0 8px 22px rgba(124,92,255,.22)}.search-engine:focus-visible{outline:2px solid var(--primary);outline-offset:2px}.search-wrap{height:60px;display:flex;align-items:center;gap:12px;padding:0 15px;border:1px solid var(--border2);border-radius:18px;background:rgba(255,255,255,.045);box-shadow:var(--shadow);backdrop-filter:blur(22px)}.search-wrap span{font-size:25px;color:var(--faint)}.search-wrap input{flex:1;min-width:0;background:none;border:0;outline:0;color:var(--text);font-size:15px}.search-submit{flex:0 0 auto;height:40px;padding:0 15px;border:1px solid color-mix(in srgb,var(--primary) 65%,var(--border2));border-radius:11px;background:var(--primary);color:#fff;font-size:13px;font-weight:750;white-space:nowrap;box-shadow:0 8px 20px rgba(124,92,255,.18);transition:.2s ease}.search-submit:hover{filter:brightness(1.08);transform:translateY(-1px)}.search-submit:active{transform:translateY(0)}.search-submit:focus-visible{outline:2px solid var(--primary);outline-offset:2px}.search-wrap kbd{font-size:11px;color:var(--faint);border:1px solid var(--border);padding:5px 8px;border-radius:8px}.toolbar{display:flex;justify-content:space-between;align-items:center;gap:15px;margin:5px 0 22px}.chips{display:flex;gap:8px;overflow:auto;scrollbar-width:none}.chip{white-space:nowrap;border:1px solid var(--border);background:var(--surface2);color:var(--muted);padding:8px 13px;border-radius:999px;transition:.2s}.chip:hover{border-color:var(--border2);color:var(--text)}.chip.active{color:#fff;border-color:rgba(139,108,255,.45);background:rgba(139,108,255,.16)}html[data-nav-tag-style=\"tabs\"] .chip{border-radius:10px;padding:8px 15px}html[data-nav-tag-style=\"tabs\"] .chip.active{background:var(--primary);border-color:var(--primary)}html[data-nav-tag-style=\"sections\"] .toolbar{margin-bottom:28px}.nav-grid{display:grid;grid-template-columns:repeat(var(--nav-columns-desktop),minmax(0,1fr));gap:14px}.nav-card{position:relative;min-height:180px;padding:20px;border:1px solid var(--border);border-radius:var(--radius);background:linear-gradient(145deg,rgba(255,255,255,.065),rgba(255,255,255,.025));backdrop-filter:blur(18px);transition:.25s ease;overflow:hidden;display:flex;flex-direction:column}.nav-card:after{content:\"\";position:absolute;width:150px;height:150px;right:-70px;top:-70px;border-radius:50%;background:rgba(139,108,255,.12);filter:blur(25px);pointer-events:none}.nav-card:hover{transform:translateY(-5px);border-color:var(--border2);box-shadow:0 22px 50px rgba(0,0,0,.25)}.nav-top{display:flex;justify-content:space-between;align-items:flex-start;position:relative;z-index:2}.nav-card-open{display:block}.site-icon{width:46px;height:46px;border-radius:14px;object-fit:cover;background:var(--surface3);padding:8px}.site-icon-fallback{display:grid;place-items:center;font-weight:800;font-size:19px;color:#fff;background:linear-gradient(135deg,var(--primary),var(--primary2));padding:0}.nav-card-actions{display:flex;align-items:center;gap:4px;position:relative;z-index:3}.favorite,.copy-btn{border:0;background:none;color:var(--faint);font-size:19px;width:32px;height:32px;border-radius:9px;display:grid;place-items:center}.favorite:hover,.copy-btn:hover{background:var(--surface3);color:var(--text)}.favorite.active{color:#ffd35a}.copy-btn{font-size:17px}.nav-card-content{position:relative;z-index:2;display:block}.nav-card h3{margin:20px 0 6px;font-size:16px}.nav-card p{margin:0;color:var(--muted);font-size:13px;line-height:1.55;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.nav-meta{display:flex;gap:7px;flex-wrap:wrap;margin-top:auto;padding-top:15px;position:relative;z-index:2}.tag{font-size:10px;color:var(--faint);padding:5px 8px;border-radius:7px;background:rgba(255,255,255,.045)}.link-tag{color:var(--primary);background:rgba(139,108,255,.1)}.nav-category-section{margin-bottom:34px}.nav-category-heading{display:flex;align-items:center;gap:9px;margin:0 0 13px;font-size:17px;font-weight:750}.nav-category-heading:after{content:\"\";height:1px;flex:1;background:var(--border)}.nav-category-heading b{font-size:10px;color:var(--faint);font-weight:600;padding:4px 7px;border:1px solid var(--border);border-radius:999px}.nav-grid-section{display:grid;grid-template-columns:repeat(var(--nav-columns-desktop),minmax(0,1fr));gap:14px}.empty-state{text-align:center;padding:70px 20px;color:var(--muted)}.empty-icon{font-size:45px}.hidden{display:none!important}\n/* CSV import: the native file input is intentionally not nested inside the\n   button/label. It is opened only from a direct user click, which is more\n   reliable across iOS, Android and embedded WebViews. */\n.csv-file-input{position:fixed!important;left:-10000px!important;top:auto!important;width:1px!important;height:1px!important;opacity:0!important;pointer-events:none!important}\n.recent-section{padding:90px 0 45px}.section-heading{display:flex;justify-content:space-between;align-items:end;margin-bottom:20px}.section-heading h2,.section-bar h2{margin:0;font-size:24px}.section-heading .eyebrow{margin-bottom:7px}.recent-grid{display:flex;gap:10px;flex-wrap:wrap}.recent-item{display:flex;align-items:center;gap:10px;padding:10px 13px;border:1px solid var(--border);border-radius:13px;background:var(--surface2);color:var(--muted)}.recent-item img,.recent-icon-fallback{width:24px;height:24px;border-radius:7px}.recent-icon-fallback{display:grid;place-items:center;background:var(--surface3);font-size:14px}.footer{display:flex;justify-content:space-between;padding:25px 0 35px;color:var(--faint);font-size:11px;border-top:1px solid var(--border)}\n/* admin */\n.admin-layout{display:grid;grid-template-columns:250px 1fr;min-height:100vh}.sidebar{position:sticky;top:0;height:100vh;border-right:1px solid var(--border);background:rgba(10,12,17,.72);backdrop-filter:blur(24px);padding:26px 16px;display:flex;flex-direction:column}.side-brand{padding:0 10px 28px}.sidebar nav{display:grid;gap:6px}.side-item{display:flex;gap:12px;align-items:center;border:0;background:none;color:var(--muted);padding:12px 13px;border-radius:12px;text-align:left}.side-item:hover,.side-item.active{color:#fff;background:var(--surface3)}.side-item.active{box-shadow:inset 2px 0 var(--primary)}.sidebar-bottom{margin-top:auto;display:grid;gap:6px}.sidebar-bottom a,.sidebar-bottom button{border:0;background:none;color:var(--faint);text-align:left;padding:11px 13px}.admin-main{padding:0 34px 50px;max-width:1500px;width:100%}.admin-header{height:72px;display:flex;justify-content:space-between;align-items:center;gap:16px;position:sticky;top:14px;z-index:30;margin:14px 0 30px;padding:0 14px;border:1px solid var(--border);border-radius:18px;background:var(--surface);backdrop-filter:blur(24px);box-shadow:0 14px 40px rgba(0,0,0,.16)}.admin-header h1{margin:0;font-size:25px}.stats-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:18px}.stat-card,.panel{border:1px solid var(--border);background:var(--surface);backdrop-filter:blur(18px);border-radius:18px;box-shadow:0 18px 50px rgba(0,0,0,.12)}.stat-card{padding:20px}.stat-label{color:var(--muted);font-size:12px}.stat-value{font-size:30px;font-weight:750;margin-top:8px}.dashboard-grid{display:grid;grid-template-columns:1.6fr 1fr;gap:18px}.panel-head,.section-bar,.table-tools,.modal-head{display:flex;justify-content:space-between;align-items:center;gap:15px}.panel-head{padding:20px 20px 0}.panel h3{margin:0}.panel small,.section-bar p{color:var(--faint)}.chart-wrap{height:300px;padding:20px;overflow:hidden}.chart-wrap canvas{display:block;width:100%;height:100%;max-width:100%;max-height:100%;box-sizing:border-box}.mini-list{padding:8px 20px 18px}.mini-row{display:flex;justify-content:space-between;gap:10px;padding:14px 0;border-bottom:1px solid var(--border)}.mini-row:last-child{border-bottom:0}.mini-row small{display:block}.admin-section{animation:fadeUp .25s ease}.section-bar{margin-bottom:22px}.section-bar p{margin:6px 0 0;font-size:13px}.bar-actions{display:flex;align-items:center;gap:8px;flex-wrap:nowrap;white-space:nowrap}\n.admin-page #section-links .link-action-box{flex:0 0 auto;display:flex;align-items:center;gap:8px;flex-wrap:nowrap;white-space:nowrap}\n.admin-page #section-links .link-action-box .btn{flex:0 0 auto;white-space:nowrap}.btn{border:1px solid var(--border2);border-radius:11px;padding:10px 14px;background:var(--surface2);color:var(--text)}.btn.primary{background:linear-gradient(135deg,var(--primary),var(--primary2));border:0;color:white}.btn.secondary{color:var(--muted)}.btn.wide{width:100%;padding:13px}.table-panel{overflow:hidden}.table-tools{padding:15px;border-bottom:1px solid var(--border)}.link-bulk-toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 15px;border-bottom:1px solid var(--border);background:rgba(255,255,255,.018)}.link-bulk-selects,.link-bulk-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.bulk-count{font-size:12px;color:var(--faint);margin-left:2px}.link-select-col{width:44px}.link-select{width:16px;height:16px;accent-color:var(--primary)}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.table-tools input,.settings-form input,.settings-form select,.modal-card input,.modal-card textarea,.modal-card select,.login-card input{width:100%;border:1px solid var(--border2);background:rgba(0,0,0,.14);color:var(--text);border-radius:11px;padding:11px 12px;outline:none}.table-tools input{max-width:360px}.table-scroll{overflow:auto}table{width:100%;border-collapse:collapse;min-width:760px}th,td{text-align:left;padding:14px 16px;border-bottom:1px solid var(--border);font-size:13px}th{color:var(--faint);font-size:11px;text-transform:uppercase;letter-spacing:.08em}td{color:var(--muted)}td strong{color:var(--text)}.row-actions{display:flex;justify-content:flex-end;gap:4px}.small-btn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;min-width:30px;min-height:30px;padding:0;border:1px solid var(--border);background:var(--surface2);color:var(--muted);border-radius:8px;font-size:11px;line-height:1} .status{font-size:10px;padding:5px 8px;border-radius:99px}.status.on{color:var(--success);background:rgba(81,214,155,.09)}.status.off{color:var(--danger);background:rgba(255,111,130,.09)}.data-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-bottom:18px}.data-card{min-width:0}.data-card-body{padding:16px 20px 20px;display:grid;gap:14px}.data-note{margin:0;color:var(--muted);font-size:12px;line-height:1.7}.data-note code{font-size:10px;color:var(--text)}.data-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.data-help{padding-bottom:2px}.data-help-body{display:grid;grid-template-columns:1fr 1fr;gap:18px;padding:8px 20px 20px}.data-help-body>div{padding:14px;border:1px solid var(--border);border-radius:12px;background:rgba(255,255,255,.02)}.data-help-body strong{font-size:13px}.data-help-body p{margin:7px 0 0;color:var(--muted);font-size:12px;line-height:1.65}.import-summary,.restore-summary{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px;border:1px solid var(--border);border-radius:12px;background:var(--surface2);font-size:12px}.import-summary span,.restore-summary span{color:var(--muted)}.import-options{display:grid;gap:8px}.import-options label{display:grid;gap:7px;color:var(--muted);font-size:12px}.import-options select{width:100%;border:1px solid var(--border2);background:var(--surface2);color:var(--text);border-radius:10px;padding:10px}.import-preview-scroll{max-height:45vh;overflow:auto;border:1px solid var(--border);border-radius:12px}.import-preview-table{width:100%;min-width:560px;border-collapse:collapse}.import-preview-table th,.import-preview-table td{padding:9px 10px;font-size:11px;border-bottom:1px solid var(--border);text-align:left}.import-preview-table th{position:sticky;top:0;background:var(--surface);z-index:1;color:var(--faint)}.import-preview-table td{color:var(--muted)}.import-status{display:inline-flex;padding:3px 7px;border-radius:999px;font-size:10px}.import-status.good{color:var(--success);background:rgba(81,214,155,.09)}.import-status.warn{color:#e7bd66;background:rgba(231,189,102,.1)}.import-status.bad{color:var(--danger);background:rgba(255,111,130,.09)}.modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:6px}.settings-form{max-width:820px;padding:24px;display:grid;gap:22px}.settings-group{display:grid;gap:14px;padding-bottom:20px;border-bottom:1px solid var(--border)}.settings-group>div{display:grid;gap:4px}.settings-group strong{font-size:14px}.settings-group small{color:var(--faint);font-size:11px}.settings-two{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.settings-form label,.modal-card label,.login-card label{display:grid;gap:7px;color:var(--muted);font-size:12px}.form-note{padding:10px 12px;border-radius:10px;background:rgba(139,108,255,.08);color:var(--muted);font-size:12px;line-height:1.5}.form-success,.form-error{min-height:18px;font-size:12px}.form-success{color:var(--success)}.form-error{color:var(--danger)}.login-view{min-height:100vh;display:grid;place-items:center;padding:20px}.login-card{width:min(430px,100%);padding:34px}.glass{border:1px solid var(--border);background:var(--surface);backdrop-filter:blur(25px);box-shadow:var(--shadow);border-radius:24px}.login-card h1{font-size:32px;margin:8px 0}.login-card p{color:var(--muted);line-height:1.6;margin:0 0 25px}.login-card form{display:grid;gap:17px}.modal{position:fixed;inset:0;z-index:50;display:grid;place-items:center;padding:20px}.modal-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.65);backdrop-filter:blur(7px)}.modal-card{position:relative;width:min(560px,100%);max-height:90vh;overflow:auto;border:1px solid var(--border2);background:#12161f;border-radius:20px;box-shadow:var(--shadow);padding:22px}.modal-head{margin-bottom:20px}.modal-head h3{margin:0}.modal-form{display:grid;gap:14px}.modal-form .two{display:grid;grid-template-columns:1fr 1fr;gap:12px}.checkbox{display:flex!important;grid-template-columns:none!important;align-items:center;gap:8px!important}.checkbox input{width:auto!important}.toast-root{position:fixed;right:20px;bottom:20px;display:grid;gap:8px;z-index:100}.toast{padding:12px 15px;border:1px solid var(--border2);border-radius:12px;background:#171c26;color:#fff;box-shadow:var(--shadow);animation:fadeUp .2s ease}.login-card .brand{margin-bottom:40px}.link-target{max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.link-mini-title{\n  display:flex;\n  flex-direction:column;\n  gap:4px;\n}\n\n.link-mini-title span{\n  font-size:11px;\n  color:var(--faint);\n}\n\n.link-card-row td{\n  padding-top:11px;\n  padding-bottom:11px;\n}\n\n.compact-actions{\n  gap:5px;\n}\n\n.compact-actions .small-btn{\n  min-width:34px;\n  padding:5px 8px;\n  font-size:12px;\n}\n.danger-btn{color:var(--danger)!important}\n.link-dense-row td{\n  padding:8px 12px;\n  height:42px;\n}\n\n.link-dense-title{\n  max-width:280px;\n  overflow:hidden;\n  text-overflow:ellipsis;\n  white-space:nowrap;\n}\n\n.click-count{\n  font-size:12px;\n  color:var(--faint);\n}\n\n.link-dense-row .small-btn{\n  padding:4px 7px;\n  min-width:30px;\n  height:28px;\n}\n\n.link-dense-row .row-actions{\n  gap:4px;\n}\n.mobile-home-btn{display:none}\nhtml[data-theme=\"light\"]{--bg:#f4f6fb;--bg2:#eef1f7;--surface:rgba(255,255,255,.78);--surface2:rgba(0,0,0,.035);--surface3:rgba(0,0,0,.06);--text:#151821;--muted:#657084;--faint:#8993a5;--border:rgba(20,25,35,.10);--border2:rgba(20,25,35,.18)}html.light-admin{--bg:#f4f6fb;--bg2:#eef1f7;--surface:rgba(255,255,255,.82);--surface2:rgba(0,0,0,.035);--surface3:rgba(0,0,0,.06);--text:#151821;--muted:#657084;--faint:#8993a5;--border:rgba(20,25,35,.10);--border2:rgba(20,25,35,.18)}html.light-admin .sidebar{background:rgba(255,255,255,.72)}html.light-admin .modal-card{background:#fff}\n@keyframes fadeUp{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}\n@media(min-width:1200px){.nav-grid,.nav-grid-section{grid-template-columns:repeat(var(--nav-columns-wide),minmax(0,1fr))}}\n@media(max-width:1100px){.nav-grid,.nav-grid-section{grid-template-columns:repeat(var(--nav-columns-tablet),minmax(0,1fr))}.dashboard-grid{grid-template-columns:1fr}.stats-grid{grid-template-columns:repeat(2,1fr)}.admin-layout{grid-template-columns:1fr}.sidebar{position:relative;height:auto;min-height:auto;border-right:0;border-bottom:1px solid var(--border);padding:15px;display:block}.side-brand{padding:0 5px 12px}.sidebar nav{display:flex;overflow:auto}.side-item{white-space:nowrap}.sidebar-bottom{display:none}.admin-main{padding:0 18px 35px}}\n@media(max-width:760px){.link-bulk-toolbar{align-items:stretch;flex-direction:column}.link-bulk-selects,.link-bulk-actions{width:100%}.link-bulk-actions .btn{flex:1;min-width:130px}.topbar{top:8px;height:62px;border-radius:16px}.shell{width:min(calc(100% - 24px),var(--max))}}@media(max-width:600px){.shell{width:min(calc(100% - 28px),var(--max))}.topbar{height:64px;gap:10px}.brand{min-width:0}.brand>span:last-child{min-width:0}.brand b,.brand small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}.admin-link{width:40px;height:40px;min-height:40px;padding:0}.top-actions{gap:7px}.icon-btn{width:40px;height:40px}.hero{padding:42px 0 25px}.hero h1{font-size:34px;line-height:1.12;letter-spacing:-.03em}.hero p{font-size:14px}.search-wrap{height:48px}.search-wrap kbd{display:none}.toolbar{gap:10px;align-items:flex-start}.chips{overflow-x:auto;flex-wrap:nowrap;padding-bottom:4px;max-width:100%;scrollbar-width:none}.chips::-webkit-scrollbar{display:none}.nav-grid,.nav-grid-section{grid-template-columns:repeat(var(--nav-columns-mobile),minmax(0,1fr));gap:9px}.nav-card{min-height:145px;padding:14px;border-radius:16px}.site-icon{width:40px;height:40px;border-radius:12px}.nav-card h3{margin:14px 0 5px;font-size:14px}.nav-card p{font-size:12px}.nav-meta{padding-top:10px}.tag{font-size:9px;padding:4px 6px}.recent-section{padding:65px 0 35px}.footer{padding-bottom:calc(18px + env(safe-area-inset-bottom));flex-direction:column;gap:8px}.admin-link{display:inline-flex}.admin-layout{display:block}.sidebar{position:sticky;top:0;z-index:20;background:rgba(10,12,17,.94);backdrop-filter:blur(20px);padding:10px 12px}.side-brand{display:none}.sidebar nav{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:5px;overflow:visible}.side-item{justify-content:center;flex-direction:column;gap:2px;padding:9px 4px;border-radius:10px;font-size:11px;min-height:52px}.admin-main{padding:0 12px 28px}.admin-header{height:64px;margin:0 0 18px;position:sticky;top:10px;z-index:30;padding:0 10px;border-radius:16px;background:var(--surface);box-shadow:0 12px 30px rgba(0,0,0,.14)}.admin-header h1{font-size:22px}.mobile-home-btn{display:inline-flex;align-items:center;justify-content:center;min-height:38px;padding:0 11px;border:1px solid var(--border2);border-radius:10px;color:var(--muted);text-decoration:none;font-size:12px}.admin-header-actions{gap:6px}.stats-grid{grid-template-columns:1fr 1fr;gap:8px}.stat-card{padding:13px;border-radius:14px}.stat-value{font-size:22px}.dashboard-grid{gap:10px}.chart-wrap{height:210px;padding:12px}.section-bar{margin-bottom:14px;align-items:flex-start;flex-direction:column}.section-bar h2{font-size:20px}.bar-actions{width:100%;display:grid;grid-template-columns:1fr 1fr;gap:7px}.bar-actions .btn{min-height:44px}.table-panel{border-radius:14px;background:transparent;border:0;overflow:visible}.table-tools{padding:0 0 10px;border:0;align-items:stretch;flex-direction:column}.table-tools input{max-width:none;min-height:44px}.table-scroll{overflow:visible}table{min-width:0;border-collapse:separate;border-spacing:0 8px}table thead{display:none}table tbody,table tr,table td{display:block;width:100%;box-sizing:border-box}table tr{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:10px 12px;box-shadow:0 10px 28px rgba(0,0,0,.08)}table td{border:0;border-bottom:1px solid var(--border);padding:8px 0;display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:13px}table td:last-child{border-bottom:0;padding-bottom:2px}table td::before{content:attr(data-label);color:var(--faint);font-size:11px;flex:0 0 auto}table td>*{max-width:70%}.link-target{max-width:70%;text-align:right}.row-actions{justify-content:flex-end;flex-wrap:wrap;gap:5px}.small-btn{min-height:36px;padding:7px 9px}.settings-form{padding:16px;border-radius:14px}.settings-two{grid-template-columns:1fr 1fr}.modal{padding:10px}.modal-card{max-height:calc(100vh - 20px);border-radius:18px;padding:17px}.modal-form .two{grid-template-columns:1fr}.login-view{padding:14px}.login-card{padding:22px 18px;border-radius:20px}.login-card h1{font-size:28px}}\n@media(max-width:380px){.admin-link{font-size:12px;padding:0}.top-actions .icon-btn{display:grid}.shell{width:calc(100% - 20px)}.stats-grid{gap:6px}.stat-value{font-size:20px}.nav-grid,.nav-grid-section{grid-template-columns:1fr}}\n\n@media (max-width: 600px) {\n  :root {\n    --mobile-gap: 10px;\n    --mobile-radius: 14px;\n  }\n\n  html { scroll-behavior: auto; }\n  body {\n    font-size: 14px;\n    overflow-x: hidden;\n    -webkit-text-size-adjust: 100%;\n  }\n\n  /* Public home */\n  body.public-page {\n    padding-bottom: env(safe-area-inset-bottom);\n  }\n  .public-page .shell {\n    width: min(calc(100% - 24px), var(--max));\n  }\n  .public-page .topbar {\n    min-height: 64px;\n    height: auto;\n    padding: 8px 0;\n  }\n  .public-page .brand-mark {\n    width: 36px;\n    height: 36px;\n    border-radius: 11px;\n  }\n  .public-page .brand b { font-size: 13px; }\n  .public-page .brand small { font-size: 10px; }\n  .public-page .top-actions { gap: 6px; }\n  .public-page .icon-btn,\n  .public-page .admin-link {\n    min-width: 44px;\n    min-height: 44px;\n  }\n  .public-page .icon-btn {\n    width: 44px;\n    height: 44px;\n  }\n  .public-page .admin-link {\n    padding: 0 12px;\n    font-size: 12px;\n  }\n\n  .public-page .hero {\n    padding: 38px 0 26px;\n  }\n  .public-page .hero h1 {\n    font-size: clamp(32px, 9vw, 46px);\n    line-height: 1.08;\n    letter-spacing: -.035em;\n    margin-bottom: 16px;\n  }\n  .public-page .hero p {\n    font-size: 14px;\n    line-height: 1.65;\n    margin-bottom: 22px;\n  }\n  .public-page .search-engines{gap:7px;margin-bottom:9px;padding-bottom:2px}.public-page .search-engine{min-height:43px;padding:0 15px;border-radius:11px;font-size:13px}.public-page .search-wrap {\n    height: 52px;\n    padding: 0 10px 0 13px;\n    gap: 8px;\n    border-radius: 14px;\n  }\n  .public-page .search-wrap input {\n    min-width: 0;\n    font-size: 16px; /* prevents iOS Safari auto-zoom */\n  }\n  .public-page .search-submit{height:38px;padding:0 12px;font-size:12px;border-radius:10px}\n  .public-page .search-wrap span { font-size: 22px; }\n  .public-page .search-wrap kbd { display: none; }\n\n  .public-page .toolbar {\n    position: sticky;\n    top: 0;\n    z-index: 10;\n    margin: 0 -12px 14px;\n    padding: 8px 12px;\n    background: color-mix(in srgb, var(--bg) 90%, transparent);\n    border-bottom: 1px solid var(--border);\n    backdrop-filter: blur(16px);\n    -webkit-backdrop-filter: blur(16px);\n  }\n  .public-page .chips {\n    min-width: 0;\n    flex: 1;\n    gap: 7px;\n    padding-bottom: 0;\n  }\n  .public-page .chip,\n  .public-page .text-btn {\n    min-height: 40px;\n    font-size: 13px;\n  }\n  .public-page .chip { padding: 7px 12px; }\n  .public-page .text-btn {\n    flex: none;\n    padding: 7px 10px;\n  }\n\n  .public-page .nav-grid,\n  .public-page .nav-grid-section {\n    grid-template-columns: repeat(var(--nav-columns-mobile), minmax(0, 1fr));\n    gap: var(--mobile-gap);\n  }\n  .public-page .nav-card {\n    min-height: 164px;\n    padding: 14px;\n    border-radius: var(--mobile-radius);\n  }\n  .public-page .site-icon {\n    width: 42px;\n    height: 42px;\n    border-radius: 12px;\n    padding: 7px;\n  }\n  .public-page .favorite,\n  .public-page .copy-btn {\n    width: 40px;\n    height: 40px;\n    font-size: 18px;\n  }\n  .public-page .nav-card h3 {\n    margin: 14px 0 6px;\n    font-size: 14px;\n    line-height: 1.3;\n  }\n  .public-page .nav-card p {\n    font-size: 12px;\n    line-height: 1.5;\n  }\n  .public-page .nav-meta {\n    padding-top: 11px;\n  }\n  .public-page .tag {\n    font-size: 10px;\n    padding: 4px 7px;\n  }\n  .public-page .recent-section {\n    padding: 58px 0 30px;\n  }\n  .public-page .recent-grid {\n    gap: 8px;\n  }\n  .public-page .recent-item {\n    min-height: 42px;\n    padding: 8px 11px;\n    font-size: 12px;\n  }\n  .public-page .footer {\n    padding: 22px 0 calc(22px + env(safe-area-inset-bottom));\n    gap: 7px;\n  }\n\n  /* Admin shell */\n  body.admin-page input,\n  body.admin-page select,\n  body.admin-page textarea,\n  body.admin-page button {\n    font-size: 16px;\n  }\n  .admin-layout {\n    display: block;\n    min-height: 100dvh;\n  }\n  .admin-page .sidebar {\n    position: sticky;\n    top: 0;\n    z-index: 30;\n    height: auto;\n    min-height: 0;\n    padding: 7px 10px calc(7px + env(safe-area-inset-top));\n    border-right: 0;\n    border-bottom: 1px solid var(--border);\n    background: rgba(10,12,17,.94);\n    backdrop-filter: blur(18px);\n    -webkit-backdrop-filter: blur(18px);\n  }\n  .admin-page .side-brand,\n  .admin-page .sidebar-bottom { display: none; }\n  .admin-page .sidebar nav {\n    display: grid;\n    grid-template-columns: repeat(4, minmax(0,1fr));\n    gap: 5px;\n    overflow: visible;\n  }\n  .admin-page .side-item {\n    min-width: 0;\n    min-height: 48px;\n    padding: 6px 3px;\n    border-radius: 10px;\n    justify-content: center;\n    flex-direction: column;\n    gap: 3px;\n    font-size: 11px !important;\n    line-height: 1.1;\n  }\n\n  .admin-page .admin-main {\n    width: 100%;\n    max-width: none;\n    min-width: 0;\n    padding: 0 12px calc(28px + env(safe-area-inset-bottom));\n  }\n  .admin-page .admin-header {\n    min-height: 66px;\n    height: auto;\n    margin: 0 0 14px;\n    padding: 10px 0;\n    gap: 8px;\n  }\n  .admin-page .admin-header h1 {\n    font-size: 20px;\n    line-height: 1.2;\n  }\n  .admin-page .admin-header-actions {\n    flex: none;\n    gap: 6px;\n  }\n  .admin-page .mobile-home-btn,\n  .admin-page .admin-header-actions .icon-btn {\n    min-width: 44px;\n    min-height: 44px;\n  }\n  .admin-page .mobile-home-btn {\n    font-size: 13px !important;\n    padding: 0 10px;\n  }\n\n  /* Dashboard */\n  .admin-page .stats-grid {\n    grid-template-columns: repeat(2, minmax(0,1fr));\n    gap: 8px;\n    margin-bottom: 10px;\n  }\n  .admin-page .stat-card {\n    min-width: 0;\n    padding: 12px;\n    border-radius: var(--mobile-radius);\n  }\n  .admin-page .stat-label {\n    font-size: 11px;\n    line-height: 1.2;\n  }\n  .admin-page .stat-value {\n    margin-top: 5px;\n    font-size: 21px;\n    line-height: 1.1;\n  }\n  .admin-page .dashboard-grid {\n    grid-template-columns: minmax(0,1fr);\n    gap: 10px;\n  }\n  .admin-page .panel {\n    min-width: 0;\n    border-radius: var(--mobile-radius);\n  }\n  .admin-page .panel-head {\n    padding: 14px 13px 0;\n  }\n  .admin-page .panel h3 {\n    font-size: 13px;\n  }\n  .admin-page .panel small {\n    font-size: 10px;\n  }\n  .admin-page .chart-wrap {\n    width: 100%;\n    height: 190px;\n    padding: 8px;\n    overflow: hidden;\n  }\n  .admin-page .chart-wrap canvas {\n    display: block;\n    width: 100% !important;\n    height: 100% !important;\n    max-width: 100%;\n    max-height: 100%;\n    box-sizing: border-box;\n  }\n  .admin-page .mini-list {\n    padding: 5px 13px 12px;\n    overflow: hidden;\n  }\n  .admin-page .mini-row {\n    gap: 8px;\n    padding: 10px 0;\n  }\n  .admin-page .mini-row > div {\n    min-width: 0;\n  }\n  .admin-page .mini-row small {\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n  }\n\n  /* Section headers / actions */\n  .admin-page .section-bar {\n    align-items: stretch;\n    flex-direction: column;\n    gap: 10px;\n    margin-bottom: 12px;\n  }\n  .admin-page .section-bar h2 {\n    font-size: 19px;\n    line-height: 1.25;\n  }\n  .admin-page .section-bar p {\n    font-size: 12px;\n    line-height: 1.5;\n  }\n  .admin-page .bar-actions {\n    width: 100%;\n    display: grid;\n    grid-template-columns: repeat(2, minmax(0,1fr));\n    gap: 8px;\n  }\n  .admin-page .bar-actions .btn {\n    min-width: 0;\n    min-height: 44px;\n    padding: 8px 9px;\n  }\n\n  /* Links: keep the information hierarchy, don't shrink it into tiny text */\n  .admin-page .table-panel {\n    overflow: visible;\n    border: 0;\n    background: transparent;\n    box-shadow: none;\n  }\n  .admin-page .table-tools {\n    padding: 0 0 8px;\n    flex-direction: column;\n    align-items: stretch;\n    gap: 8px;\n  }\n  .admin-page .table-tools input {\n    max-width: none;\n    min-height: 44px;\n  }\n  .admin-page .table-tools .btn {\n    min-height: 44px;\n  }\n  .admin-page .table-scroll {\n    overflow: visible;\n  }\n  .admin-page table {\n    min-width: 0;\n    width: 100%;\n    border-collapse: separate;\n    border-spacing: 0 8px;\n  }\n  .admin-page table thead { display: none; }\n  .admin-page table tbody,\n  .admin-page table tr,\n  .admin-page table td {\n    display: block;\n    width: 100%;\n    min-width: 0;\n    box-sizing: border-box;\n  }\n  .admin-page table tr {\n    padding: 11px 12px;\n    border: 1px solid var(--border);\n    border-radius: var(--mobile-radius);\n    background: var(--surface);\n    box-shadow: 0 8px 24px rgba(0,0,0,.08);\n  }\n  .admin-page table td {\n    display: flex;\n    align-items: center;\n    justify-content: space-between;\n    gap: 12px;\n    padding: 8px 0;\n    border: 0;\n    border-bottom: 1px solid var(--border);\n    font-size: 13px;\n  }\n  .admin-page table td:last-child {\n    border-bottom: 0;\n    padding-bottom: 2px;\n  }\n  .admin-page table td::before {\n    content: attr(data-label);\n    color: var(--faint);\n    font-size: 11px;\n    flex: 0 0 auto;\n  }\n  .admin-page table td > * {\n    max-width: 72%;\n  }\n\n  .admin-page table tr.link-dense-row {\n    display: grid !important;\n    grid-template-columns: minmax(58px,.65fr) minmax(0,1.65fr) auto !important;\n    grid-template-areas:\n      \"code target status\"\n      \"category clicks actions\";\n    align-items: center;\n    column-gap: 8px;\n    row-gap: 8px;\n    padding: 11px 10px !important;\n    overflow: hidden;\n  }\n  .admin-page .link-dense-row td {\n    display: block !important;\n    width: auto !important;\n    padding: 0 !important;\n    border: 0 !important;\n  }\n  .admin-page .link-dense-row td::before { display: none !important; }\n  .admin-page .link-dense-row td:nth-child(1) { grid-area: code; }\n  .admin-page .link-dense-row td:nth-child(2) { grid-area: target; }\n  .admin-page .link-dense-row td:nth-child(3) { grid-area: category; }\n  .admin-page .link-dense-row td:nth-child(4) { grid-area: clicks; }\n  .admin-page .link-dense-row td:nth-child(5) { grid-area: status; justify-self: end; }\n  .admin-page .link-dense-row td:nth-child(6) { grid-area: actions; justify-self: end; }\n  .admin-page .link-dense-row td:nth-child(1) strong,\n  .admin-page .link-dense-title,\n  .admin-page .link-category {\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n  }\n  .admin-page .link-dense-title {\n    max-width: 100% !important;\n    font-size: 13px;\n  }\n  .admin-page .link-category,\n  .admin-page .click-count {\n    font-size: 11px;\n  }\n  .admin-page .link-dense-row .status {\n    font-size: 10px;\n    padding: 4px 7px;\n    white-space: nowrap;\n  }\n  .admin-page .link-dense-row .compact-actions {\n    display: flex !important;\n    flex-wrap: nowrap !important;\n    gap: 4px;\n  }\n  .admin-page .link-dense-row .small-btn {\n    width: 38px !important;\n    min-width: 38px !important;\n    height: 38px !important;\n    min-height: 38px !important;\n    padding: 0 !important;\n    display: inline-flex !important;\n    align-items: center;\n    justify-content: center;\n    border-radius: 8px;\n    font-size: 12px !important;\n  }\n\n  /* Settings */\n  .admin-page .settings-form {\n    max-width: none;\n    padding: 14px;\n    gap: 16px;\n    border-radius: var(--mobile-radius);\n  }\n  .admin-page .settings-group {\n    gap: 11px;\n    padding-bottom: 14px;\n  }\n  .admin-page .settings-group > div { gap: 3px; }\n  .admin-page .settings-group strong { font-size: 13px; }\n  .admin-page .settings-group small {\n    font-size: 11px;\n    line-height: 1.4;\n  }\n  .admin-page .settings-form input,\n  .admin-page .settings-form select {\n    min-height: 44px;\n    height: 44px;\n    font-size: 16px !important;\n  }\n  .admin-page .settings-form .btn {\n    min-height: 44px;\n  }\n  .admin-page .settings-two {\n    grid-template-columns: repeat(2, minmax(0,1fr));\n    gap: 10px;\n  }\n\n  /* Modals / login */\n  .admin-page .modal {\n    align-items: flex-end;\n    padding: 8px;\n    padding-bottom: max(8px, env(safe-area-inset-bottom));\n  }\n  .admin-page .modal-card {\n    width: 100%;\n    max-height: min(92dvh, 760px);\n    padding: 16px;\n    border-radius: 18px 18px 12px 12px;\n  }\n  .admin-page .modal-head {\n    position: sticky;\n    top: 0;\n    z-index: 2;\n    padding-bottom: 10px;\n    background: #12161f;\n  }\n  html.light-admin .admin-page .modal-head { background: #fff; }\n  .admin-page .modal-head .icon-btn {\n    width: 44px;\n    height: 44px;\n  }\n  .admin-page .modal-form { gap: 12px; }\n  .admin-page .modal-form .two { grid-template-columns: minmax(0,1fr); }\n  .admin-page .modal-card input,\n  .admin-page .modal-card textarea,\n  .admin-page .modal-card select {\n    min-height: 44px;\n    font-size: 16px !important;\n  }\n  .admin-page .modal-card textarea { min-height: 100px; }\n  .admin-page .modal-form .btn { min-height: 44px; }\n\n  .admin-page .login-view {\n    min-height: 100dvh;\n    padding: 14px;\n    padding-bottom: calc(14px + env(safe-area-inset-bottom));\n  }\n  .admin-page .login-card {\n    width: 100%;\n    max-width: 430px;\n    padding: 24px 18px;\n    border-radius: 18px;\n  }\n  .admin-page .login-card .brand { margin-bottom: 24px; }\n  .admin-page .login-card input {\n    min-height: 46px;\n    font-size: 16px !important;\n  }\n  .admin-page .login-card .btn { min-height: 46px; }\n\n  .admin-page .toast-root {\n    left: 10px;\n    right: 10px;\n    bottom: calc(10px + env(safe-area-inset-bottom));\n  }\n  .admin-page .toast {\n    width: 100%;\n    padding: 11px 13px;\n    text-align: center;\n  }\n}\n\n@media (max-width: 380px) {\n  .public-page .shell { width: calc(100% - 20px); }\n  .public-page .hero { padding-top: 30px; }\n  .public-page .nav-grid,\n  .public-page .nav-grid-section {\n    gap: 8px;\n  }\n  .public-page .nav-card {\n    min-height: 150px;\n    padding: 12px;\n  }\n  .public-page .nav-card h3 { font-size: 13px; }\n  .public-page .nav-card p { font-size: 11px; }\n  .public-page .favorite,\n  .public-page .copy-btn {\n    width: 38px;\n    height: 38px;\n  }\n\n  .admin-page .admin-main {\n    padding-left: 10px;\n    padding-right: 10px;\n  }\n  .admin-page .stats-grid { gap: 7px; }\n  .admin-page .stat-card { padding: 10px; }\n  .admin-page .stat-value { font-size: 19px; }\n  .admin-page table tr.link-dense-row {\n    grid-template-columns: minmax(50px,.6fr) minmax(0,1.55fr) auto !important;\n    column-gap: 6px;\n  }\n  .admin-page .link-dense-row .small-btn {\n    width: 36px !important;\n    min-width: 36px !important;\n    height: 36px !important;\n    min-height: 36px !important;\n  }\n}\n\n@media (prefers-reduced-motion: reduce) {\n  *, *::before, *::after {\n    scroll-behavior: auto !important;\n    animation-duration: .001ms !important;\n    animation-iteration-count: 1 !important;\n    transition-duration: .001ms !important;\n  }\n}\n\n\n.mobile-bottom-nav{display:none}\n.mobile-nav-item{-webkit-tap-highlight-color:transparent}\n@media (max-width:600px){\n  body.public-page{padding-bottom:calc(78px + env(safe-area-inset-bottom));}\n  .public-page .topbar{padding-top:max(8px,env(safe-area-inset-top));}\n  .public-page .hero{padding-top:28px;}\n  .public-page .hero h1{max-width:680px;}\n  .public-page .toolbar{top:0;}\n  .public-page .nav-card{transition:transform .16s ease,box-shadow .16s ease,border-color .16s ease;will-change:transform;}\n  .public-page .nav-card:active{transform:scale(.985);}\n  .public-page .nav-card-open,.public-page .nav-card-content{touch-action:manipulation;}\n  .public-page .favorite,.public-page .copy-btn{touch-action:manipulation;-webkit-tap-highlight-color:transparent;}\n  .public-page .recent-section{scroll-margin-top:64px;}\n  .mobile-bottom-nav{\n    position:fixed;left:0;right:0;bottom:0;z-index:60;display:grid;grid-template-columns:repeat(4,1fr);\n    padding:7px 8px calc(7px + env(safe-area-inset-bottom));\n    background:color-mix(in srgb,var(--bg) 88%,transparent);\n    border-top:1px solid var(--border);\n    box-shadow:0 -12px 32px rgba(0,0,0,.14);\n    backdrop-filter:blur(22px) saturate(1.3);-webkit-backdrop-filter:blur(22px) saturate(1.3);\n  }\n  .mobile-nav-item{\n    min-width:0;min-height:52px;border:0;background:transparent;color:var(--faint);text-decoration:none;\n    display:flex;align-items:center;justify-content:center;flex-direction:column;gap:3px;border-radius:13px;\n    font:600 10px/1.1 inherit;cursor:pointer;\n  }\n  .mobile-nav-icon{font-size:20px;line-height:20px;font-weight:400;}\n  .mobile-nav-item.active{color:var(--primary);background:color-mix(in srgb,var(--primary) 11%,transparent);}\n  .mobile-nav-item:active{transform:scale(.94);}\n  .public-page .footer{display:none;}\n  .public-page .toolbar .text-btn{min-width:76px;}\n}\n@media(max-width:380px){\n  .mobile-bottom-nav{padding-left:5px;padding-right:5px;}\n  .mobile-nav-item{min-height:50px;}\n}\n@media(prefers-reduced-motion:reduce){\n  .public-page .nav-card,.mobile-nav-item{transition:none!important;animation:none!important;}\n}\n\n\n/* Navigation management layout */\n.section-count{display:inline-flex;margin-left:8px;padding:3px 7px;border:1px solid var(--border);border-radius:999px;color:var(--faint);font-size:10px;font-weight:650;vertical-align:1px}\n.nav-admin-toolbar{display:grid;grid-template-columns:minmax(220px,1fr) 180px auto;gap:8px;align-items:center;padding:9px;margin:-6px 0 12px;border-radius:13px}\n.nav-admin-search{height:38px;display:flex;align-items:center;gap:8px;padding:0 10px;border:1px solid var(--border);border-radius:9px;background:rgba(0,0,0,.1);min-width:0}\n.nav-admin-search span{color:var(--faint);font-size:18px}\n.nav-admin-search input{width:100%;min-width:0;border:0;outline:0;background:none;color:var(--text);font-size:13px}\n.nav-admin-toolbar select{height:38px;border:1px solid var(--border);border-radius:9px;background:rgba(0,0,0,.1);color:var(--muted);padding:0 10px;outline:0}\n.nav-admin-toolbar .text-btn{height:38px;padding:0 11px;font-size:12px}\n.nav-filter-hint{margin:-4px 0 9px;color:var(--faint);font-size:11px}\n.admin-nav-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;min-width:0}\n.admin-nav-card{min-width:0;padding:12px;border:1px solid var(--border);border-radius:13px;background:var(--surface);cursor:grab;transition:transform .18s ease,border-color .18s ease,box-shadow .18s ease}\n.admin-nav-card:hover{transform:translateY(-2px);border-color:var(--border2);box-shadow:0 12px 30px rgba(0,0,0,.14)}\n.admin-nav-card.dragging{opacity:.45}\n.admin-nav-head{display:flex;align-items:center;gap:9px;min-width:0}\n.admin-nav-card .site-icon{width:38px;height:38px;border-radius:10px;padding:6px}\n.admin-nav-title{min-width:0}\n.admin-nav-title strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}\n.admin-nav-title small{display:block;color:var(--faint);margin-top:2px;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.drag-handle{color:var(--faint);font-size:15px;margin-left:auto}\n.admin-nav-card p{height:32px;margin:8px 0 0;min-height:0;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;color:var(--muted);line-height:1.35;font-size:11px}\n.nav-admin-meta{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-top:7px;min-width:0}\n.nav-admin-badges{display:flex;align-items:center;gap:4px;flex:none}\n.linked-badge,.manual-badge,.nav-order-badge{display:inline-flex;padding:3px 6px;border-radius:6px;font-size:9px}\n.linked-badge{color:var(--primary);background:rgba(139,108,255,.1)}\n.manual-badge{color:var(--faint);background:rgba(255,255,255,.045)}\n.nav-order-badge{color:var(--faint);background:rgba(255,255,255,.04);border:1px solid var(--border)}\n.nav-url{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--faint);font-size:9px;text-align:right}\n.nav-admin-actions{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));align-items:stretch;gap:4px;margin-top:8px;min-width:0}\n.nav-admin-actions .small-btn,.nav-admin-actions .status-toggle{width:100%;min-width:0;height:30px;min-height:30px;padding:0 3px;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.nav-admin-actions .nav-move-btn{padding:0}\n.nav-admin-actions .status-toggle{appearance:none;-webkit-appearance:none;border:1px solid transparent;font:inherit;cursor:pointer}\n.nav-admin-actions .favorite-btn.is-favorite{color:#f0c85a;background:rgba(240,200,90,.1);border-color:rgba(240,200,90,.2)}\n.nav-admin-actions .favorite-btn:hover,.nav-admin-actions .favorite-btn:focus-visible,.nav-admin-actions .status-toggle:hover,.nav-admin-actions .status-toggle:focus-visible{filter:brightness(1.08);outline:2px solid color-mix(in srgb,currentColor 22%,transparent);outline-offset:2px}\n.admin-nav-selection{display:flex;align-items:center;gap:7px;min-width:0}\n.admin-nav-selection input{appearance:none;width:17px;height:17px;flex:0 0 17px;margin:0;border:1px solid var(--border2);border-radius:5px;background:var(--surface2);display:grid;place-items:center;cursor:pointer}\n.admin-nav-selection input:checked{background:var(--primary);border-color:var(--primary)}\n.admin-nav-selection input:checked::after{content:\"✓\";font-size:11px;color:white;font-weight:800}\n.admin-nav-card.selected{border-color:color-mix(in srgb,var(--primary) 60%,var(--border2));box-shadow:0 0 0 1px color-mix(in srgb,var(--primary) 20%,transparent),0 12px 30px rgba(0,0,0,.12)}\n.nav-dirty{display:inline-flex;align-items:center;gap:5px;margin-left:6px;color:var(--primary);font-size:10px;font-weight:700}\n.nav-dirty::before{content:\"\";width:6px;height:6px;border-radius:50%;background:currentColor}\n@media (max-width:1180px) and (min-width:901px){.admin-nav-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}\n@media (max-width:900px) and (min-width:601px){.admin-nav-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}\n@media (max-width:600px){\n  .nav-admin-toolbar{grid-template-columns:minmax(0,1fr) 112px;gap:6px;padding:7px;margin:-2px 0 8px}\n  .nav-admin-toolbar .text-btn{grid-column:1/-1;width:100%;height:34px}\n  .nav-admin-search{height:38px}\n  .nav-admin-toolbar select{height:38px;font-size:12px!important}\n  .nav-filter-hint{font-size:10px;margin:0 0 7px}\n  .admin-nav-grid{grid-template-columns:1fr;gap:8px}\n  .admin-nav-card{display:grid;grid-template-columns:minmax(0,1fr);grid-template-areas:\"head\" \"description\" \"meta\" \"actions\";gap:3px;padding:8px 9px;border-radius:11px;cursor:default}\n  .admin-nav-card:hover{transform:none;box-shadow:none}\n  .admin-nav-head{grid-area:head;gap:7px}\n  .admin-nav-card .site-icon{width:32px;height:32px;border-radius:8px;padding:4px}\n  .admin-nav-title strong{font-size:11px}\n  .admin-nav-title small{font-size:9px}\n  .drag-handle{font-size:13px}\n  .admin-nav-card p{grid-area:description;height:17px;margin:0;font-size:9.5px;line-height:1.35;-webkit-line-clamp:1}\n  .nav-admin-meta{grid-area:meta;margin:0;min-height:16px}\n  .linked-badge,.manual-badge,.nav-order-badge{font-size:8px;padding:2px 4px}\n  .nav-url{display:none}\n  .nav-admin-actions{grid-area:actions;margin:0;grid-template-columns:repeat(7,minmax(0,1fr));gap:3px}\n  .nav-admin-actions .small-btn,.nav-admin-actions .status-toggle{height:27px;min-height:27px;padding:2px 1px;font-size:9px;border-radius:7px}\n  .admin-page .nav-dirty{font-size:9px}\n}\n@media (max-width:380px){\n  .admin-nav-card{padding:8px 9px}\n  .nav-admin-actions{gap:2px}\n  .nav-admin-actions .small-btn,.nav-admin-actions .status-toggle{height:27px;min-height:27px;font-size:8px}\n}\n\n.mobile-nav-item:focus-visible{outline:2px solid var(--primary);outline-offset:-2px}\n@media(max-width:600px){\n  .public-page{--mobile-bar-h:64px}\n  .public-page .admin-link{width:40px;height:40px;min-width:40px;min-height:40px;padding:0;font-size:0;position:relative}\n  .public-page .admin-link::before{content:\"⚙\";font-size:17px;line-height:1}\n  .public-page .topbar{padding-left:2px;padding-right:2px}\n  .public-page .mobile-bottom-nav{grid-template-columns:repeat(4,1fr);padding-top:6px;padding-bottom:calc(6px + env(safe-area-inset-bottom));min-height:calc(var(--mobile-bar-h) + env(safe-area-inset-bottom));}\n  .public-page .mobile-nav-item{min-height:48px;border-radius:12px}\n  .public-page .mobile-nav-icon{font-size:19px}\n  .public-page .hero{padding-bottom:22px}\n  .public-page .search-wrap{scroll-margin-top:84px;box-shadow:0 8px 24px rgba(0,0,0,.12)}\n  .public-page .toolbar{margin-bottom:10px}\n  body.public-page{padding-bottom:calc(var(--mobile-bar-h) + env(safe-area-inset-bottom) + 8px)}\n}\n\n/* admin pagination */\n.pagination{\n  display:flex;\n  align-items:center;\n  justify-content:space-between;\n  gap:12px;\n  padding:14px 16px;\n  border-top:1px solid var(--border);\n  color:var(--faint);\n  font-size:12px;\n}\n.pagination-actions{display:flex;align-items:center;gap:5px;flex-wrap:wrap}\n.page-btn{\n  min-width:34px;height:32px;padding:0 9px;\n  border:1px solid var(--border);border-radius:8px;\n  background:var(--surface2);color:var(--muted);\n}\n.page-btn:hover:not(:disabled){color:var(--text);border-color:var(--border2)}\n.page-btn.active{color:#fff;background:var(--primary);border-color:var(--primary)}\n.page-btn:disabled{opacity:.4;cursor:not-allowed}\n\n/* settings layout */\n.settings-form{\n  max-width:1120px;\n  padding:24px;\n  display:grid;\n  grid-template-columns:repeat(2,minmax(0,1fr));\n  gap:18px;\n}\n.settings-group{\n  display:grid;\n  grid-template-columns:repeat(2,minmax(0,1fr));\n  align-content:start;\n  gap:14px;\n  padding:20px;\n  border:1px solid var(--border);\n  border-radius:16px;\n  background:rgba(255,255,255,.025);\n}\n.settings-group>div:first-child{grid-column:1/-1}\n.settings-group>div:first-child strong{font-size:15px}\n.settings-group>div:first-child small{display:block;margin-top:3px}\n.settings-group:first-child{grid-column:1/-1}\n.settings-group:first-child label:last-child{max-width:100%}\n.settings-two{grid-column:1/-1}\n.settings-form>.btn{grid-column:1}\n.settings-form>#settingsMessage{align-self:center}\n.settings-group label{min-width:0}\n.settings-form input,.settings-form select{min-height:42px}\n\n@media(max-width:900px){\n  .settings-form{grid-template-columns:1fr}\n  .settings-group:first-child{grid-column:auto}\n}\n@media(max-width:600px){\n  .pagination{align-items:flex-start;flex-direction:column}\n  .pagination-actions{width:100%}\n  .page-btn{flex:0 0 auto}\n  .settings-form{padding:14px}\n  .settings-group{grid-template-columns:1fr;padding:16px}\n  .settings-group>div:first-child,.settings-two{grid-column:auto}\n  .settings-two{grid-template-columns:repeat(2,1fr)}\n}\n\n.page-size-label{display:inline-flex;align-items:center;gap:5px;white-space:nowrap;color:var(--faint)}.page-size-select{height:32px;padding:0 7px;border:1px solid var(--border);border-radius:8px;background:var(--surface2);color:var(--muted);outline:0}\n\n/* Public home: stable grid + working pagination */\n.public-page .public-main{min-width:0;overflow:visible}\n.public-page .toolbar{min-width:0}\n.public-page .chips{min-width:0;flex:1 1 auto}\n.public-page .nav-grid,.public-page .nav-grid-section{min-width:0;align-items:stretch}\n.public-page .nav-card{min-width:0;height:100%}\n.public-page .nav-card-content{min-width:0}\n.public-page .nav-card h3,.public-page .nav-card p{overflow-wrap:anywhere}\n.public-page .nav-category-section{min-width:0}\n.public-pagination{margin-top:18px;border:1px solid var(--border);border-radius:14px;background:rgba(255,255,255,.025);backdrop-filter:blur(16px)}\n.public-pagination:empty{display:none}\n.public-pagination .pagination-summary{white-space:nowrap}\n.public-pagination .pagination-actions{justify-content:flex-end}\n.public-pagination .page-ellipsis{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:32px;color:var(--faint)}\n@media(max-width:900px){\n  .public-page .nav-grid,.public-page .nav-grid-section{gap:12px}\n  .public-page .hero{max-width:none}\n}\n@media(max-width:600px){\n  .public-page .toolbar{align-items:stretch;gap:8px}\n  .public-page .chips{overflow-x:auto;max-width:100%;padding-right:2px}\n  .public-page .nav-grid,.public-page .nav-grid-section{grid-template-columns:repeat(var(--nav-columns-mobile),minmax(0,1fr));gap:9px}\n  .public-page .nav-card{min-height:156px;padding:12px}\n  .public-page .nav-card h3{font-size:13px;margin-top:12px}\n  .public-page .nav-card p{font-size:11px}\n  .public-page .public-pagination{margin-top:14px;padding:10px 11px}\n  .public-page .public-pagination .pagination-summary{font-size:11px}\n  .public-page .public-pagination .pagination-actions{width:100%;justify-content:flex-start}\n  .public-page .public-pagination .page-btn{height:34px;min-width:34px;padding:0 8px}\n  .public-page .public-pagination .page-size-label{margin-right:auto}\n  .public-page .nav-category-section{margin-bottom:22px}\n  .public-page .nav-category-heading{font-size:15px;margin-bottom:9px}\n}\n\n\n/* v1.1.9: keep v1.1.8 mobile admin refinements; restore v1.1.7 desktop layout. */\n@media (max-width:600px){\n  .admin-page .admin-header{\n    position:static;\n    top:auto;\n    min-height:56px;\n    margin:8px 0 12px;\n    padding:8px 2px;\n    border-radius:12px;\n    box-shadow:none;\n  }\n  .admin-page .admin-header h1{font-size:19px}\n\n  /* Four admin tabs remain fixed at the top on mobile, as in v1.1.8. */\n  .admin-page .sidebar{\n    position:sticky;\n    top:0;\n    z-index:40;\n    width:100%;\n    height:auto;\n    min-height:0;\n    padding:6px 8px calc(6px + env(safe-area-inset-top));\n    border-right:0;\n    border-bottom:1px solid var(--border);\n    background:rgba(10,12,17,.96);\n    backdrop-filter:blur(18px);\n    -webkit-backdrop-filter:blur(18px);\n  }\n  .admin-page .side-brand{display:none}\n  .admin-page .sidebar nav{\n    display:grid;\n    grid-template-columns:repeat(4,minmax(0,1fr));\n    gap:4px;\n    width:100%;\n    margin:0 auto;\n  }\n  .admin-page .side-item{\n    justify-content:center;\n    min-width:0;\n    min-height:44px;\n    padding:5px 3px;\n    border-radius:10px;\n    text-align:center;\n    font-size:11px !important;\n  }\n  .admin-page .sidebar-bottom{display:none}\n  .admin-page .admin-main{max-width:1500px;margin:0 auto;padding-top:0}\n\n  /* Rounded admin controls/cards on mobile, unchanged from v1.1.8. */\n  .admin-page .panel,\n  .admin-page .stat-card,\n  .admin-page .table-panel,\n  .admin-page .table-tools,\n  .admin-page .link-bulk-toolbar,\n  .admin-page .settings-form,\n  .admin-page .settings-group,\n  .admin-page .modal-card,\n  .admin-page .login-card,\n  .admin-page table tr,\n  .admin-page .pagination,\n  .admin-page .page-btn,\n  .admin-page .btn,\n  .admin-page .text-btn,\n  .admin-page .small-btn,\n  .admin-page input,\n  .admin-page textarea,\n  .admin-page select,\n  .admin-page .mobile-home-btn,\n  .admin-page .icon-btn{\n    border-radius:12px;\n  }\n  .admin-page .table-panel{overflow:hidden}\n  .admin-page .table-tools{overflow:hidden}\n\n  .admin-page .link-bulk-toolbar{\n    border:1px solid var(--border);\n    padding:8px;\n    margin-bottom:8px;\n    border-radius:12px;\n  }\n  .admin-page .link-bulk-selects,\n  .admin-page .link-bulk-actions{gap:5px}\n  .admin-page .link-bulk-toolbar .text-btn,\n  .admin-page .link-bulk-toolbar .btn{\n    min-height:32px;\n    padding:5px 8px;\n    border-radius:9px;\n    font-size:11px;\n  }\n\n  .admin-page table{border-spacing:0 6px}\n  .admin-page table tr.link-dense-row{\n    grid-template-columns:minmax(72px,.72fr) minmax(0,1.55fr) auto !important;\n    grid-template-areas:\n      \"code target status\"\n      \"category clicks actions\";\n    column-gap:6px;\n    row-gap:5px;\n    padding:8px 9px !important;\n    border-radius:11px;\n    box-shadow:0 5px 16px rgba(0,0,0,.07);\n  }\n  .admin-page .link-dense-row td:nth-child(1){padding-right:2px!important}\n  .admin-page .link-dense-row td:nth-child(1) strong{font-size:11px}\n  .admin-page .link-dense-title{font-size:11px;line-height:1.25}\n  .admin-page .link-category,\n  .admin-page .click-count{font-size:10px}\n  .admin-page .link-dense-row .status{font-size:9px;padding:3px 6px}\n  .admin-page .link-dense-row .compact-actions{gap:3px}\n\n}\n\n\n/* v1.1.10: mobile short-link rows stay on one compact line, like desktop. */\n@media (max-width:600px){\n  .admin-page #section-links .table-panel{overflow:visible;}\n  .admin-page #section-links .table-scroll{overflow:visible;}\n  .admin-page #section-links table{\n    width:100%;\n    min-width:0;\n    border-collapse:separate;\n    border-spacing:0 6px;\n    table-layout:fixed;\n  }\n  .admin-page #section-links table tbody,\n  .admin-page #section-links table tr,\n  .admin-page #section-links table td{box-sizing:border-box;}\n\n  .admin-page #section-links table tr.link-dense-row{\n    position:relative;\n    display:grid !important;\n    grid-template-columns:18px 62px minmax(0,1fr) 48px 27px 40px 91px;\n    grid-template-areas:\"select code target category clicks status actions\";\n    align-items:center;\n    column-gap:5px;\n    row-gap:0;\n    width:100%;\n    min-height:52px;\n    padding:6px 7px !important;\n    margin:0;\n    overflow:hidden;\n    border:1px solid var(--border);\n    border-radius:11px;\n    background:var(--surface);\n    box-shadow:0 5px 16px rgba(0,0,0,.07);\n  }\n\n  .admin-page #section-links table td{\n    display:flex !important;\n    align-items:center;\n    justify-content:flex-start;\n    width:auto !important;\n    min-width:0;\n    min-height:0;\n    height:38px;\n    padding:0 !important;\n    margin:0;\n    border:0 !important;\n    gap:0;\n    font-size:11px;\n    line-height:1;\n    overflow:hidden;\n  }\n  .admin-page #section-links table td::before{display:none !important;}\n\n  .admin-page #section-links table td:nth-child(1){grid-area:select;}\n  .admin-page #section-links table td:nth-child(2){grid-area:code;}\n  .admin-page #section-links table td:nth-child(3){grid-area:target;}\n  .admin-page #section-links table td:nth-child(4){grid-area:category;}\n  .admin-page #section-links table td:nth-child(5){grid-area:clicks;justify-content:center;}\n  .admin-page #section-links table td:nth-child(6){grid-area:status;justify-content:center;}\n  .admin-page #section-links table td:nth-child(7){grid-area:actions;justify-content:flex-end;}\n\n  .admin-page #section-links table .link-select{\n    display:block;\n    width:16px;\n    height:16px;\n    margin:0;\n  }\n  .admin-page #section-links table td:nth-child(2)>strong{\n    display:block;\n    min-width:0;\n    max-width:100%;\n    margin:0;\n    overflow:hidden;\n    text-overflow:ellipsis;\n    white-space:nowrap;\n    font-size:12px;\n    line-height:1;\n    text-align:left;\n  }\n  .admin-page #section-links table td:nth-child(3) .link-dense-title{\n    display:block;\n    min-width:0;\n    max-width:100%;\n    margin:0;\n    overflow:hidden;\n    text-overflow:ellipsis;\n    white-space:nowrap;\n    text-align:left;\n    font-size:10px;\n    line-height:1;\n  }\n  .admin-page #section-links table td:nth-child(4) .link-category,\n  .admin-page #section-links table td:nth-child(5) .click-count{\n    display:block;\n    min-width:0;\n    max-width:100%;\n    overflow:hidden;\n    text-overflow:ellipsis;\n    white-space:nowrap;\n    font-size:10px;\n  }\n  .admin-page #section-links table td:nth-child(6) .status{\n    display:inline-flex;\n    align-items:center;\n    white-space:nowrap;\n    font-size:9px;\n    line-height:1;\n    padding:4px 6px;\n  }\n  .admin-page #section-links table td:nth-child(7) .row-actions{\n    display:flex !important;\n    align-items:center;\n    justify-content:flex-end;\n    gap:3px;\n    flex-wrap:nowrap !important;\n    width:100%;\n    max-width:none;\n  }\n  .admin-page #section-links table td:nth-child(7) .small-btn{\n    width:27px !important;\n    min-width:27px !important;\n    height:27px !important;\n    min-height:27px !important;\n    padding:0 !important;\n    border-radius:7px;\n    font-size:10px !important;\n    display:inline-flex !important;\n    align-items:center;\n    justify-content:center;\n    flex:0 0 27px;\n  }\n}\n\n@media (max-width:380px){\n  .admin-page #section-links table tr.link-dense-row{\n    grid-template-columns:17px 55px minmax(0,1fr) 43px 24px 37px 84px;\n    column-gap:4px;\n    min-height:48px;\n    padding:5px 6px !important;\n  }\n  .admin-page #section-links table td{height:36px;}\n  .admin-page #section-links table td:nth-child(2)>strong{font-size:11px;}\n  .admin-page #section-links table td:nth-child(3) .link-dense-title{font-size:9px;}\n  .admin-page #section-links table td:nth-child(4) .link-category,\n  .admin-page #section-links table td:nth-child(5) .click-count{font-size:9px;}\n  .admin-page #section-links table td:nth-child(6) .status{font-size:8px;padding:3px 5px;}\n  .admin-page #section-links table td:nth-child(7) .small-btn{\n    width:25px !important;\n    min-width:25px !important;\n    height:25px !important;\n    min-height:25px !important;\n    flex-basis:25px;\n  }\n}\n\n\n/* Unified system settings: tabbed, collapsible functional modules */\n.settings-settings-form{max-width:1120px;display:grid;gap:14px}\n.settings-tabs{display:flex;gap:8px;overflow-x:auto;padding:4px;scrollbar-width:none;border:1px solid var(--border);border-radius:15px;background:var(--surface);box-shadow:0 12px 30px rgba(0,0,0,.08)}\n.settings-tabs::-webkit-scrollbar{display:none}\n.settings-tab{flex:1 1 0;min-width:150px;min-height:46px;border:1px solid transparent;border-radius:11px;background:transparent;color:var(--muted);font:600 13px/1.2 inherit;cursor:pointer;padding:10px 14px;white-space:nowrap}\n.settings-tab:hover{color:var(--text);background:var(--surface2)}\n.settings-tab.active{color:#fff;background:linear-gradient(135deg,var(--primary),var(--primary2));box-shadow:0 8px 22px rgba(0,0,0,.12)}\n.settings-tab-panels{min-width:0}\n.settings-tab-panel{border:1px solid var(--border);border-radius:18px;background:var(--surface);box-shadow:0 16px 42px rgba(0,0,0,.10);overflow:hidden}\n.settings-panel-head{width:100%;box-sizing:border-box;color:var(--text);display:flex;align-items:center;justify-content:flex-start;gap:14px;text-align:left;padding:18px 20px;border-bottom:1px solid var(--border)}\n.settings-panel-head span{display:grid;gap:4px}\n.settings-panel-head strong{font-size:15px}\n.settings-panel-head small{color:var(--faint);font-size:11px;font-weight:400}\n.settings-panel-content{display:block}\n.settings-form{max-width:none;padding:20px 20px 22px;display:grid;grid-template-columns:1fr;gap:18px}\n.settings-form-basic,.settings-form-navigation{max-width:none}\n.settings-form-navigation{grid-template-columns:1fr 1fr}\n.settings-form-navigation .settings-group:first-child{grid-column:1/-1}\n.settings-data-content{padding:0 20px 20px}\n.settings-data-actions{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:0 0 16px}\n.settings-data-actions p{margin:0;color:var(--muted);font-size:12px;line-height:1.6}\n.settings-save-bar{display:flex;align-items:center;gap:12px;padding-top:4px}\n.settings-save-bar .form-success{min-height:18px}\n@media(max-width:900px){\n  .settings-form-navigation{grid-template-columns:1fr}\n  .settings-form-navigation .settings-group:first-child{grid-column:auto}\n}\n@media(max-width:600px){\n  .settings-tabs{border-radius:13px;padding:3px}\n  .settings-tab{flex:0 0 auto;min-width:126px;min-height:44px;padding:9px 11px;font-size:12px}\n  .settings-tab-panel{border-radius:14px}\n  .settings-panel-head{padding:15px 14px}\n  .settings-panel-head strong{font-size:14px}\n  .settings-form{padding:14px}\n  .settings-data-content{padding:0 14px 14px}\n  .settings-data-actions{align-items:stretch;flex-direction:column}\n  .settings-data-actions .btn{width:100%;min-height:44px}\n  .settings-save-bar{padding-top:0;display:grid;grid-template-columns:1fr;gap:7px}\n  .settings-save-bar .btn{min-height:44px}\n}\n\n/* Public home header: fixed, full-width, non-floating */\n.public-page{--public-header-h:68px}\n.public-page .topbar{\n  position:fixed;top:0;left:0;right:0;z-index:50;\n  width:100%;max-width:none;height:var(--public-header-h);\n  margin:0;padding-left:max(14px,calc((100vw - var(--max))/2 + 14px));\n  padding-right:max(14px,calc((100vw - var(--max))/2 + 14px));\n  border:0;border-bottom:1px solid var(--border);border-radius:0;\n  background:color-mix(in srgb,var(--bg2) 94%,transparent);\n  backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);\n  box-shadow:none;\n}\n.public-page .public-main{padding-top:var(--public-header-h)}\n.public-page .top-actions .icon-btn,\n.public-page .top-actions .admin-link{\n  width:40px;height:40px;min-width:40px;min-height:40px;\n  padding:0;box-sizing:border-box;display:inline-flex;\n  align-items:center;justify-content:center;\n}\n.public-page .top-actions .icon-btn{line-height:1}\n\n/* Public home category bar: remove the background layer */\n.public-page .toolbar{\n  position:static;\n  margin:5px 0 22px;\n  padding:0;\n  background:transparent;\n  border:0;\n  backdrop-filter:none;-webkit-backdrop-filter:none;\n}\n@media(max-width:760px){\n  .public-page{--public-header-h:62px}\n  .public-page .topbar{height:var(--public-header-h);padding-left:12px;padding-right:12px}\n}\n@media(max-width:600px){\n  .public-page{--public-header-h:64px}\n  .public-page .topbar{height:var(--public-header-h);padding-left:12px;padding-right:12px}\n  .public-page .public-main{padding-top:var(--public-header-h)}\n  .public-page .toolbar{position:static;margin:0 0 10px;padding:0;background:transparent;border:0;backdrop-filter:none;-webkit-backdrop-filter:none}\n}\n\n\n/* Data management responsive grid */\n.data-grid{min-width:0;}\n@media (max-width:900px){.data-grid{grid-template-columns:repeat(2,minmax(0,1fr));}}\n@media (max-width:600px){.data-grid{grid-template-columns:1fr;gap:10px;margin-bottom:12px;}.data-card{width:100%;min-width:0;}.data-card .panel-head{min-width:0;}.data-card-body{padding:13px 14px 15px;min-width:0;}.data-note{overflow-wrap:anywhere;word-break:break-word;}.data-actions{width:100%;}.data-actions .btn{min-width:0;max-width:100%;}}\n@media (max-width:600px){\n  .admin-page #section-links .link-action-box{\n    width:100%;\n    min-width:0;\n    overflow-x:auto;\n    overflow-y:hidden;\n    -webkit-overflow-scrolling:touch;\n    scrollbar-width:thin;\n    padding:6px;\n    border:1px solid var(--border);\n    border-radius:12px;\n    background:var(--surface2);\n    gap:6px;\n  }\n  .admin-page #section-links .link-action-box .btn{\n    min-width:112px;\n    min-height:38px;\n    padding:8px 10px;\n  }\n}\n\n/* Mobile short-link list view.\n   Desktop keeps the existing semantic table. Mobile uses a compact, flat data\n   list so the link management page stays dense and readable without cards or\n   a 760px horizontal table. All selectors are scoped to #section-links. */\n.admin-page #section-links .links-mobile-list{display:none;}\n.admin-page #section-links .compact-actions{display:flex;align-items:center;justify-content:flex-end;gap:4px;flex-wrap:nowrap;min-width:0;}\n.admin-page #section-links .compact-actions .small-btn{flex:0 0 30px;}\n\n@media (max-width:600px){\n  .admin-page #section-links .table-scroll{\n    display:none;\n  }\n\n  .admin-page #section-links .links-mobile-list{\n    display:block;\n    width:100%;\n    min-width:0;\n    border-top:1px solid var(--border);\n  }\n\n  .admin-page #section-links .mobile-link-row{\n    display:grid;\n    grid-template-columns:minmax(0,1fr) auto auto;\n    align-items:center;\n    column-gap:8px;\n    min-width:0;\n    min-height:58px;\n    padding:9px 2px;\n    border-bottom:1px solid var(--border);\n    background:transparent;\n  }\n\n  .admin-page #section-links .mobile-link-main{\n    display:flex;\n    align-items:center;\n    gap:8px;\n    min-width:0;\n  }\n\n  .admin-page #section-links .mobile-link-select{\n    flex:0 0 16px;\n    width:16px;\n    height:16px;\n    margin:0;\n  }\n\n  .admin-page #section-links .mobile-link-copy{\n    min-width:0;\n  }\n\n  .admin-page #section-links .mobile-link-code{\n    display:block;\n    min-width:0;\n    overflow:hidden;\n    text-overflow:ellipsis;\n    white-space:nowrap;\n    color:var(--text);\n    font-size:12px;\n    line-height:1.25;\n    font-weight:700;\n  }\n\n  .admin-page #section-links .mobile-link-meta{\n    display:block;\n    min-width:0;\n    margin-top:3px;\n    overflow:hidden;\n    text-overflow:ellipsis;\n    white-space:nowrap;\n    color:var(--faint);\n    font-size:10px;\n    line-height:1.3;\n  }\n\n  .admin-page #section-links .mobile-link-row > .status{\n    flex:0 0 auto;\n    font-size:9px;\n    line-height:1.1;\n    padding:3px 5px;\n    white-space:nowrap;\n  }\n\n  .admin-page #section-links .mobile-link-actions{\n    display:flex;\n    align-items:center;\n    justify-content:flex-end;\n    gap:2px;\n    flex:0 0 auto;\n  }\n\n  .admin-page #section-links .mobile-link-action{\n    display:inline-flex;\n    align-items:center;\n    justify-content:center;\n    width:28px;\n    height:28px;\n    min-width:28px;\n    min-height:28px;\n    padding:0;\n    border:0;\n    border-radius:7px;\n    background:transparent;\n    color:var(--faint);\n    font-size:12px;\n    line-height:1;\n    -webkit-tap-highlight-color:transparent;\n  }\n\n  .admin-page #section-links .mobile-link-action:hover,\n  .admin-page #section-links .mobile-link-action:focus-visible{\n    background:var(--surface2);\n    color:var(--text);\n    outline:none;\n  }\n\n  .admin-page #section-links .mobile-link-action.danger-btn{\n    color:var(--danger);\n  }\n\n  .admin-page #section-links .mobile-link-empty{\n    padding:34px 12px;\n    text-align:center;\n    color:var(--faint);\n    font-size:12px;\n  }\n}\n\n@media (max-width:380px){\n  .admin-page #section-links .mobile-link-row{\n    column-gap:6px;\n    min-height:56px;\n    padding:8px 1px;\n  }\n\n  .admin-page #section-links .mobile-link-main{\n    gap:7px;\n  }\n\n  .admin-page #section-links .mobile-link-code{\n    font-size:11px;\n  }\n\n  .admin-page #section-links .mobile-link-meta{\n    font-size:9px;\n  }\n\n  .admin-page #section-links .mobile-link-action{\n    width:26px;\n    height:26px;\n    min-width:26px;\n    min-height:26px;\n    font-size:11px;\n  }\n}\n\n/* Short-link sorting, favorites and copy actions.\n   All new rules are scoped to the short-link management section. */\n.admin-page #section-links .link-list-tools{\n  display:flex;\n  align-items:center;\n  justify-content:flex-end;\n  gap:8px;\n  min-width:0;\n}\n.admin-page #section-links .link-sort-control{\n  display:flex;\n  align-items:center;\n  gap:7px;\n  color:var(--muted);\n  font-size:13px;\n  font-weight:500;\n  line-height:1;\n  white-space:nowrap;\n}\n.admin-page #section-links .link-sort-control select{\n  min-width:132px;\n  border:1px solid var(--border2);\n  background:var(--surface2);\n  color:var(--muted);\n  border-radius:10px;\n  padding:9px 10px;\n  outline:none;\n  font-size:12px;\n  line-height:1.2;\n}\n.admin-page #section-links .favorite-btn{\n  color:var(--faint);\n}\n.admin-page #section-links .favorite-btn.is-favorite{\n  color:#e7bd66;\n}\n.admin-page #section-links .favorite-btn:hover,\n.admin-page #section-links .favorite-btn:focus-visible{\n  color:#e7bd66;\n}\n@media (max-width:600px){\n  .admin-page #section-links .link-list-tools{\n    width:100%;\n    justify-content:stretch;\n  }\n  .admin-page #section-links .link-sort-control{\n    flex:1 1 auto;\n    min-width:0;\n    font-size:12px;\n  }\n  .admin-page #section-links .link-sort-control select{\n    flex:1 1 auto;\n    min-width:0;\n    width:100%;\n  }\n  .admin-page #section-links .mobile-link-actions{\n    gap:1px;\n  }\n  .admin-page #section-links .mobile-link-action{\n    width:27px;\n    min-width:27px;\n  }\n}\n\n/* Interactive link status and code availability feedback.\n   All rules are scoped to the short-link management section. */\n.admin-page #section-links .status-toggle{appearance:none;-webkit-appearance:none;cursor:pointer;border:0;font:inherit;}\n.admin-page #section-links .status-toggle:hover,.admin-page #section-links .status-toggle:focus-visible{filter:brightness(1.08);outline:2px solid color-mix(in srgb,currentColor 22%,transparent);outline-offset:2px;}\n.admin-page #section-links .link-code-check{display:block;min-height:16px;margin-top:5px;font-size:11px;line-height:1.35;color:var(--faint);}\n.admin-page #section-links .link-code-check.checking{color:var(--faint);}\n.admin-page #section-links .link-code-check.available{color:var(--success,#65b887);}\n.admin-page #section-links .link-code-check.unavailable,.admin-page #section-links .link-code-check.invalid,.admin-page #section-links .link-code-check.error{color:var(--danger);}\n@media (max-width:600px){.admin-page #section-links .status-toggle{flex:0 0 auto;}.admin-page #section-links .link-code-check{font-size:10px;}}\n","common.js":"const $ = (selector) => document.querySelector(selector);\nconst esc = (value) => String(value ?? \"\").replace(/[&<>\"']/g, (c) => ({\n  \"&\": \"&amp;\", \"<\": \"&lt;\", \">\": \"&gt;\", '\"': \"&quot;\", \"'\": \"&#39;\"\n}[c]));\n\nfunction readList(key) {\n  try {\n    const value = JSON.parse(localStorage.getItem(key) || \"[]\");\n    return Array.isArray(value) ? value : [];\n  } catch {\n    return [];\n  }\n}\n\nfunction hostnameOf(url) {\n  try { return new URL(url).hostname.toLowerCase(); } catch { return \"\"; }\n}\n\nfunction iconUrl(url) {\n  const hostname = hostnameOf(url);\n  return hostname\n    ? `/api/favicon?url=${encodeURIComponent(url)}`\n    : \"\";\n}\n\nfunction iconProxyUrl(source, fallbackUrl = \"\") {\n  const value = String(source || \"\").trim();\n  if (!value) return iconUrl(fallbackUrl);\n  if (/^data:image\\//i.test(value)) return value;\n  try {\n    const parsed = new URL(value, location.origin);\n    if (parsed.origin === location.origin && parsed.pathname === \"/api/favicon\") return parsed.toString();\n    if (parsed.protocol === \"http:\" || parsed.protocol === \"https:\") {\n      return `/api/favicon?url=${encodeURIComponent(value)}`;\n    }\n  } catch {}\n  return iconUrl(fallbackUrl);\n}\n\nfunction ddgIconUrl(url) {\n  return iconUrl(url);\n}\n\nfunction fallbackIcon(item) {\n  const icons = [\"🌐\", \"🔗\", \"⭐\", \"🚀\", \"🧭\", \"💡\", \"🛠️\", \"🎯\", \"📌\", \"✨\", \"🪐\", \"⚡\"];\n  const text = `${item.id || \"\"}${item.title || \"\"}${item.category || \"\"}`;\n  let hash = 0;\n  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;\n  return icons[hash % icons.length];\n}\n\nasync function copyText(text) {\n  if (navigator.clipboard) {\n    try {\n      await navigator.clipboard.writeText(text);\n      return true;\n    } catch {}\n  }\n  const input = document.createElement(\"textarea\");\n  input.value = text;\n  input.style.position = \"fixed\";\n  input.style.opacity = \"0\";\n  document.body.appendChild(input);\n  input.focus();\n  input.select();\n  let copied = false;\n  try { copied = document.execCommand(\"copy\"); } catch {}\n  input.remove();\n  return copied;\n}\n\nasync function api(url, options = {}) {\n  const response = await fetch(url, {\n    credentials: \"same-origin\",\n    ...options,\n    headers: { \"Content-Type\": \"application/json\", ...(options.headers || {}) },\n  });\n  const data = await response.json().catch(() => ({}));\n  if (!response.ok) throw new Error(data.error || \"请求失败\");\n  return data;\n}\n","app.js":"const state = {\n  searchEngine: \"local\",\n  items: [],\n  settings: {},\n  category: \"全部\",\n  favoritesOnly: false,\n  recent: readList(\"sln_recent\"),\n  favorites: readList(\"sln_favorites\"),\n  page: 1,\n  pageSize: Number(localStorage.getItem(\"sln_page_size\")) || 12,\n};\n\nlet searchFrame = 0;\nfunction scheduleRender() {\n  cancelAnimationFrame(searchFrame);\n  searchFrame = requestAnimationFrame(render);\n}\n\nfunction iconFallbackHtml(item) {\n  return `<span class=\"site-icon site-icon-fallback\">${esc(fallbackIcon(item))}</span>`;\n}\n\nfunction handleIconError(img) {\n  const item = state.items.find((entry) => String(entry.id) === String(img.dataset.itemId));\n  if (!item) return (img.outerHTML = '<span class=\"site-icon site-icon-fallback\">🌐</span>');\n\n  const stage = Number(img.dataset.iconStage || \"0\");\n  const target = item.target_url || item.link_url || item.url;\n  if (stage === 0 && iconUrl(target)) {\n    img.dataset.iconStage = \"1\";\n    img.src = iconUrl(target);\n    return;\n  }\n  img.outerHTML = iconFallbackHtml(item);\n}\n\nfunction savePrefs() {\n  localStorage.setItem(\"sln_recent\", JSON.stringify(state.recent.slice(0, 8)));\n  localStorage.setItem(\"sln_favorites\", JSON.stringify(state.favorites));\n}\n\nfunction applySettings() {\n  const s = state.settings;\n  const siteTitle = s.site_title || \"My Navigation\";\n  const subtitle = s.site_subtitle || \"Personal links\";\n  const heroTitle = s.hero_title || \"Everything you need, one click away.\";\n  const heroDescription = s.hero_description || s.site_description || \"A fast, elegant home for your frequently used websites.\";\n  document.title = siteTitle;\n  $(\"#siteTitle\").textContent = siteTitle;\n  $(\"#siteSubtitle\").textContent = subtitle;\n  $(\"#heroTitle\").textContent = heroTitle;\n  $(\"#heroDesc\").textContent = heroDescription;\n  $(\"#footerText\").textContent = subtitle;\n\n  if (s.accent && /^#[0-9a-fA-F]{6}$/.test(s.accent)) {\n    document.documentElement.style.setProperty(\"--primary\", s.accent);\n  }\n\n  const root = document.documentElement;\n  root.style.setProperty(\"--nav-columns-mobile\", normalizeColumns(s.nav_columns_mobile, 2));\n  root.style.setProperty(\"--nav-columns-tablet\", normalizeColumns(s.nav_columns_tablet, 3));\n  root.style.setProperty(\"--nav-columns-desktop\", normalizeColumns(s.nav_columns_desktop, 4));\n  root.style.setProperty(\"--nav-columns-wide\", normalizeColumns(s.nav_columns_wide, 6));\n  root.dataset.navTagStyle = [\"pills\", \"tabs\", \"sections\"].includes(s.nav_tag_style) ? s.nav_tag_style : \"pills\";\n}\n\nfunction normalizeColumns(value, fallback) {\n  const n = Number(value);\n  return String(Number.isFinite(n) && n >= 1 && n <= 6 ? Math.round(n) : fallback);\n}\n\nfunction categoryList() {\n  const available = [...new Set(state.items.map((item) => item.category).filter(Boolean))];\n  const order = String(state.settings.nav_category_order || \"\")\n    .split(\",\")\n    .map((x) => x.trim())\n    .filter(Boolean);\n  const hidden = new Set(String(state.settings.nav_hidden_categories || \"\")\n    .split(\",\")\n    .map((x) => x.trim())\n    .filter(Boolean));\n  const ordered = [\n    ...order.filter((name) => available.includes(name)),\n    ...available.filter((name) => !order.includes(name)),\n  ];\n  return ordered.filter((name) => !hidden.has(name));\n}\n\nasync function init() {\n  try {\n    const bootstrap = await api(\"/api/public/bootstrap\");\n    state.items = bootstrap.items || [];\n    state.settings = bootstrap.settings || {};\n    applySettings();\n    renderCats();\n    render();\n    renderRecent();\n  } catch (error) {\n    $(\"#navGrid\").innerHTML = `<div class=\"empty-state\"><h3>加载失败</h3><p>${esc(error.message)}</p></div>`;\n  }\n}\n\nfunction renderCats() {\n  const cats = [\"全部\", ...categoryList()];\n  if (!cats.includes(state.category)) state.category = \"全部\";\n  $(\"#categoryChips\").innerHTML = cats.map((category) => `\n    <button class=\"chip ${state.category === category ? \"active\" : \"\"}\" data-cat=\"${esc(category)}\">${esc(category)}</button>\n  `).join(\"\");\n\n  document.querySelectorAll(\"[data-cat]\").forEach((button) => {\n    button.onclick = () => {\n      state.category = button.dataset.cat;\n      state.page = 1;\n      renderCats();\n      render();\n    };\n  });\n}\n\nfunction filtered() {\n  const query = state.searchEngine === \"local\" ? $(\"#searchInput\").value.trim().toLowerCase() : \"\";\n  return state.items.filter((item) =>\n    (state.category === \"全部\" || item.category === state.category) &&\n    (!state.favoritesOnly || state.favorites.includes(item.id)) &&\n    (!query || [item.title, item.description, item.category, item.url].join(\" \").toLowerCase().includes(query))\n  );\n}\n\nfunction cardHtml(item, index) {\n  const displayUrl = item.code ? location.origin + \"/\" + item.code : item.url;\n  const favorite = state.favorites.includes(item.id);\n  const target = item.target_url || item.link_url || item.url;\n  const icon = item.icon ? iconProxyUrl(item.icon, target) : iconUrl(target);\n    return `<article class=\"nav-card\" style=\"animation:fadeUp .28s ease ${Math.min(index, 10) * 0.035}s both\" data-id=\"${item.id}\">\n    <div class=\"nav-top\">\n      <a class=\"nav-card-open\" href=\"${esc(displayUrl)}\" aria-label=\"打开 ${esc(item.title)}\">\n        <img class=\"site-icon\" src=\"${esc(icon)}\" data-item-id=\"${esc(item.id)}\" alt=\"\" loading=\"${index < 8 ? \"eager\" : \"lazy\"}\" decoding=\"async\" fetchpriority=\"${index < 4 ? \"high\" : \"low\"}\" onerror=\"handleIconError(this)\">\n      </a>\n      <div class=\"nav-card-actions\">\n        <button class=\"copy-btn\" data-copy=\"${item.id}\" title=\"复制链接\" aria-label=\"复制链接\">⧉</button>\n        <button class=\"favorite ${favorite ? \"active\" : \"\"}\" data-fav=\"${item.id}\" title=\"收藏\" aria-label=\"收藏\">${favorite ? \"★\" : \"☆\"}</button>\n      </div>\n    </div>\n    <a class=\"nav-card-content\" href=\"${esc(displayUrl)}\">\n      <h3>${esc(item.title)}</h3>\n      <p>${esc(item.description || hostnameOf(item.target_url || item.link_url || item.url) || item.url)}</p>\n    </a>\n    <div class=\"nav-meta\">\n      ${item.category ? `<span class=\"tag\">${esc(item.category)}</span>` : \"\"}\n      ${item.link_id ? `<span class=\"tag link-tag\">短链接</span>` : \"\"}\n    </div>\n  </article>`;\n}\n\nfunction render() {\n  const list = filtered();\n  const totalPages = Math.max(1, Math.ceil(list.length / state.pageSize));\n  state.page = Math.min(Math.max(1, state.page), totalPages);\n  const start = (state.page - 1) * state.pageSize;\n  const pageItems = list.slice(start, start + state.pageSize);\n  const style = document.documentElement.dataset.navTagStyle || \"pills\";\n\n  if (style === \"sections\" && state.category === \"全部\") {\n    const groups = categoryList();\n    const grouped = groups.map((category) => ({\n      category,\n      items: pageItems.filter((item) => item.category === category),\n    })).filter((group) => group.items.length);\n    const uncategorized = pageItems.filter((item) => !item.category);\n    $(\"#navGrid\").innerHTML = grouped.map((group) => `\n      <section class=\"nav-category-section\">\n        <div class=\"nav-category-heading\"><span>${esc(group.category)}</span><b>${group.items.length}</b></div>\n        <div class=\"nav-grid-section\">${group.items.map((item, index) => cardHtml(item, index)).join(\"\")}</div>\n      </section>\n    `).join(\"\") + (uncategorized.length ? `\n      <section class=\"nav-category-section\"><div class=\"nav-category-heading\"><span>未分类</span><b>${uncategorized.length}</b></div><div class=\"nav-grid-section\">${uncategorized.map((item, index) => cardHtml(item, index)).join(\"\")}</div></section>\n    ` : \"\");\n  } else {\n    $(\"#navGrid\").innerHTML = pageItems.map(cardHtml).join(\"\");\n  }\n\n  $(\"#emptyState\").classList.toggle(\"hidden\", list.length > 0);\n  renderPagination(list.length, totalPages);\n  bindGridEvents();\n}\n\nfunction renderPagination(total, totalPages) {\n  const root = $(\"#pagination\");\n  if (!root) return;\n  const from = total ? (state.page - 1) * state.pageSize + 1 : 0;\n  const to = Math.min(state.page * state.pageSize, total);\n  const pages = [];\n  const addPage = (page) => pages.push(`<button class=\"page-btn page-number ${page === state.page ? \"active\" : \"\"}\" data-page=\"${page}\" ${page === state.page ? \"aria-current=\\\"page\\\"\" : \"\"}>${page}</button>`);\n  if (totalPages <= 7) {\n    for (let i = 1; i <= totalPages; i++) addPage(i);\n  } else {\n    addPage(1);\n    if (state.page > 4) pages.push('<span class=\"page-ellipsis\">…</span>');\n    const startPage = Math.max(2, state.page - 1);\n    const endPage = Math.min(totalPages - 1, state.page + 1);\n    for (let i = startPage; i <= endPage; i++) addPage(i);\n    if (state.page < totalPages - 3) pages.push('<span class=\"page-ellipsis\">…</span>');\n    addPage(totalPages);\n  }\n  root.innerHTML = `\n    <div class=\"pagination-summary\">显示 ${from}-${to} / 共 ${total} 项</div>\n    <div class=\"pagination-actions\">\n      <label class=\"page-size-label\">每页 <select class=\"page-size-select\" id=\"pageSizeSelect\"><option value=\"8\">8</option><option value=\"12\">12</option><option value=\"20\">20</option><option value=\"32\">32</option></select> 项</label>\n      <button class=\"page-btn\" data-page=\"${state.page - 1}\" ${state.page <= 1 ? \"disabled\" : \"\"}>上一页</button>\n      ${pages.join(\"\")}\n      <button class=\"page-btn\" data-page=\"${state.page + 1}\" ${state.page >= totalPages ? \"disabled\" : \"\"}>下一页</button>\n    </div>`;\n  const select = $(\"#pageSizeSelect\");\n  select.value = String(state.pageSize);\n  select.onchange = () => {\n    state.pageSize = Number(select.value) || 12;\n    localStorage.setItem(\"sln_page_size\", String(state.pageSize));\n    state.page = 1;\n    render();\n  };\n  root.querySelectorAll(\"[data-page]\").forEach((button) => {\n    button.onclick = () => {\n      const page = Number(button.dataset.page);\n      if (!Number.isFinite(page) || page < 1 || page > totalPages || page === state.page) return;\n      state.page = page;\n      render();\n      $(\"#navGrid\").scrollIntoView({ behavior: \"smooth\", block: \"start\" });\n    };\n  });\n}\n\nfunction bindGridEvents() {\n  const grid = $(\"#navGrid\");\n  grid.onclick = async (event) => {\n    const favoriteButton = event.target.closest(\"[data-fav]\");\n    if (favoriteButton) {\n      event.preventDefault();\n      event.stopPropagation();\n      const id = Number(favoriteButton.dataset.fav);\n      state.favorites = state.favorites.includes(id)\n        ? state.favorites.filter((value) => value !== id)\n        : [...state.favorites, id];\n      savePrefs();\n      render();\n      renderRecent();\n      return;\n    }\n\n    const copyButton = event.target.closest(\"[data-copy]\");\n    if (copyButton) {\n      event.preventDefault();\n      event.stopPropagation();\n      const item = state.items.find((value) => value.id === Number(copyButton.dataset.copy));\n      if (!item) return;\n      const ok = await copyText(item.code ? location.origin + \"/\" + item.code : item.url);\n      copyButton.textContent = ok ? \"✓\" : \"×\";\n      setTimeout(() => { copyButton.textContent = \"⧉\"; }, 1200);\n      return;\n    }\n\n    const card = event.target.closest(\".nav-card\");\n    if (card) {\n      const id = Number(card.dataset.id);\n      state.recent = [id, ...state.recent.filter((value) => value !== id)];\n      savePrefs();\n    }\n  };\n}\n\nfunction renderRecent() {\n  const items = state.recent.map((id) => state.items.find((item) => item.id === id)).filter(Boolean);\n  $(\"#recentGrid\").innerHTML = items.length\n    ? items.map((item) => `<a class=\"recent-item\" href=\"${esc(item.code ? location.origin + \"/\" + item.code : item.url)}\"><img src=\"${esc(item.icon ? iconProxyUrl(item.icon, item.target_url || item.link_url || item.url) : iconUrl(item.target_url || item.link_url || item.url))}\" data-item-id=\"${esc(item.id)}\" alt=\"\" loading=\"lazy\" decoding=\"async\" onerror=\"handleIconError(this)\"><span>${esc(item.title)}</span></a>`).join(\"\")\n    : '<span style=\"color:var(--faint);font-size:13px\">还没有访问记录</span>';\n}\n\nconst SEARCH_ENGINES = {\n  local: { label: \"卡片搜索\", placeholder: \"搜索导航、描述或分类…\" },\n  google: { label: \"Google\", placeholder: \"输入关键词搜索 Google…\", url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}` },\n  baidu: { label: \"百度\", placeholder: \"输入关键词搜索百度…\", url: (q) => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}` },\n  bing: { label: \"Bing\", placeholder: \"输入关键词搜索 Bing…\", url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}` },\n  github: { label: \"GitHub\", placeholder: \"输入关键词搜索 GitHub…\", url: (q) => `https://github.com/search?q=${encodeURIComponent(q)}&type=repositories` },\n};\n\nfunction setSearchEngine(engine) {\n  if (!SEARCH_ENGINES[engine]) engine = \"local\";\n  state.searchEngine = engine;\n  const config = SEARCH_ENGINES[engine];\n  document.querySelectorAll(\"[data-search-engine]\").forEach((button) => {\n    const active = button.dataset.searchEngine === engine;\n    button.classList.toggle(\"active\", active);\n    button.setAttribute(\"aria-selected\", String(active));\n  });\n  const input = $(\"#searchInput\");\n  input.placeholder = config.placeholder;\n  $(\"#searchSubmit\").textContent = engine === \"local\" ? \"搜索\" : `搜索${config.label}`;\n  if (engine !== \"local\") {\n    state.page = 1;\n    render();\n  }\n}\n\nfunction submitSearch() {\n  const input = $(\"#searchInput\");\n  const query = input.value.trim();\n  if (!query) {\n    input.focus();\n    if (state.searchEngine === \"local\") {\n      state.page = 1;\n      render();\n    }\n    return;\n  }\n  if (state.searchEngine === \"local\") {\n    state.page = 1;\n    render();\n    $(\"#navGrid\")?.scrollIntoView({ behavior: \"smooth\", block: \"start\" });\n    return;\n  }\n  const engine = SEARCH_ENGINES[state.searchEngine];\n  if (engine?.url) window.location.assign(engine.url(query));\n}\n\ndocument.querySelectorAll(\"[data-search-engine]\").forEach((button) => {\n  button.onclick = () => {\n    setSearchEngine(button.dataset.searchEngine);\n    $(\"#searchInput\").focus({ preventScroll: true });\n  };\n});\n\n$(\"#searchInput\").oninput = () => {\n  if (state.searchEngine !== \"local\") return;\n  state.page = 1;\n  scheduleRender();\n};\n$(\"#searchInput\").onkeydown = (event) => {\n  if (event.key === \"Enter\") {\n    event.preventDefault();\n    submitSearch();\n  }\n};\n$(\"#searchSubmit\").onclick = submitSearch;\n$(\"#favoritesOnly\").onclick = () => {\n  state.favoritesOnly = !state.favoritesOnly;\n  state.page = 1;\n  $(\"#favoritesOnly\").textContent = state.favoritesOnly ? \"★ 已收藏\" : \"☆ 收藏\";\n  render();\n};\n\n$(\"#clearFilters\").onclick = () => {\n  $(\"#searchInput\").value = \"\";\n  setSearchEngine(\"local\");\n  state.category = \"全部\";\n  state.favoritesOnly = false;\n  state.page = 1;\n  $(\"#favoritesOnly\").textContent = \"☆ 收藏\";\n  renderCats();\n  render();\n};\n\n$(\"#clearRecent\").onclick = () => {\n  state.recent = [];\n  savePrefs();\n  renderRecent();\n};\n\nfunction setMobileNav(action) {\n  document.querySelectorAll(\".mobile-nav-item\").forEach((item) => {\n    item.classList.toggle(\"active\", item.dataset.mobileAction === action);\n  });\n}\n\nfunction initMobileAppUI() {\n  const nav = $(\"#mobileBottomNav\");\n  if (!nav) return;\n  nav.addEventListener(\"click\", (event) => {\n    const item = event.target.closest(\"[data-mobile-action]\");\n    if (!item) return;\n    const action = item.dataset.mobileAction;\n    event.preventDefault();\n    if (action === \"home\") {\n      state.category = \"全部\";\n      state.favoritesOnly = false;\n      state.page = 1;\n      $(\"#searchInput\").value = \"\";\n      setSearchEngine(\"local\");\n      $(\"#favoritesOnly\").textContent = \"☆ 收藏\";\n      renderCats();\n      render();\n      window.scrollTo({ top: 0, behavior: \"smooth\" });\n      setMobileNav(\"home\");\n    } else if (action === \"favorites\") {\n      state.favoritesOnly = true;\n      $(\"#favoritesOnly\").textContent = \"★ 已收藏\";\n      render();\n      window.scrollTo({ top: 0, behavior: \"smooth\" });\n      setMobileNav(\"favorites\");\n    } else if (action === \"recent\") {\n      $(\".recent-section\")?.scrollIntoView({ behavior: \"smooth\", block: \"start\" });\n      setMobileNav(\"recent\");\n    } else if (action === \"search\") {\n      const input = $(\"#searchInput\");\n      input?.focus({ preventScroll: true });\n      input?.scrollIntoView({ behavior: \"smooth\", block: \"center\" });\n      setMobileNav(\"search\");\n    }\n  });\n}\n\nfunction applyTheme() {\n  const saved = localStorage.getItem(\"sln_theme\");\n  if (saved === \"light\") document.documentElement.setAttribute(\"data-theme\", \"light\");\n  $(\"#themeBtn\").textContent = saved === \"light\" ? \"☀\" : \"☾\";\n}\n\n$(\"#themeBtn\").onclick = () => {\n  const light = document.documentElement.getAttribute(\"data-theme\") === \"light\";\n  if (light) {\n    document.documentElement.removeAttribute(\"data-theme\");\n    localStorage.setItem(\"sln_theme\", \"dark\");\n  } else {\n    document.documentElement.setAttribute(\"data-theme\", \"light\");\n    localStorage.setItem(\"sln_theme\", \"light\");\n  }\n  $(\"#themeBtn\").textContent = light ? \"☾\" : \"☀\";\n};\n\ndocument.addEventListener(\"keydown\", (event) => {\n  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === \"k\") {\n    event.preventDefault();\n    $(\"#searchInput\").focus();\n  }\n});\n\napplyTheme();\ninitMobileAppUI();\n\n// Keep keyboard shortcut behavior, but make the public page feel like an installed app on mobile.\nif (\"serviceWorker\" in navigator) {\n  window.addEventListener(\"load\", () => navigator.serviceWorker.register(\"/sw.js\").catch(() => {}));\n}\ninit();\n","admin.js":"const A = {\n  links: [], nav: [], settings: {}, navSelected: new Set(), navDirty: false,\n  linkPage: 1, navPage: 1, linkTotal: 0, navTotal: 0, linkPages: 1, navPages: 1,\n  navCategories: [], navOrderIds: [], linkSelected: new Set(), loadSeq: 0,\n  linkSort: localStorage.getItem(\"stnav_link_sort\") || \"created_desc\",\n  linkPageSize: Number(localStorage.getItem(\"stnav_link_page_size\")) || 10,\n  navPageSize: Number(localStorage.getItem(\"stnav_nav_page_size\")) || 12,\n};\n\nfunction toast(message) {\n  const node = document.createElement(\"div\");\n  node.className = \"toast\";\n  node.textContent = message;\n  $(\"#toastRoot\").appendChild(node);\n  setTimeout(() => node.remove(), 2600);\n}\n\nfunction formData(form) {\n  const data = Object.fromEntries(new FormData(form).entries());\n  data.enabled = form.elements.enabled?.checked ?? false;\n  return data;\n}\n\nasync function boot() {\n  try {\n    const me = await api(\"/api/auth/me\");\n    if (me.authenticated) showAdmin(); else showLogin();\n  } catch {\n    showLogin();\n  }\n}\n\nfunction showLogin() {\n  $(\"#loginView\").classList.remove(\"hidden\");\n  $(\"#adminView\").classList.add(\"hidden\");\n}\n\nfunction showAdmin() {\n  $(\"#loginView\").classList.add(\"hidden\");\n  $(\"#adminView\").classList.remove(\"hidden\");\n  loadAll();\n}\n\n$(\"#loginForm\").onsubmit = async (event) => {\n  event.preventDefault();\n  $(\"#loginError\").textContent = \"\";\n  try {\n    await api(\"/api/auth/login\", {\n      method: \"POST\",\n      body: JSON.stringify({ password: $(\"#password\").value }),\n    });\n    $(\"#password\").value = \"\";\n    showAdmin();\n  } catch (error) {\n    $(\"#loginError\").textContent = error.message;\n  }\n};\n\n$(\"#logoutBtn\").onclick = async () => {\n  try { await api(\"/api/auth/logout\", { method: \"POST\" }); } finally { location.reload(); }\n};\n\ndocument.querySelectorAll(\".side-item\").forEach((button) => {\n  button.onclick = () => switchSection(button.dataset.section);\n});\n\nfunction switchSection(section) {\n  document.querySelectorAll(\".side-item\").forEach((button) => button.classList.toggle(\"active\", button.dataset.section === section));\n  document.querySelectorAll(\".admin-section\").forEach((node) => node.classList.add(\"hidden\"));\n  $(\"#section-\" + section).classList.remove(\"hidden\");\n  const map = {\n    overview: [\"OVERVIEW\", \"控制台\"],\n    links: [\"SHORT LINKS\", \"短链接管理\"],\n    navigation: [\"NAVIGATION\", \"导航管理\"],\n    settings: [\"SYSTEM MANAGEMENT\", \"系统管理\"],\n    data: [\"DATA MANAGEMENT\", \"数据管理\"],\n  };\n  $(\"#sectionEyebrow\").textContent = map[section][0];\n  $(\"#sectionTitle\").textContent = map[section][1];\n}\n\nasync function loadAll({ resetPages = false } = {}) {\n  try {\n    if (resetPages) {\n      A.linkPage = 1;\n      A.navPage = 1;\n    }\n    const params = new URLSearchParams({\n      links_page: String(A.linkPage),\n      links_page_size: String(A.linkPageSize),\n      links_sort: A.linkSort || \"created_desc\",\n      links_search: String($(\"#linkSearch\")?.value || \"\").trim(),\n      nav_page: String(A.navPage),\n      nav_page_size: String(A.navPageSize),\n      nav_search: String($(\"#navSearch\")?.value || \"\").trim(),\n      nav_category: String($(\"#navCategoryFilter\")?.value || \"\"),\n    });\n    const loadSeq = ++A.loadSeq;\n    const data = await api(`/api/admin/bootstrap?${params.toString()}`);\n    if (loadSeq !== A.loadSeq) return;\n    A.links = data.links || [];\n    A.nav = data.navigation || [];\n    A.settings = data.settings || {};\n    A.linkTotal = Number(data.links_pagination?.total || 0);\n    A.navTotal = Number(data.navigation_pagination?.total || 0);\n    A.linkPages = Number(data.links_pagination?.pages || 1);\n    A.navPages = Number(data.navigation_pagination?.pages || 1);\n    A.linkPage = Number(data.links_pagination?.page || 1);\n    A.navPage = Number(data.navigation_pagination?.page || 1);\n    A.navCategories = data.navigation_categories || [];\n    A.navOrderIds = (data.navigation_order || []).map(Number);\n    A.navSelected = new Set([...A.navSelected].filter((id) => A.navOrderIds.includes(Number(id))));\n    A.linkSelected = new Set([...A.linkSelected].filter((id) => Number.isInteger(Number(id)) && Number(id) > 0));\n    A.navDirty = false;\n    renderDashboard(data.dashboard || {});\n    renderLinks();\n    renderNav();\n    fillSettings();\n  } catch (error) {\n    toast(error.message);\n    if (error.message === \"未登录\") showLogin();\n  }\n}\n\nfunction renderDashboard(data) {\n  const stats = data.stats || {};\n  $(\"#statsGrid\").innerHTML = [\n    [\"总短链接\", stats.links || 0],\n    [\"总点击\", stats.clicks || 0],\n    [\"导航项目\", stats.navigation || 0],\n    [\"近14天点击\", stats.recentClicks || 0],\n  ].map(([label, value]) => `<div class=\"stat-card\"><div class=\"stat-label\">${label}</div><div class=\"stat-value\">${Number(value).toLocaleString()}</div></div>`).join(\"\");\n\n  $(\"#topLinks\").innerHTML = (data.topLinks || []).slice(0, 7).map((item) => `\n    <div class=\"mini-row\"><div><strong>${esc(item.code)}</strong><small>${esc(item.title || item.url)}</small></div><b>${item.clicks || 0}</b></div>\n  `).join(\"\") || '<p style=\"color:var(--faint)\">暂无数据</p>';\n  drawChart(data.trend || []);\n}\n\nfunction drawChart(rows) {\n  const canvas = $(\"#clickChart\");\n  const wrap = canvas?.parentElement;\n  if (!canvas || !wrap) return;\n\n  // Use the chart container's content box instead of the canvas' intrinsic\n  // 300x150 size. The old implementation could make the canvas taller than\n  // .chart-wrap, causing the line to visually escape the panel on desktop\n  // and mobile. Keep a small minimum only for the drawing math, never the DOM.\n  const width = Math.max(1, Math.floor(wrap.clientWidth));\n  const height = Math.max(1, Math.floor(wrap.clientHeight));\n  const ratio = Math.max(1, window.devicePixelRatio || 1);\n  canvas.width = Math.round(width * ratio);\n  canvas.height = Math.round(height * ratio);\n  const ctx = canvas.getContext(\"2d\");\n  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);\n  const W = width, H = height;\n  const padding = Math.min(22, Math.max(12, Math.floor(Math.min(W, H) * 0.08)));\n  const lineWidth = 3;\n  const left = padding + lineWidth / 2;\n  const right = Math.max(left, W - padding - lineWidth / 2);\n  const top = padding + lineWidth / 2;\n  const bottom = Math.max(top, H - padding - lineWidth / 2);\n  const max = Math.max(1, ...rows.map((row) => Number(row.clicks) || 0));\n  const styles = getComputedStyle(document.documentElement);\n\n  ctx.clearRect(0, 0, W, H);\n  ctx.strokeStyle = styles.getPropertyValue(\"--border2\");\n  ctx.lineWidth = 1;\n  for (let i = 0; i < 4; i++) {\n    const y = padding + (H - padding * 2) * i / 3;\n    ctx.beginPath();\n    ctx.moveTo(padding, y);\n    ctx.lineTo(W - padding, y);\n    ctx.stroke();\n  }\n  if (!rows.length) return;\n\n  ctx.strokeStyle = styles.getPropertyValue(\"--primary\");\n  ctx.lineWidth = lineWidth;\n  ctx.lineJoin = \"round\";\n  ctx.lineCap = \"round\";\n  ctx.beginPath();\n  rows.forEach((row, index) => {\n    const x = rows.length === 1\n      ? (left + right) / 2\n      : left + (right - left) * index / (rows.length - 1);\n    const value = Math.max(0, Number(row.clicks) || 0);\n    const y = bottom - (bottom - top) * (value / max);\n    index ? ctx.lineTo(x, y) : ctx.moveTo(x, y);\n  });\n  ctx.stroke();\n}\n\nfunction linkedNav(item) {\n  if (item?.navigation_id) return { id: Number(item.navigation_id) };\n  return A.nav.find((nav) => Number(nav.link_id) === Number(item?.id));\n}\n\nfunction renderPagination(container, page, total, pageSize, onChange) {\n  const node = $(container);\n  if (!node) return;\n  const pages = Math.max(1, Math.ceil(total / pageSize));\n  const current = Math.min(Math.max(1, page), pages);\n  const start = Math.max(1, Math.min(current - 2, pages - 4));\n  const end = Math.min(pages, start + 4);\n  const pageButtons = [];\n  for (let p = start; p <= end; p++) {\n    pageButtons.push(`<button class=\"page-btn ${p === current ? \"active\" : \"\"}\" data-page=\"${p}\">${p}</button>`);\n  }\n  node.innerHTML = `\n    <span class=\"pagination-info\">共 ${total} 项，第 ${current}/${pages} 页</span>\n    <div class=\"pagination-actions\">\n      <label class=\"page-size-label\">每页 <select class=\"page-size-select\">\n        ${[5,8,10,12,20,32,50].map((size) => `<option value=\"${size}\" ${size === pageSize ? \"selected\" : \"\"}>${size}</option>`).join(\"\")}\n      </select> 项</label>\n      <button class=\"page-btn\" data-page=\"${current - 1}\" ${current <= 1 ? \"disabled\" : \"\"}>上一页</button>\n      ${pageButtons.join(\"\")}\n      <button class=\"page-btn\" data-page=\"${current + 1}\" ${current >= pages ? \"disabled\" : \"\"}>下一页</button>\n    </div>`;\n  node.querySelectorAll(\"[data-page]\").forEach((button) => {\n    button.onclick = () => {\n      const target = Number(button.dataset.page);\n      if (target >= 1 && target <= pages && target !== current) onChange(target);\n    };\n  });\n  const sizeSelect = node.querySelector(\".page-size-select\");\n  if (sizeSelect) {\n    sizeSelect.onchange = () => {\n      const size = Number(sizeSelect.value);\n      if (!Number.isFinite(size) || size < 1) return;\n      onChange(1, size);\n    };\n  }\n}\n\nfunction getFilteredLinks() {\n  return A.links;\n}\n\nfunction syncLinkSelection() {\n  A.linkSelected = new Set([...A.linkSelected].map(Number).filter((id) => Number.isInteger(id) && id > 0));\n}\n\nfunction updateLinkBulkUi() {\n  syncLinkSelection();\n  const count = A.linkSelected.size;\n  const node = $(\"#linkSelectedCount\");\n  if (node) node.textContent = `已选 ${count} 项`;\n  const selectedIds = new Set(A.linkSelected);\n  document.querySelectorAll(\"#linksTable .link-select, #linksMobileList .link-select\").forEach((input) => {\n    input.checked = selectedIds.has(Number(input.dataset.id));\n  });\n}\n\nasync function selectVisibleLinks(all = false) {\n  if (!all) {\n    A.links.forEach((item) => A.linkSelected.add(Number(item.id)));\n    renderLinks();\n    toast(`已选择本页 ${A.links.length} 项`);\n    return;\n  }\n  try {\n    const params = new URLSearchParams({\n      search: String($(\"#linkSearch\")?.value || \"\").trim(),\n      sort: A.linkSort || \"created_desc\",\n    });\n    const result = await api(`/api/admin/links/ids?${params.toString()}`);\n    const ids = (result.ids || []).map(Number);\n    ids.forEach((id) => A.linkSelected.add(id));\n    renderLinks();\n    toast(`已选择 ${ids.length} 项（当前筛选结果）`);\n  } catch (error) {\n    toast(`选择全部失败：${error.message}`);\n  }\n}\n\nfunction clearSelectedLinks() {\n  A.linkSelected.clear();\n  updateLinkBulkUi();\n}\n\nasync function toggleLinkFavorite(item) {\n  const next = !Number(item.favorite);\n  const previous = Number(item.favorite) ? 1 : 0;\n  item.favorite = next ? 1 : 0;\n  renderLinks();\n  try {\n    await api(`/api/admin/links/${item.id}/favorite`, {\n      method: \"PATCH\",\n      body: JSON.stringify({ favorite: next }),\n    });\n    toast(next ? `已收藏 /${item.code}` : `已取消收藏 /${item.code}`);\n  } catch (error) {\n    item.favorite = previous;\n    renderLinks();\n    toast(`收藏操作失败：${error.message}`);\n  }\n}\n\nfunction openShortLink(item) {\n  const url = item.short_url || `${location.origin}/${encodeURIComponent(item.code)}`;\n  window.open(url, \"_blank\", \"noopener,noreferrer\");\n}\n\nasync function toggleLinkEnabled(item) {\n  const next = !Boolean(item.enabled);\n  const previous = Boolean(item.enabled);\n  item.enabled = next ? 1 : 0;\n  renderLinks();\n  try {\n    await api(`/api/admin/links/${item.id}/status`, {\n      method: \"PATCH\",\n      body: JSON.stringify({ enabled: next }),\n    });\n    toast(next ? `已启用 /${item.code}` : `已停用 /${item.code}`);\n  } catch (error) {\n    item.enabled = previous ? 1 : 0;\n    renderLinks();\n    toast(`状态修改失败：${error.message}`);\n  }\n}\n\nasync function copyShortLink(item) {\n  const url = item.short_url || `${location.origin}/${item.code}`;\n  try {\n    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(url);\n    else {\n      const input = document.createElement(\"textarea\");\n      input.value = url;\n      input.setAttribute(\"readonly\", \"\");\n      input.style.position = \"fixed\";\n      input.style.opacity = \"0\";\n      document.body.appendChild(input);\n      input.select();\n      const ok = document.execCommand(\"copy\");\n      input.remove();\n      if (!ok) throw new Error(\"浏览器未允许复制\");\n    }\n    toast(\"短链接已复制\");\n  } catch (error) {\n    toast(`复制失败：${error.message}`);\n  }\n}\n\nasync function bulkLinkAction(action) {\n  syncLinkSelection();\n  const ids = [...A.linkSelected];\n  if (!ids.length) return toast(\"请先选择短链接\");\n\n  const messages = {\n    add_navigation: \"批量加入导航\",\n    remove_navigation: \"批量从导航移除\",\n    enable: \"批量启用\",\n    disable: \"批量停用\",\n    delete: \"批量删除\",\n  };\n  if (action === \"delete\" && !confirm(`确定删除已选择的 ${ids.length} 个短链接吗？\\n已关联的导航项目也会一起删除。`)) return;\n  if (action === \"remove_navigation\" && !confirm(`确定将已选择的 ${ids.length} 个短链接从导航中移除吗？\\n不会删除短链接本身。`)) return;\n\n  const button = document.querySelector(`[data-bulk-action=\"${action}\"]`);\n  if (button) button.disabled = true;\n  try {\n    const result = await api(\"/api/admin/links/bulk\", {\n      method: \"POST\",\n      body: JSON.stringify({ ids, action }),\n    });\n    A.linkSelected.clear();\n    const failed = Number(result.failed || 0);\n    toast(`${messages[action]}完成：${Number(result.affected || 0)} 项${failed ? `，${failed} 项未处理` : \"\"}`);\n    await loadAll();\n  } catch (error) {\n    toast(`${messages[action]}失败：${error.message}`);\n  } finally {\n    if (button) button.disabled = false;\n  }\n}\n\nfunction renderLinks() {\n  const pageRows = A.links;\n  const selectedIds = new Set(A.linkSelected);\n\n  $(\"#linksTable\").innerHTML = pageRows.map((item) => {\n    const linked = linkedNav(item);\n    const id = Number(item.id);\n    return `\n      <tr class=\"link-dense-row\">\n        <td data-label=\"选择\" class=\"link-select-cell\"><input class=\"link-select\" type=\"checkbox\" data-id=\"${id}\" aria-label=\"选择 /${esc(item.code)}\" ${selectedIds.has(id) ? \"checked\" : \"\"}></td>\n        <td data-label=\"短码\"><strong>/${esc(item.code)}</strong></td>\n        <td data-label=\"目标\"><div class=\"link-dense-title\" title=\"${esc(item.title || item.url)}\">${esc(item.title || item.url)}</div></td>\n        <td data-label=\"分类\"><span class=\"link-category\">${esc(item.category || \"未分类\")}</span></td>\n        <td data-label=\"点击\"><span class=\"click-count\">${Number(item.clicks || 0).toLocaleString()}</span></td>\n        <td data-label=\"状态\"><button class=\"status status-toggle ${item.enabled ? \"on\" : \"off\"}\" data-act=\"status\" data-id=\"${id}\" aria-label=\"${item.enabled ? \"点击停用\" : \"点击启用\"}\" title=\"${item.enabled ? \"点击停用\" : \"点击启用\"}\">${item.enabled ? \"启用\" : \"停用\"}</button></td>\n        <td data-label=\"操作\"><div class=\"row-actions compact-actions\">\n          <button class=\"small-btn favorite-btn ${item.favorite ? \"is-favorite\" : \"\"}\" data-act=\"favorite\" data-id=\"${id}\" aria-label=\"${item.favorite ? \"取消收藏\" : \"收藏\"}\" title=\"${item.favorite ? \"取消收藏\" : \"收藏\"}\">${item.favorite ? \"★\" : \"☆\"}</button>\n          <button class=\"small-btn\" data-act=\"nav\" data-id=\"${id}\" aria-label=\"${linked ? \"已在导航\" : \"添加到导航\"}\" title=\"${linked ? \"已在导航\" : \"添加到导航\"}\">${linked ? \"✓\" : \"+\"}</button>\n          <button class=\"small-btn edit-btn\" data-act=\"edit\" data-id=\"${id}\" aria-label=\"编辑\" title=\"编辑\">✎</button>\n          <button class=\"small-btn\" data-act=\"copy\" data-id=\"${id}\" aria-label=\"复制短链接\" title=\"复制短链接\">⧉</button>\n          <button class=\"small-btn\" data-act=\"open\" data-id=\"${id}\" aria-label=\"打开短链接\" title=\"打开短链接\">↗</button>\n          <button class=\"small-btn danger-btn del-btn\" data-act=\"del\" data-id=\"${id}\" aria-label=\"删除\" title=\"删除\">×</button>\n        </div></td>\n      </tr>`;\n  }).join(\"\") || '<tr><td colspan=\"7\" style=\"text-align:center;padding:30px\">暂无短链接</td></tr>';\n\n  $(\"#linksMobileList\").innerHTML = pageRows.map((item) => {\n    const linked = linkedNav(item);\n    const id = Number(item.id);\n    const title = item.title || item.url || \"无标题\";\n    return `\n      <div class=\"mobile-link-row\">\n        <div class=\"mobile-link-main\">\n          <input class=\"link-select mobile-link-select\" type=\"checkbox\" data-id=\"${id}\" aria-label=\"选择 /${esc(item.code)}\" ${selectedIds.has(id) ? \"checked\" : \"\"}>\n          <div class=\"mobile-link-copy\">\n            <strong class=\"mobile-link-code\">/${esc(item.code)}</strong>\n            <div class=\"mobile-link-meta\" title=\"${esc(title)}\">${esc(title)} · ${esc(item.category || \"未分类\")} · 点击 ${Number(item.clicks || 0).toLocaleString()}</div>\n          </div>\n        </div>\n        <button class=\"status status-toggle ${item.enabled ? \"on\" : \"off\"}\" data-act=\"status\" data-id=\"${id}\" aria-label=\"${item.enabled ? \"点击停用\" : \"点击启用\"}\" title=\"${item.enabled ? \"点击停用\" : \"点击启用\"}\">${item.enabled ? \"启用\" : \"停用\"}</button>\n        <div class=\"mobile-link-actions\">\n          <button class=\"mobile-link-action favorite-btn ${item.favorite ? \"is-favorite\" : \"\"}\" data-act=\"favorite\" data-id=\"${id}\" aria-label=\"${item.favorite ? \"取消收藏\" : \"收藏\"}\" title=\"${item.favorite ? \"取消收藏\" : \"收藏\"}\">${item.favorite ? \"★\" : \"☆\"}</button>\n          <button class=\"mobile-link-action\" data-act=\"nav\" data-id=\"${id}\" aria-label=\"${linked ? \"已在导航\" : \"添加到导航\"}\" title=\"${linked ? \"已在导航\" : \"添加到导航\"}\">${linked ? \"✓\" : \"+\"}</button>\n          <button class=\"mobile-link-action\" data-act=\"edit\" data-id=\"${id}\" aria-label=\"编辑\" title=\"编辑\">✎</button>\n          <button class=\"mobile-link-action\" data-act=\"copy\" data-id=\"${id}\" aria-label=\"复制短链接\" title=\"复制短链接\">⧉</button>\n          <button class=\"mobile-link-action\" data-act=\"open\" data-id=\"${id}\" aria-label=\"打开短链接\" title=\"打开短链接\">↗</button>\n          <button class=\"mobile-link-action danger-btn\" data-act=\"del\" data-id=\"${id}\" aria-label=\"删除\" title=\"删除\">×</button>\n        </div>\n      </div>`;\n  }).join(\"\") || '<div class=\"mobile-link-empty\">暂无短链接</div>';\n\n  renderPagination(\"#linksPagination\", A.linkPage, A.linkTotal, A.linkPageSize, async (page, pageSize) => {\n    A.linkPage = page;\n    if (pageSize) { A.linkPageSize = pageSize; localStorage.setItem(\"stnav_link_page_size\", String(pageSize)); }\n    await loadAll();\n  }, A.linkPages);\n  updateLinkBulkUi();\n}\n\nlet linkSearchTimer = null;\n$(\"#linkSearch\").oninput = () => {\n  clearTimeout(linkSearchTimer);\n  linkSearchTimer = setTimeout(() => loadAll({ resetPages: true }), 220);\n};\nconst linkSort = $(\"#linkSort\");\nif (linkSort) {\n  linkSort.value = A.linkSort;\n  linkSort.onchange = () => {\n    A.linkSort = linkSort.value || \"created_desc\";\n    localStorage.setItem(\"stnav_link_sort\", A.linkSort);\n    loadAll({ resetPages: true });\n  };\n}\n$(\"#selectPageLinks\").onclick = () => selectVisibleLinks(false);\n$(\"#selectAllLinks\").onclick = () => selectVisibleLinks(true);\n$(\"#clearSelectedLinks\").onclick = clearSelectedLinks;\n$(\"#bulkAddNav\").dataset.bulkAction = \"add_navigation\";\n$(\"#bulkRemoveNav\").dataset.bulkAction = \"remove_navigation\";\n$(\"#bulkEnableLinks\").dataset.bulkAction = \"enable\";\n$(\"#bulkDisableLinks\").dataset.bulkAction = \"disable\";\n$(\"#bulkDeleteLinks\").dataset.bulkAction = \"delete\";\n$(\"#bulkAddNav\").onclick = () => bulkLinkAction(\"add_navigation\");\n$(\"#bulkRemoveNav\").onclick = () => bulkLinkAction(\"remove_navigation\");\n$(\"#bulkEnableLinks\").onclick = () => bulkLinkAction(\"enable\");\n$(\"#bulkDisableLinks\").onclick = () => bulkLinkAction(\"disable\");\n$(\"#bulkDeleteLinks\").onclick = () => bulkLinkAction(\"delete\");\n\nfunction handleLinkListClick(event) {\n  const select = event.target.closest(\".link-select\");\n  if (select) {\n    const id = Number(select.dataset.id);\n    if (select.checked) A.linkSelected.add(id);\n    else A.linkSelected.delete(id);\n    updateLinkBulkUi();\n    return;\n  }\n  const button = event.target.closest(\"[data-act]\");\n  if (!button) return;\n  const item = A.links.find((value) => value.id == button.dataset.id);\n  if (!item) return;\n  if (button.dataset.act === \"edit\") linkModal(item);\n  if (button.dataset.act === \"del\") deleteLink(item);\n  if (button.dataset.act === \"nav\") addLinkToNavigation(item);\n  if (button.dataset.act === \"favorite\") toggleLinkFavorite(item);\n  if (button.dataset.act === \"copy\") copyShortLink(item);\n  if (button.dataset.act === \"open\") openShortLink(item);\n  if (button.dataset.act === \"status\") toggleLinkEnabled(item);\n}\n\n$(\"#linksTable\").onclick = handleLinkListClick;\n$(\"#linksMobileList\").onclick = handleLinkListClick;\n\nfunction linkModal(item = null) {\n  openModal(item ? \"编辑短链接\" : \"新建短链接\", `\n    <form class=\"modal-form\" id=\"linkForm\">\n      <div class=\"two\"><label>短码（留空自动生成）<input name=\"code\" value=\"${esc(item?.code || \"\")}\" placeholder=\"例如 docs\" autocomplete=\"off\" spellcheck=\"false\"><small id=\"linkCodeCheck\" class=\"link-code-check\" aria-live=\"polite\"></small></label><label>分类<input name=\"category\" value=\"${esc(item?.category || \"\")}\" placeholder=\"工作\"></label></div>\n      <label>目标 URL<input name=\"url\" required value=\"${esc(item?.url || \"\")}\" placeholder=\"https://example.com\"></label>\n      <label>标题<input name=\"title\" value=\"${esc(item?.title || \"\")}\"></label>\n      <label>描述<textarea name=\"description\" rows=\"3\">${esc(item?.description || \"\")}</textarea></label>\n      <label class=\"checkbox\"><input name=\"enabled\" type=\"checkbox\" ${item?.enabled !== false ? \"checked\" : \"\"}> 启用</label>\n      <button class=\"btn primary\">保存</button>\n    </form>\n  `);\n  const codeInput = $(\"#linkForm input[name=code]\");\n  const codeCheck = $(\"#linkCodeCheck\");\n  let codeCheckTimer = null;\n  let codeCheckSeq = 0;\n  let codeAvailable = !codeInput.value.trim();\n\n  const renderCodeCheck = (state, message = \"\") => {\n    if (!codeCheck) return;\n    codeCheck.className = `link-code-check ${state || \"\"}`.trim();\n    codeCheck.textContent = message;\n  };\n\n  const checkCodeAvailability = async () => {\n    const code = codeInput.value.trim();\n    codeAvailable = !code;\n    if (!code) {\n      renderCodeCheck(\"\", \"留空将自动生成\");\n      return;\n    }\n    if (!/^[A-Za-z0-9_-]{2,64}$/.test(code)) {\n      codeAvailable = false;\n      renderCodeCheck(\"invalid\", \"格式：2-64 位字母、数字、_、-\");\n      return;\n    }\n    renderCodeCheck(\"checking\", \"检查中…\");\n    const seq = ++codeCheckSeq;\n    try {\n      const params = new URLSearchParams({ code });\n      if (item) params.set(\"exclude_id\", String(item.id));\n      const result = await api(`/api/admin/links/check-code?${params.toString()}`);\n      if (seq !== codeCheckSeq) return;\n      codeAvailable = Boolean(result.available);\n      renderCodeCheck(codeAvailable ? \"available\" : \"unavailable\", result.message || (codeAvailable ? \"短码可用\" : \"短码不可用\"));\n    } catch (error) {\n      if (seq !== codeCheckSeq) return;\n      codeAvailable = false;\n      renderCodeCheck(\"error\", `检查失败：${error.message}`);\n    }\n  };\n\n  codeInput.oninput = () => {\n    clearTimeout(codeCheckTimer);\n    codeCheckSeq++;\n    codeAvailable = !codeInput.value.trim();\n    if (!codeInput.value.trim()) {\n      renderCodeCheck(\"\", \"留空将自动生成\");\n      return;\n    }\n    renderCodeCheck(\"checking\", \"检查中…\");\n    codeCheckTimer = setTimeout(checkCodeAvailability, 350);\n  };\n  checkCodeAvailability();\n\n  $(\"#linkForm\").onsubmit = async (event) => {\n    event.preventDefault();\n    const data = formData(event.target);\n    const code = String(data.code || \"\").trim();\n    if (code && !codeAvailable) {\n      await checkCodeAvailability();\n      if (!codeAvailable) {\n        toast(\"请使用可用的短码\");\n        codeInput.focus();\n        return;\n      }\n    }\n    try {\n      await api(item ? `/api/admin/links/${item.id}` : \"/api/admin/links\", {\n        method: item ? \"PUT\" : \"POST\",\n        body: JSON.stringify(data),\n      });\n      closeModal(); toast(item ? \"已保存，关联导航已同步\" : \"已保存\"); await loadAll();\n    } catch (error) { toast(error.message); }\n  };\n}\n\nasync function addLinkToNavigation(item) {\n  const exists = linkedNav(item);\n  try {\n    if (exists) {\n      await api(`/api/admin/navigation/${exists.id}`, { method: \"DELETE\" });\n      toast(\"已从导航移除\");\n    } else {\n      await api(\"/api/admin/navigation\", {\n        method: \"POST\",\n        body: JSON.stringify({ link_id: item.id, enabled: item.enabled !== false }),\n      });\n      toast(\"已添加到导航\");\n    }\n    await loadAll();\n  } catch (error) {\n    toast(error.message);\n  }\n}\n\nasync function deleteLink(item) {\n  const linked = linkedNav(item);\n  const message = linked\n    ? `确定删除 /${item.code} 吗？\\n对应的导航项目也会一起删除。`\n    : `确定删除 /${item.code} 吗？`;\n  if (!confirm(message)) return;\n  try { await api(`/api/admin/links/${item.id}`, { method: \"DELETE\" }); toast(\"已删除\"); await loadAll(); }\n  catch (error) { toast(error.message); }\n}\n\n\n$(\"#addLinkBtn\").onclick = () => linkModal();\n$(\"#addNavBtn\").onclick = () => navModal();\n\nfunction navTargetUrl(item) { return item.target_url || item.url || \"\"; }\nfunction adminIconProxyUrl(source, fallbackUrl = \"\") {\n  const value = String(source || \"\").trim();\n  if (!value) return iconUrl(fallbackUrl);\n  if (/^data:image\\//i.test(value)) return value;\n  try {\n    const parsed = new URL(value, location.origin);\n    if (parsed.origin === location.origin && parsed.pathname === \"/api/favicon\") return parsed.toString();\n    if (parsed.protocol === \"http:\" || parsed.protocol === \"https:\") {\n      return `/api/favicon?url=${encodeURIComponent(value)}`;\n    }\n  } catch {}\n  return iconUrl(fallbackUrl);\n}\nfunction navIcon(item) { const targetUrl = navTargetUrl(item); return item.icon ? adminIconProxyUrl(item.icon, targetUrl) : iconUrl(targetUrl); }\n\nfunction navFilteredItems() {\n  return A.nav;\n}\n\nfunction refreshNavFilters() {\n  const select = $(\"#navCategoryFilter\");\n  if (!select) return;\n  const current = select.value;\n  const categories = A.navCategories;\n  select.innerHTML = '<option value=\"\">全部分类</option>' + categories.map((category) => `<option value=\"${esc(category)}\">${esc(category)}</option>`).join(\"\");\n  select.value = categories.includes(current) ? current : \"\";\n}\n\nfunction renderNav() {\n  refreshNavFilters();\n  const element = $(\"#navAdminGrid\");\n  const pageItems = A.nav;\n  const filtered = String($(\"#navSearch\")?.value || \"\").trim() || String($(\"#navCategoryFilter\")?.value || \"\");\n  $(\"#navCount\").innerHTML = `${A.navTotal} 项` + (A.navDirty ? '<span class=\"nav-dirty\">未保存</span>' : '');\n  const selectedCount = $(\"#navSelectedCount\");\n  if (selectedCount) selectedCount.textContent = `已选 ${A.navSelected.size} 项`;\n  $(\"#navFilterHint\").classList.toggle(\"hidden\", !filtered);\n  element.innerHTML = pageItems.map((item) => {\n    const orderIndex = A.navOrderIds.indexOf(Number(item.id));\n    return `\n    <div class=\"admin-nav-card ${A.navSelected.has(Number(item.id)) ? \"selected\" : \"\"}\" draggable=\"${filtered ? \"false\" : \"true\"}\" data-id=\"${item.id}\">\n      <div class=\"admin-nav-head\">\n        <div class=\"admin-nav-selection\"><input type=\"checkbox\" data-navact=\"select\" data-id=\"${item.id}\" ${A.navSelected.has(Number(item.id)) ? \"checked\" : \"\"} aria-label=\"选择 ${esc(item.title)}\"><div class=\"admin-icon-wrap\">\n          <img class=\"site-icon\" src=\"${esc(navIcon(item))}\" alt=\"\" onerror=\"this.outerHTML='<span class=&quot;site-icon site-icon-fallback&quot;>${esc(fallbackIcon(item))}</span>'\">\n        </div></div>\n        <div class=\"admin-nav-title\"><strong>${esc(item.title)}</strong><small>${esc(item.category || \"未分类\")}</small></div>\n        <span class=\"drag-handle\">⠿</span>\n      </div>\n      <p>${esc(item.description || navTargetUrl(item))}</p>\n      <div class=\"nav-admin-meta\">\n        <div class=\"nav-admin-badges\">${item.link_id ? '<span class=\"linked-badge\">短链接</span>' : '<span class=\"manual-badge\">手动</span>'}<span class=\"nav-order-badge\">#${orderIndex >= 0 ? orderIndex + 1 : Number(item.sort_order ?? 0) + 1}</span></div>\n        <span class=\"nav-url\" title=\"${esc(navTargetUrl(item))}\">${esc(navTargetUrl(item))}</span>\n      </div>\n      <div class=\"row-actions nav-admin-actions\">\n        <button class=\"small-btn nav-move-btn\" data-navact=\"up\" data-id=\"${item.id}\" aria-label=\"上移\" title=\"上移\">↑</button>\n        <button class=\"small-btn nav-move-btn\" data-navact=\"down\" data-id=\"${item.id}\" aria-label=\"下移\" title=\"下移\">↓</button>\n        <button class=\"small-btn\" data-navact=\"edit\" data-id=\"${item.id}\" aria-label=\"编辑\" title=\"编辑\">✎</button>\n        <button class=\"small-btn\" data-navact=\"open\" data-id=\"${item.id}\" aria-label=\"打开链接\" title=\"打开链接\">↗</button>\n        <button class=\"small-btn\" data-navact=\"copy\" data-id=\"${item.id}\" aria-label=\"复制链接\" title=\"复制链接\">⧉</button>\n        <button class=\"small-btn favorite-btn ${item.favorite ? \"is-favorite\" : \"\"}\" data-navact=\"favorite\" data-id=\"${item.id}\" aria-label=\"${item.favorite ? \"取消收藏\" : \"收藏\"}\" title=\"${item.favorite ? \"取消收藏\" : \"收藏\"}\">${item.favorite ? \"★\" : \"☆\"}</button>\n        <button class=\"status status-toggle nav-status-toggle ${item.enabled ? \"on\" : \"off\"}\" data-navact=\"status\" data-id=\"${item.id}\" aria-label=\"${item.enabled ? \"点击停用\" : \"点击启用\"}\" title=\"${item.enabled ? \"点击停用\" : \"点击启用\"}\">${item.enabled ? \"启用\" : \"停用\"}</button>\n      </div>\n    </div>`;\n  }).join(\"\") || '<div class=\"panel\" style=\"padding:30px\">暂无导航</div>';\n  renderPagination(\"#navPagination\", A.navPage, A.navTotal, A.navPageSize, async (page, pageSize) => {\n    A.navPage = page;\n    if (pageSize) { A.navPageSize = pageSize; localStorage.setItem(\"stnav_nav_page_size\", String(pageSize)); }\n    await loadAll();\n  }, A.navPages);\n  bindDrag();\n}\n\nfunction bindDrag() {\n  const isFiltered = !!($(\"#navSearch\")?.value || $(\"#navCategoryFilter\")?.value);\n  if (isFiltered || A.navPage !== 1) return;\n  let dragging = null;\n  document.querySelectorAll(\".admin-nav-card\").forEach((card) => {\n    card.ondragstart = (event) => {\n      dragging = card;\n      card.classList.add(\"dragging\");\n      event.dataTransfer.effectAllowed = \"move\";\n      event.dataTransfer.setData(\"text/plain\", card.dataset.id);\n    };\n    card.ondragend = () => { card.classList.remove(\"dragging\"); dragging = null; };\n    card.ondragover = (event) => {\n      event.preventDefault();\n      if (!dragging || dragging === card) return;\n      const rect = card.getBoundingClientRect();\n      card.parentNode.insertBefore(dragging, event.clientY > rect.top + rect.height / 2 ? card.nextSibling : card);\n    };\n    card.ondrop = (event) => {\n      event.preventDefault();\n      if (!dragging) return;\n      const visibleIds = [...document.querySelectorAll(\".admin-nav-card\")].map((node) => Number(node.dataset.id));\n      const positions = visibleIds.map((id) => A.navOrderIds.indexOf(id)).filter((index) => index >= 0);\n      const reordered = visibleIds;\n      positions.forEach((position, index) => { A.navOrderIds[position] = reordered[index]; });\n      A.navOrderIds.forEach((_, index) => {});\n      A.navDirty = true;\n      renderNav();\n      toast(\"顺序已调整，点击“保存排序”后生效\");\n    };\n  });\n}\n\nfunction navOpenUrl(item) {\n  return navTargetUrl(item);\n}\n\nasync function toggleNavFavorite(item) {\n  const next = !Number(item.favorite);\n  const previous = Number(item.favorite) ? 1 : 0;\n  item.favorite = next ? 1 : 0;\n  renderNav();\n  try {\n    await api(`/api/admin/navigation/${item.id}/favorite`, {\n      method: \"PATCH\",\n      body: JSON.stringify({ favorite: next }),\n    });\n    toast(next ? `已收藏「${item.title}」` : `已取消收藏「${item.title}」`);\n  } catch (error) {\n    item.favorite = previous;\n    renderNav();\n    toast(`收藏操作失败：${error.message}`);\n  }\n}\n\nasync function toggleNavEnabled(item) {\n  const next = !Boolean(item.enabled);\n  const previous = Boolean(item.enabled);\n  item.enabled = next ? 1 : 0;\n  renderNav();\n  try {\n    await api(`/api/admin/navigation/${item.id}/status`, {\n      method: \"PATCH\",\n      body: JSON.stringify({ enabled: next }),\n    });\n    toast(next ? `已启用「${item.title}」` : `已停用「${item.title}」`);\n  } catch (error) {\n    item.enabled = previous ? 1 : 0;\n    renderNav();\n    toast(`状态修改失败：${error.message}`);\n  }\n}\n\nfunction openNavLink(item) {\n  window.open(navOpenUrl(item), \"_blank\", \"noopener,noreferrer\");\n}\n\nasync function copyNavLink(item) {\n  toast(await copyText(navOpenUrl(item)) ? \"链接已复制\" : \"复制失败\");\n}\n\n$(\"#navAdminGrid\").onclick = async (event) => {\n  const button = event.target.closest(\"[data-navact]\");\n  if (!button) return;\n  if (button.dataset.navact === \"select\") {\n    const id = Number(button.dataset.id);\n    if (button.checked) A.navSelected.add(id); else A.navSelected.delete(id);\n    renderNav();\n    return;\n  }\n  const item = A.nav.find((value) => value.id == button.dataset.id);\n  if (!item) return;\n  if (button.dataset.navact === \"edit\") navModal(item);\n  if (button.dataset.navact === \"del\") deleteNav(item);\n  if (button.dataset.navact === \"open\") openNavLink(item);\n  if (button.dataset.navact === \"copy\") copyNavLink(item);\n  if (button.dataset.navact === \"favorite\") toggleNavFavorite(item);\n  if (button.dataset.navact === \"status\") toggleNavEnabled(item);\n  if (button.dataset.navact === \"up\" || button.dataset.navact === \"down\") {\n    const currentIndex = A.navOrderIds.indexOf(Number(item.id));\n    const targetIndex = currentIndex + (button.dataset.navact === \"up\" ? -1 : 1);\n    if (currentIndex >= 0 && targetIndex >= 0 && targetIndex < A.navOrderIds.length) {\n      [A.navOrderIds[currentIndex], A.navOrderIds[targetIndex]] = [A.navOrderIds[targetIndex], A.navOrderIds[currentIndex]];\n      A.navDirty = true;\n      renderNav();\n      toast(\"顺序已调整，点击“保存排序”后生效\");\n    }\n  }\n};\n\nlet navSearchTimer = null;\n$(\"#navSearch\").oninput = () => {\n  clearTimeout(navSearchTimer);\n  navSearchTimer = setTimeout(() => loadAll({ resetPages: true }), 220);\n};\n$(\"#navCategoryFilter\").onchange = () => loadAll({ resetPages: true });\n$(\"#clearNavFilter\").onclick = () => {\n  $(\"#navSearch\").value = \"\";\n  $(\"#navCategoryFilter\").value = \"\";\n  loadAll({ resetPages: true });\n};\n\n$(\"#saveNavOrder\").onclick = async () => {\n  const ids = A.navOrderIds.map(Number);\n  try { await api(\"/api/admin/navigation/reorder\", { method: \"POST\", body: JSON.stringify({ ids }) }); A.navDirty = false; toast(\"排序已保存\"); await loadAll(); }\n  catch (error) { toast(error.message); }\n};\n\nasync function updateSelectedNav(enabled) {\n  const ids = [...A.navSelected].map(Number);\n  if (!ids.length) return toast(\"请先选择导航项目\");\n  try {\n    const result = await api(\"/api/admin/navigation/bulk\", {\n      method: \"POST\",\n      body: JSON.stringify({ ids, action: enabled ? \"enable\" : \"disable\" }),\n    });\n    A.navSelected.clear();\n    toast(`${enabled ? \"启用\" : \"停用\"}完成：${Number(result.affected || 0)} 项`);\n    await loadAll();\n  } catch (error) { toast(`批量操作失败：${error.message}`); }\n}\n\nasync function selectVisibleNav(all = false) {\n  if (!all) {\n    const targets = A.nav.map((item) => Number(item.id));\n    targets.forEach((id) => A.navSelected.add(Number(id)));\n    renderNav();\n    toast(`已选择本页 ${targets.length} 项`);\n    return;\n  }\n\n  try {\n    const params = new URLSearchParams({\n      search: String($(\"#navSearch\")?.value || \"\").trim(),\n      category: String($(\"#navCategoryFilter\")?.value || \"\"),\n    });\n    const result = await api(`/api/admin/navigation/ids?${params.toString()}`);\n    const ids = (result.ids || []).map(Number);\n    ids.forEach((id) => A.navSelected.add(id));\n    renderNav();\n    toast(`已选择 ${ids.length} 项（当前筛选结果）`);\n  } catch (error) {\n    toast(`选择全部失败：${error.message}`);\n  }\n}\n\n$(\"#selectPageNav\").onclick = () => selectVisibleNav(false);\n$(\"#selectAllNav\").onclick = () => selectVisibleNav(true);\n$(\"#clearSelectedNav\").onclick = () => { A.navSelected.clear(); renderNav(); };\n$(\"#enableSelectedNav\").onclick = () => updateSelectedNav(true);\n$(\"#disableSelectedNav\").onclick = () => updateSelectedNav(false);\n$(\"#deleteSelectedNav\").onclick = async () => {\n  const ids = [...A.navSelected].map(Number);\n  if (!ids.length) return toast(\"请先选择导航项目\");\n  if (!confirm(`确定删除选中的 ${ids.length} 个导航项目吗？此操作不可撤销。`)) return;\n  try {\n    const result = await api(\"/api/admin/navigation/bulk\", {\n      method: \"POST\",\n      body: JSON.stringify({ ids, action: \"delete\" }),\n    });\n    A.navSelected.clear();\n    toast(`已删除 ${Number(result.affected || 0)} 项`);\n    await loadAll();\n  } catch (error) { toast(error.message); }\n};\n\nfunction navModal(item = null) {\n  openModal(item ? \"编辑导航\" : \"添加导航\", `\n    <form class=\"modal-form\" id=\"navForm\">\n      <div class=\"two\"><label>标题<input name=\"title\" required value=\"${esc(item?.title || \"\")}\"></label><label>分类<input name=\"category\" value=\"${esc(item?.category || \"\")}\" placeholder=\"工具\"></label></div>\n      <label>目标 URL<input name=\"url\" required value=\"${esc(item?.target_url || item?.url || \"\")}\" ${item?.link_id ? \"readonly\" : \"\"}></label>\n      <label>描述<textarea name=\"description\" rows=\"3\">${esc(item?.description || \"\")}</textarea></label>\n      <label>图标 URL（可选）<input name=\"icon\" value=\"${esc(item?.icon || \"\")}\" placeholder=\"留空自动使用网站 favicon\"></label>\n      ${item?.link_id ? '<div class=\"form-note\">此导航已关联短链接。请在「短链接」中编辑；导航会自动同步，避免把短链接地址误当成真实目标 URL。</div>' : ''}\n      <label class=\"checkbox\"><input name=\"enabled\" type=\"checkbox\" ${item?.enabled !== false ? \"checked\" : \"\"}> 启用</label>\n      ${item?.link_id ? '<button type=\"button\" class=\"btn\" id=\"linkedNavClose\">关闭</button>' : '<button class=\"btn primary\">保存</button>'}\n    </form>\n  `);\n  $(\"#navForm\").onsubmit = async (event) => {\n    event.preventDefault();\n    const data = formData(event.target);\n    if (item?.link_id) return;\n    try {\n      await api(item ? `/api/admin/navigation/${item.id}` : \"/api/admin/navigation\", {\n        method: item ? \"PUT\" : \"POST\",\n        body: JSON.stringify(data),\n      });\n      closeModal(); toast(\"已保存\"); await loadAll();\n    } catch (error) { toast(error.message); }\n  };\n  if (item?.link_id) {\n    $(\"#linkedNavClose\").onclick = closeModal;\n  }\n}\n\nasync function deleteNav(item) {\n  if (!confirm(`确定删除「${item.title}」吗？`)) return;\n  try { await api(`/api/admin/navigation/${item.id}`, { method: \"DELETE\" }); toast(\"已删除\"); await loadAll(); }\n  catch (error) { toast(error.message); }\n}\n\nfunction initSettingsTabs() {\n  const tabs = [...document.querySelectorAll(\"[data-settings-tab]\")];\n  const panels = [...document.querySelectorAll(\"[data-settings-panel]\")];\n  if (!tabs.length) return;\n  const activate = (name) => {\n    tabs.forEach((tab) => {\n      const active = tab.dataset.settingsTab === name;\n      tab.classList.toggle(\"active\", active);\n      tab.setAttribute(\"aria-selected\", String(active));\n    });\n    panels.forEach((panel) => panel.classList.toggle(\"hidden\", panel.dataset.settingsPanel !== name));\n  };\n  tabs.forEach((tab) => tab.addEventListener(\"click\", () => activate(tab.dataset.settingsTab)));\n}\n\nfunction fillSettings() {\n  const form = $(\"#settingsForm\");\n  [\"site_title\", \"site_subtitle\", \"site_description\", \"hero_title\", \"hero_description\", \"accent\", \"nav_tag_style\", \"nav_columns_mobile\", \"nav_columns_tablet\", \"nav_columns_desktop\", \"nav_columns_wide\", \"nav_category_order\", \"nav_hidden_categories\"].forEach((key) => {\n    if (form.elements[key]) form.elements[key].value = A.settings[key] || ({\n      accent: \"#8b6cff\", nav_tag_style: \"pills\", nav_columns_mobile: \"2\", nav_columns_tablet: \"3\", nav_columns_desktop: \"4\", nav_columns_wide: \"6\"\n    }[key] || \"\");\n  });\n}\n\n$(\"#settingsForm\").onsubmit = async (event) => {\n  event.preventDefault();\n  const data = formData(event.target);\n  try {\n    await api(\"/api/admin/settings\", { method: \"PUT\", body: JSON.stringify(data) });\n    A.settings = { ...A.settings, ...data };\n    $(\"#settingsMessage\").textContent = \"设置已保存\";\n    toast(\"设置已保存\");\n  } catch (error) { $(\"#settingsMessage\").textContent = error.message; }\n};\n\nfunction openModal(title, html) {\n  $(\"#modalTitle\").textContent = title;\n  $(\"#modalBody\").innerHTML = html;\n  $(\"#modal\").classList.remove(\"hidden\");\n}\nfunction closeModal() { $(\"#modal\").classList.add(\"hidden\"); }\ndocument.querySelectorAll(\"[data-close-modal]\").forEach((node) => node.onclick = closeModal);\ndocument.addEventListener(\"keydown\", (event) => { if (event.key === \"Escape\") closeModal(); });\n\nconst csvInput = $(\"#csvFile\");\nconst dataCsvInput = $(\"#dataCsvFile\");\nconst csvImportButton = $(\"#importLinksBtn\");\nconst dataCsvButton = $(\"#dataCsvBtn\");\nconst dataExportCsvButton = $(\"#dataExportCsvBtn\");\n\nasync function exportLinksCsv(filename = \"slink-nav-links.csv\") {\n  const params = new URLSearchParams({\n    search: String($(\"#linkSearch\")?.value || \"\").trim(),\n    sort: A.linkSort || \"created_desc\",\n  });\n  const response = await fetch(`/api/admin/links/export?${params.toString()}`, { credentials: \"same-origin\" });\n  if (!response.ok) {\n    const data = await response.json().catch(() => ({}));\n    throw new Error(data.error || \"CSV 导出失败\");\n  }\n  const blob = await response.blob();\n  downloadBlob(blob, filename);\n  const contentRange = response.headers.get(\"content-range\");\n  const count = contentRange ? contentRange.split(\"/\").pop() : \"全部\";\n  toast(`CSV 导出完成：${count} 条短链接`);\n}\n\n$(\"#exportLinks\").onclick = async () => {\n  try {\n    $(\"#exportLinks\").disabled = true;\n    await exportLinksCsv();\n  } catch (error) {\n    toast(`CSV 导出失败：${error.message}`);\n  } finally {\n    $(\"#exportLinks\").disabled = false;\n  }\n};\ndataExportCsvButton?.addEventListener(\"click\", async () => {\n  try { await exportLinksCsv(); }\n  catch (error) { toast(`CSV 导出失败：${error.message}`); }\n});\n\nconst restoreJsonInput = $(\"#restoreJsonFile\");\nconst restoreJsonButton = $(\"#restoreJsonBtn\");\nconst backupJsonButton = $(\"#backupJsonBtn\");\n\nfunction downloadBlob(blob, filename) {\n  const href = URL.createObjectURL(blob);\n  const link = document.createElement(\"a\");\n  link.href = href;\n  link.download = filename;\n  document.body.appendChild(link);\n  link.click();\n  link.remove();\n  setTimeout(() => URL.revokeObjectURL(href), 1000);\n}\n\nfunction downloadJson(data, filename) {\n  downloadBlob(new Blob([\"\\ufeff\", JSON.stringify(data, null, 2)], { type: \"application/json;charset=utf-8\" }), filename);\n}\n\nfunction parseCsv(text) {\n  const rows = [];\n  let row = [], cell = \"\", quoted = false;\n  const source = String(text || \"\").replace(/^\\uFEFF/, \"\");\n  for (let i = 0; i < source.length; i++) {\n    const ch = source[i], next = source[i + 1];\n    if (ch === '\"') {\n      if (quoted && next === '\"') { cell += '\"'; i++; }\n      else quoted = !quoted;\n    } else if (ch === \",\" && !quoted) {\n      row.push(cell); cell = \"\";\n    } else if ((ch === \"\\n\" || ch === \"\\r\") && !quoted) {\n      if (ch === \"\\r\" && next === \"\\n\") i++;\n      row.push(cell); cell = \"\";\n      if (row.some((value) => value.trim() !== \"\")) rows.push(row);\n      row = [];\n    } else cell += ch;\n  }\n  if (quoted) throw new Error(\"CSV 引号不匹配\");\n  if (cell !== \"\" || row.length) {\n    row.push(cell);\n    if (row.some((value) => value.trim() !== \"\")) rows.push(row);\n  }\n  return rows;\n}\n\nfunction normalizeCsvRows(rows) {\n  if (rows.length < 2) throw new Error(\"CSV 没有可导入的数据\");\n  const headers = rows[0].map((value) => value.trim().toLowerCase());\n  const required = [\"code\", \"url\"];\n  const missing = required.filter((key) => !headers.includes(key));\n  if (missing.length) throw new Error(`CSV 缺少必需列：${missing.join(\", \")}`);\n  const seen = new Map();\n  return rows.slice(1).map((values, index) => {\n    const data = {};\n    headers.forEach((key, col) => { data[key] = String(values[col] ?? \"\").trim(); });\n    data.enabled = ![\"false\", \"0\", \"no\", \"否\", \"停用\"].includes(String(data.enabled).toLowerCase());\n    const code = data.code;\n    const duplicateInFile = code && seen.has(code);\n    if (code) seen.set(code, index + 2);\n    let error = \"\";\n    if (!code) error = \"缺少短码\";\n    else if (!/^[A-Za-z0-9_-]{2,64}$/.test(code)) error = \"短码格式无效\";\n    if (!data.url) error = error || \"缺少 URL\";\n    else {\n      try { const u = new URL(data.url); if (![\"http:\", \"https:\"].includes(u.protocol)) error = error || \"URL 必须是 http/https\"; }\n      catch { error = error || \"URL 格式无效\"; }\n    }\n    if (duplicateInFile) error = error || `与第 ${seen.get(code)} 行重复`;\n    const existing = A.links.find((item) => item.code === code);\n    return { row: index + 2, ...data, existingId: existing ? Number(existing.id) : null, conflict: Boolean(existing), error };\n  });\n}\n\nfunction openCsvPicker(input) {\n  if (!input) return;\n  input.value = \"\";\n  input.click();\n}\ncsvImportButton?.addEventListener(\"click\", () => openCsvPicker(csvInput));\ndataCsvButton?.addEventListener(\"click\", () => openCsvPicker(dataCsvInput));\n\nfunction csvPreviewModal(items, filename) {\n  const valid = items.filter((item) => !item.error);\n  const conflicts = valid.filter((item) => item.conflict);\n  const invalid = items.filter((item) => item.error);\n  const statusText = `${items.length} 行，${valid.length} 条可导入，${conflicts.length} 条重复，${invalid.length} 条有问题`;\n  openModal(\"CSV 导入预览\", `\n    <div class=\"import-summary\"><strong>${esc(filename)}</strong><span>${statusText}</span></div>\n    <div class=\"import-options\">\n      <label>重复短码处理<select id=\"csvConflictMode\"><option value=\"skip\">跳过重复</option><option value=\"update\">覆盖已有</option><option value=\"rename\">自动生成新短码</option></select></label>\n    </div>\n    <div class=\"import-preview-scroll\"><table class=\"import-preview-table\"><thead><tr><th>行</th><th>短码</th><th>目标</th><th>状态</th></tr></thead><tbody>\n      ${items.slice(0, 500).map((item) => `<tr><td>${item.row}</td><td><strong>${esc(item.code || \"—\")}</strong></td><td title=\"${esc(item.url || \"\")}\">${esc(item.url || \"—\")}</td><td><span class=\"import-status ${item.error ? \"bad\" : item.conflict ? \"warn\" : \"good\"}\">${esc(item.error || (item.conflict ? \"重复\" : \"新增\"))}</span></td></tr>`).join(\"\")}\n    </tbody></table></div>\n    ${items.length > 500 ? '<div class=\"form-note\">预览最多显示前 500 行，实际导入仍会处理全部行。</div>' : ''}\n    <div class=\"modal-actions\"><button type=\"button\" class=\"btn secondary\" id=\"csvPreviewCancel\">取消</button><button type=\"button\" class=\"btn primary\" id=\"csvPreviewImport\">开始导入</button></div>\n  `);\n  $(\"#csvPreviewCancel\").onclick = closeModal;\n  $(\"#csvPreviewImport\").onclick = async () => {\n    const mode = $(\"#csvConflictMode\").value;\n    const button = $(\"#csvPreviewImport\");\n    button.disabled = true;\n    try {\n      const candidates = items.filter((item) => !item.error);\n      let success = 0, skipped = 0, failed = 0;\n      for (let i = 0; i < candidates.length; i += 25) {\n        const chunk = candidates.slice(i, i + 25);\n        const result = await api(\"/api/admin/links/import\", {\n          method: \"POST\",\n          body: JSON.stringify({ mode, rows: chunk.map(({ row, existingId, conflict, error, ...data }) => ({ ...data, existing_id: existingId })) }),\n        });\n        success += Number(result.imported || 0);\n        skipped += Number(result.skipped || 0);\n        failed += Number(result.failed || 0);\n      }\n      closeModal();\n      toast(`CSV 导入完成：成功 ${success} 条${skipped ? `，跳过 ${skipped} 条` : \"\"}${failed ? `，失败 ${failed} 条` : \"\"}`);\n      await loadAll();\n    } catch (error) {\n      toast(`CSV 导入失败：${error.message}`);\n      button.disabled = false;\n    }\n  };\n}\n\nasync function handleCsvFile(file) {\n  if (!file) return;\n  if (!/\\.csv$/i.test(file.name || \"\")) throw new Error(\"请选择扩展名为 .csv 的文件\");\n  if (file.size === 0) throw new Error(\"CSV 文件为空\");\n  if (file.size > 10 * 1024 * 1024) throw new Error(\"CSV 文件不能超过 10 MB\");\n  const items = normalizeCsvRows(parseCsv(await file.text()));\n  csvPreviewModal(items, file.name);\n}\n\nfor (const input of [csvInput, dataCsvInput]) {\n  input?.addEventListener(\"change\", async (event) => {\n    const file = event.currentTarget.files?.[0];\n    try { await handleCsvFile(file); }\n    catch (error) { toast(`CSV 预览失败：${error.message || \"读取文件失败\"}`); }\n    finally { event.currentTarget.value = \"\"; }\n  });\n}\n\nasync function createJsonBackup() {\n  const data = await api(\"/api/admin/backup\");\n  const stamp = new Date().toISOString().replace(/[:.]/g, \"-\");\n  downloadJson(data, `slink-nav-backup-${stamp}.json`);\n  toast(`JSON 备份完成：${Number(data.meta?.links || 0)} 个短链接，${Number(data.meta?.navigation || 0)} 个导航`);\n}\nbackupJsonButton?.addEventListener(\"click\", async () => {\n  try { backupJsonButton.disabled = true; await createJsonBackup(); }\n  catch (error) { toast(`备份失败：${error.message}`); }\n  finally { backupJsonButton.disabled = false; }\n});\n\nrestoreJsonButton?.addEventListener(\"click\", () => openCsvPicker(restoreJsonInput));\nrestoreJsonInput?.addEventListener(\"change\", async (event) => {\n  const file = event.currentTarget.files?.[0];\n  try {\n    if (!file) return;\n    if (!/\\.json$/i.test(file.name || \"\")) throw new Error(\"请选择 JSON 备份文件\");\n    if (file.size === 0) throw new Error(\"JSON 文件为空\");\n    if (file.size > 10 * 1024 * 1024) throw new Error(\"JSON 备份不能超过 10 MB\");\n    const data = JSON.parse((await file.text()).replace(/^\\uFEFF/, \"\"));\n    const counts = data?.meta || {};\n    if (data?.format !== \"slink-nav-backup\" || !Array.isArray(data.links) || !Array.isArray(data.navigation) || !Array.isArray(data.settings)) {\n      throw new Error(\"不是有效的 SLink Nav JSON 备份文件\");\n    }\n    openModal(\"JSON 恢复\", `\n      <div class=\"restore-summary\"><strong>${esc(file.name)}</strong><span>短链接 ${Number(counts.links || data.links.length)} · 导航 ${Number(counts.navigation || data.navigation.length)} · 设置 ${Number(counts.settings || data.settings.length)}</span></div>\n      <div class=\"import-options\"><label>恢复方式<select id=\"jsonRestoreMode\"><option value=\"merge\">合并恢复（推荐）</option><option value=\"replace\">完全覆盖恢复</option></select></label></div>\n      <div class=\"form-note\">合并不会删除现有数据；完全覆盖会清空当前业务数据。覆盖恢复前请确认你已经保留当前备份。</div>\n      <div class=\"modal-actions\"><button type=\"button\" class=\"btn secondary\" id=\"restoreCancel\">取消</button><button type=\"button\" class=\"btn primary\" id=\"restoreStart\">开始恢复</button></div>\n    `);\n    $(\"#restoreCancel\").onclick = closeModal;\n    $(\"#restoreStart\").onclick = async () => {\n      const mode = $(\"#jsonRestoreMode\").value;\n      if (mode === \"replace\" && !confirm(\"完全覆盖恢复会删除当前短链接、导航、统计和设置，确定继续吗？\")) return;\n      const button = $(\"#restoreStart\");\n      button.disabled = true;\n      try {\n        const result = await api(\"/api/admin/restore\", { method: \"POST\", body: JSON.stringify({ mode, backup: data }) });\n        closeModal();\n        toast(`JSON 恢复完成：新增/更新短链接 ${Number(result.links || 0)}，导航 ${Number(result.navigation || 0)}`);\n        await loadAll();\n      } catch (error) {\n        toast(`JSON 恢复失败：${error.message}`);\n        button.disabled = false;\n      }\n    };\n  } catch (error) { toast(`JSON 读取失败：${error.message || \"文件无效\"}`); }\n  finally { event.currentTarget.value = \"\"; }\n});\n\nfunction toggleAdminTheme() {\n  document.documentElement.classList.toggle(\"light-admin\");\n  localStorage.setItem(\"sln_admin_theme\", document.documentElement.classList.contains(\"light-admin\") ? \"light\" : \"dark\");\n  $(\"#adminThemeBtn\").textContent = document.documentElement.classList.contains(\"light-admin\") ? \"☀\" : \"☾\";\n}\n\nif (localStorage.getItem(\"sln_admin_theme\") === \"light\") document.documentElement.classList.add(\"light-admin\");\n$(\"#adminThemeBtn\").textContent = document.documentElement.classList.contains(\"light-admin\") ? \"☀\" : \"☾\";\n$(\"#adminThemeBtn\").onclick = toggleAdminTheme;\ninitSettingsTabs();\nboot();\n","favicon.svg":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\"><defs><linearGradient id=\"g\" x1=\"0\" x2=\"1\" y1=\"0\" y2=\"1\"><stop stop-color=\"#8b6cff\"/><stop offset=\"1\" stop-color=\"#6c8cff\"/></linearGradient></defs><rect width=\"64\" height=\"64\" rx=\"16\" fill=\"url(#g)\"/><path d=\"M39 18c-3-3-8-4-13-1-5 3-5 8-1 11l13 7c4 2 4 6 0 9-5 3-11 2-14-1\" fill=\"none\" stroke=\"white\" stroke-width=\"6\" stroke-linecap=\"round\"/></svg>","manifest.webmanifest":"{\n  \"name\": \"SLink Nav\",\n  \"short_name\": \"SLink Nav\",\n  \"description\": \"Personal navigation & short links\",\n  \"start_url\": \"/\",\n  \"scope\": \"/\",\n  \"display\": \"standalone\",\n  \"display_override\": [\"window-controls-overlay\", \"standalone\"],\n  \"orientation\": \"portrait\",\n  \"background_color\": \"#0b0d12\",\n  \"theme_color\": \"#0b0d12\",\n  \"icons\": [\n    {\"src\":\"/assets/favicon.svg\",\"sizes\":\"any\",\"type\":\"image/svg+xml\",\"purpose\":\"any maskable\"}\n  ]\n}\n","sw.js":"const CACHE = \"slink-nav-shell-v1\";\nconst SHELL = [\"/\", \"/assets/styles.css\", \"/assets/common.js\", \"/assets/app.js\", \"/assets/favicon.svg\", \"/manifest.webmanifest\"];\nself.addEventListener(\"install\", (event) => {\n  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));\n});\nself.addEventListener(\"activate\", (event) => {\n  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));\n});\nself.addEventListener(\"fetch\", (event) => {\n  const request = event.request;\n  if (request.method !== \"GET\" || new URL(request.url).origin !== self.location.origin) return;\n  const url = new URL(request.url);\n  if (url.pathname.startsWith(\"/api/\")) return;\n  // Never let the service worker serve a stale admin page or admin bundle.\n  // These files change frequently and contain management logic.\n  if (url.pathname === \"/admin\" || url.pathname === \"/admin/\" || url.pathname === \"/admin.html\" || url.pathname === \"/assets/admin.js\" || url.pathname === \"/assets/common.js\") {\n    event.respondWith(fetch(request, { cache: \"no-store\" }));\n    return;\n  }\n  event.respondWith(fetch(request).then((response) => {\n    const copy = response.clone();\n    caches.open(CACHE).then((cache) => cache.put(request, copy));\n    return response;\n  }).catch(() => caches.match(request).then((cached) => cached || caches.match(\"/\"))));\n});\n"};

const ASSET_META = {
  "index.html": ["text/html; charset=UTF-8", "no-store"],
  "admin.html": ["text/html; charset=UTF-8", "no-store"],
  "styles.css": ["text/css; charset=UTF-8", "public, max-age=31536000, immutable"],
  "common.js": ["application/javascript; charset=UTF-8", "public, max-age=31536000, immutable"],
  "app.js": ["application/javascript; charset=UTF-8", "public, max-age=31536000, immutable"],
  "admin.js": ["application/javascript; charset=UTF-8", "public, max-age=31536000, immutable"],
  "favicon.svg": ["image/svg+xml", "public, max-age=31536000, immutable"],
  "manifest.webmanifest": ["application/manifest+json; charset=UTF-8", "public, max-age=3600"],
  "sw.js": ["application/javascript; charset=UTF-8", "no-store"],
};

function embeddedAsset(pathname) {
  let key = String(pathname || "/").replace(/^\/+/, "");
  if (!key) key = "index.html";
  if (key === "admin" || key === "admin/") key = "admin.html";
  if (key.startsWith("assets/")) key = key.slice(7).split("?")[0];
  else key = key.split("?")[0];
  const body = EMBEDDED_ASSETS[key];
  if (body === undefined) return null;
  const meta = ASSET_META[key] || ["text/plain; charset=UTF-8", "no-store"];
  return new Response(body, { headers: { "content-type": meta[0], "cache-control": meta[1] } });
}

const JSON_HEADERS = {
  "content-type": "application/json;charset=UTF-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "x-frame-options": "DENY",
};

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...SECURITY_HEADERS, ...headers },
  });

const now = () => new Date().toISOString();
const b62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const CODE_RE = /^[A-Za-z0-9_-]{2,64}$/;
const RESERVED_CODES = new Set(["admin", "api"]);
const ALLOWED_SETTINGS = [
  "site_title",
  "site_subtitle",
  "site_description",
  "hero_title",
  "hero_description",
  "accent",
  "nav_tag_style",
  "nav_columns_mobile",
  "nav_columns_tablet",
  "nav_columns_desktop",
  "nav_columns_wide",
  "nav_category_order",
  "nav_hidden_categories",
];

function randomCode(n = 7) {
  let s = "";
  const size = b62.length;
  const limit = Math.floor(0x100000000 / size) * size;
  const values = new Uint32Array(n);
  while (s.length < n) {
    crypto.getRandomValues(values);
    for (let i = 0; i < values.length && s.length < n; i++) {
      if (values[i] >= limit) continue;
      s += b62[values[i] % size];
    }
  }
  return s;
}

function validUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function faviconUrl(value) {
  // Auto icons are resolved through the same-origin /api/favicon proxy.
  // Keep the DB free of browser-dependent Google/DuckDuckGo favicon URLs.
  return "";
}

function clean(value, max = 2000) {
  return String(value ?? "").trim().slice(0, max);
}

function base64urlEncode(value) {
  return btoa(value)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64urlDecode(value) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
  return atob(padded);
}

function cookie(name, value, maxAge = SESSION_TTL) {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data)
  );
  return base64urlEncode(String.fromCharCode(...new Uint8Array(sig)));
}

async function sessionToken(secret) {
  const iat = Date.now();
  const payload = base64urlEncode(JSON.stringify({ exp: iat + SESSION_TTL * 1000, iat }));
  return `${payload}.${await hmac(secret, payload)}`;
}

function getCookie(request, name) {
  const cookies = request.headers.get("Cookie") || "";
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match?.[1] || "";
}

async function safePasswordMatch(input, expected) {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(String(input))),
    crypto.subtle.digest("SHA-256", encoder.encode(String(expected))),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function sessionSecret(env) {
  return String(env.SESSION_SECRET || env.ADMIN_PASSWORD || "");
}

async function isAuthed(request, env) {
  const secret = sessionSecret(env);
  if (!secret) return false;
  const token = getCookie(request, SESSION_COOKIE);
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;
  try {
    const data = JSON.parse(base64urlDecode(payload));
    if (!data.exp || data.exp < Date.now()) return false;
    const signatureBytes = Uint8Array.from(
      base64urlDecode(signature),
      (char) => char.charCodeAt(0)
    );
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
    );
    return await crypto.subtle.verify(
      { name: "HMAC" }, key, signatureBytes, new TextEncoder().encode(payload)
    );
  } catch {
    return false;
  }
}

function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin;
}

async function requireAuth(request, env) {
  if (!(await isAuthed(request, env))) return json({ error: "未登录" }, 401);
  if (!sameOrigin(request)) return json({ error: "非法来源" }, 403);
  return null;
}

class RequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const MAX_JSON_BODY_BYTES = 1024 * 1024;
const MAX_RESTORE_BODY_BYTES = 10 * 1024 * 1024;

async function bodyWithLimit(request, maxBytes = MAX_JSON_BODY_BYTES) {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    throw new RequestError("请求体过大", 413);
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new RequestError("请求体过大", 413);
  }
  if (!text.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RequestError("请求 JSON 格式无效", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RequestError("请求 JSON 必须是对象", 400);
  }
  return parsed;
}

async function body(request) {
  return bodyWithLimit(request, MAX_JSON_BODY_BYTES);
}

function routeParts(path) {
  return path.split("/").filter(Boolean);
}

const PUBLIC_CACHE_PATH = "/api/public/bootstrap";
function publicCacheKey(request) {
  const url = new URL(request.url);
  url.pathname = PUBLIC_CACHE_PATH;
  url.search = "";
  return new Request(url.toString(), { method: "GET" });
}

function redirectCacheKey(request, code) {
  const url = new URL(request.url);
  url.pathname = `/__sln_redirect_cache/${encodeURIComponent(code)}`;
  url.search = "";
  return new Request(url.toString(), { method: "GET" });
}

function cacheAvailable() {
  return typeof caches !== "undefined" && !!caches.default;
}

function waitUntil(ctx, promise) {
  if (!promise) return;
  if (ctx?.waitUntil) {
    ctx.waitUntil(Promise.resolve(promise).catch((error) => console.error(error)));
  } else if (promise?.catch) {
    promise.catch((error) => console.error(error));
  }
}

function invalidateRedirectCache(request, ctx, code) {
  if (!code || !cacheAvailable()) return;
  waitUntil(ctx, caches.default.delete(redirectCacheKey(request, code)));
}

function invalidatePublicCache(request, ctx) {
  if (!cacheAvailable()) return;
  const key = publicCacheKey(request);
  waitUntil(ctx, caches.default.delete(key));
}

async function getPublicBootstrap(env) {
  const results = await env.DB.batch([
    env.DB.prepare(`SELECT navigation.id,
                           COALESCE(links.title, navigation.title) AS title,
                           COALESCE(links.description, navigation.description) AS description,
                           navigation.url,
                           navigation.icon,
                           COALESCE(links.category, navigation.category) AS category,
                           navigation.sort_order,
                           navigation.enabled,
                           navigation.link_id,
                           links.code,
                           links.url AS link_url,
                           links.favorite AS link_favorite
                    FROM navigation
                    LEFT JOIN links ON navigation.link_id=links.id
                    WHERE navigation.enabled=1 AND (navigation.link_id IS NULL OR links.enabled=1)
                    ORDER BY navigation.sort_order,navigation.id`),
    env.DB.prepare("SELECT key,value FROM settings"),
  ]);
  return { items: results[0].results, settings: Object.fromEntries(results[1].results.map((row) => [row.key, row.value])) };
}

function publicPayload(data, request) {
  const origin = new URL(request.url).origin;
  return {
    items: data.items.map((item) => {
      const targetUrl = item.link_url || item.url;
      const iconSource = item.icon && !/^https?:\/\/(?:www\.google\.com\/s2\/favicons|icons\.duckduckgo\.com\/ip3\/)/i.test(item.icon) ? item.icon : targetUrl;
      return {
        ...item,
        target_url: targetUrl,
        icon: iconSource ? new URL("/api/favicon?url=" + encodeURIComponent(iconSource), request.url).toString() : "",
        ...(item.code ? { short_url: `${origin}/${item.code}` } : {}),
      };
    }),
    settings: data.settings,
  };
}

function cachePut(cache, key, response, ctx) {
  try {
    const put = cache.put(key, response.clone());
    if (ctx?.waitUntil) ctx.waitUntil(put);
    else put.catch((error) => console.error("Cache write failed", error));
  } catch (error) {
    console.error("Cache write failed", error);
  }
}

async function cachedPublicBootstrap(request, env, ctx) {
  if (!cacheAvailable()) return json(publicPayload(await getPublicBootstrap(env), request));

  const cache = caches.default;
  const key = publicCacheKey(request);
  const cached = await cache.match(key);
  if (cached) return cached;

  const response = json(publicPayload(await getPublicBootstrap(env), request), 200, {
    "cache-control": PUBLIC_CACHE_CONTROL,
  });
  cachePut(cache, key, response, ctx);
  return response;
}

const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;

function clientKey(request) {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() || "unknown";
}
function checkLoginRateLimit(request) {
  const nowMs = Date.now();
  const key = clientKey(request);
  const row = loginAttempts.get(key);
  if (!row || row.resetAt <= nowMs) return { ok: true, retryAfter: 0 };
  return { ok: row.failures < LOGIN_MAX_FAILURES, retryAfter: Math.max(1, Math.ceil((row.resetAt - nowMs) / 1000)) };
}
function recordLoginFailure(request) {
  const nowMs = Date.now();
  const key = clientKey(request);
  if (loginAttempts.size > 1000) {
    for (const [storedKey, stored] of loginAttempts) {
      if (stored.resetAt <= nowMs || loginAttempts.size > 900) loginAttempts.delete(storedKey);
      if (loginAttempts.size <= 900) break;
    }
  }
  const row = loginAttempts.get(key);
  if (!row || row.resetAt <= nowMs) loginAttempts.set(key, { failures: 1, resetAt: nowMs + LOGIN_WINDOW_MS });
  else row.failures += 1;
}
function clearLoginFailures(request) { loginAttempts.delete(clientKey(request)); }


const BACKUP_FORMAT = "slink-nav-backup";
const LEGACY_BACKUP_FORMAT = "st-nav-backup";
const BACKUP_VERSION = 1;
const MAX_RESTORE_ROWS = 10000;

function boolValue(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback ? 1 : 0;
  if (value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true") return 1;
  return 0;
}

function backupString(value, max) {
  return clean(value, max);
}

function validateBackup(data) {
  if (!data || (data.format !== BACKUP_FORMAT && data.format !== LEGACY_BACKUP_FORMAT)) throw new RequestError("不是有效的 SLink Nav JSON 备份文件", 400);
  if (!Number.isInteger(Number(data.version)) || Number(data.version) < 1) throw new RequestError("备份版本无效", 400);
  for (const key of ["links", "navigation", "settings", "link_daily_stats"]) {
    if (!Array.isArray(data[key])) throw new RequestError(`备份缺少 ${key} 数据`, 400);
    if (data[key].length > MAX_RESTORE_ROWS * (key === "link_daily_stats" ? 5 : 1)) throw new RequestError(`${key} 数据量过大`, 413);
  }
}

async function makeBackup(env) {
  const results = await env.DB.batch([
    env.DB.prepare(`SELECT id,code,url,title,description,category,enabled,favorite,clicks,last_clicked_at,created_at,updated_at FROM links ORDER BY id`),
    env.DB.prepare(`SELECT navigation.id,
                           COALESCE(links.title, navigation.title) AS title,
                           COALESCE(links.description, navigation.description) AS description,
                           COALESCE(links.url, navigation.url) AS url,
                           navigation.icon,
                           COALESCE(links.category, navigation.category) AS category,
                           navigation.sort_order,
                           navigation.enabled,
                           CASE WHEN navigation.link_id IS NOT NULL THEN links.favorite ELSE navigation.favorite END AS favorite,
                           navigation.link_id,
                           navigation.created_at,
                           navigation.updated_at
                    FROM navigation
                    LEFT JOIN links ON navigation.link_id=links.id
                    ORDER BY navigation.sort_order,navigation.id`),
    env.DB.prepare(`SELECT key,value FROM settings ORDER BY key`),
    env.DB.prepare(`SELECT link_id,day,clicks FROM link_daily_stats ORDER BY day,link_id`),
  ]);
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    app_version: VERSION,
    exported_at: now(),
    meta: {
      links: results[0].results.length,
      navigation: results[1].results.length,
      settings: results[2].results.length,
      link_daily_stats: results[3].results.length,
    },
    links: results[0].results,
    navigation: results[1].results,
    settings: results[2].results,
    link_daily_stats: results[3].results,
  };
}

function validBackupLink(item) {
  return item && CODE_RE.test(String(item.code || "")) && !RESERVED_CODES.has(String(item.code).toLowerCase()) && validUrl(item.url);
}

async function restoreBackup(env, data, mode) {
  validateBackup(data);
  if (!["merge", "replace"].includes(mode)) throw new RequestError("恢复方式无效", 400);

  const links = data.links;
  const navigation = data.navigation;
  const settings = data.settings;
  const stats = data.link_daily_stats;
  const linkMap = new Map();
  let linksAffected = 0;
  let navAffected = 0;
  let statsAffected = 0;

  if (mode === "replace") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM link_daily_stats"),
      env.DB.prepare("DELETE FROM navigation"),
      env.DB.prepare("DELETE FROM links"),
      env.DB.prepare("DELETE FROM settings"),
    ]);
  }

  // Restore links first so navigation and daily stats can safely reference them.
  for (let i = 0; i < links.length; i += 50) {
    const chunk = links.slice(i, i + 50);
    const statements = [];
    for (const item of chunk) {
      if (!validBackupLink(item)) throw new RequestError(`备份中的短链接无效：${clean(item?.code, 80)}`, 400);
      const code = clean(item.code, 64);
      const url = clean(item.url, 2000);
      const title = clean(item.title, 200);
      const description = clean(item.description, 500);
      const category = clean(item.category, 80);
      const enabled = boolValue(item.enabled, true);
      const favorite = boolValue(item.favorite, false);
      const clicks = Math.max(0, Number(item.clicks) || 0);
      const lastClicked = clean(item.last_clicked_at, 80);
      const createdAt = clean(item.created_at, 80) || now();
      const updatedAt = clean(item.updated_at, 80) || now();
      if (mode === "replace") {
        const id = Number(item.id);
        if (!Number.isInteger(id) || id <= 0) throw new RequestError(`备份短链接 ID 无效：${code}`, 400);
        statements.push(env.DB.prepare(`INSERT INTO links(id,code,url,title,description,category,enabled,favorite,clicks,last_clicked_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,code,url,title,description,category,enabled,favorite,clicks,lastClicked||null,createdAt,updatedAt));
        linkMap.set(Number(item.id), id);
      } else {
        const existing = await env.DB.prepare("SELECT id FROM links WHERE code=?").bind(code).first();
        if (existing) {
          const id = Number(existing.id);
          linkMap.set(Number(item.id), id);
          statements.push(env.DB.prepare(`UPDATE links SET url=?,title=?,description=?,category=?,enabled=?,favorite=?,clicks=?,last_clicked_at=?,updated_at=? WHERE id=?`).bind(url,title,description,category,enabled,favorite,clicks,lastClicked||null,updatedAt,id));
        } else {
          statements.push(env.DB.prepare(`INSERT INTO links(code,url,title,description,category,enabled,favorite,clicks,last_clicked_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(code,url,title,description,category,enabled,favorite,clicks,lastClicked||null,createdAt,updatedAt));
          // D1 does not expose the inserted id in a portable way across batches; map after this chunk below.
        }
      }
    }
    if (statements.length) await env.DB.batch(statements);
    if (mode === "merge") {
      for (const item of chunk) {
        if (!linkMap.has(Number(item.id))) {
          const row = await env.DB.prepare("SELECT id FROM links WHERE code=?").bind(clean(item.code,64)).first();
          if (row) linkMap.set(Number(item.id), Number(row.id));
        }
      }
    }
    linksAffected += chunk.length;
  }

  if (mode === "merge") {
    // Re-read the map for safety after all inserts/updates.
    for (const item of links) {
      if (!linkMap.has(Number(item.id))) {
        const row = await env.DB.prepare("SELECT id FROM links WHERE code=?").bind(clean(item.code,64)).first();
        if (row) linkMap.set(Number(item.id), Number(row.id));
      }
    }
  }

  // Navigation: linked entries are keyed by their link_id; manual entries use id when replacing,
  // and a title+URL match when merging to avoid creating duplicates on repeated restores.
  for (let i = 0; i < navigation.length; i += 50) {
    const chunk = navigation.slice(i, i + 50);
    const statements = [];
    for (const item of chunk) {
      const title = clean(item.title, 120);
      const description = clean(item.description, 500);
      const url = clean(item.url, 2000);
      const icon = clean(item.icon, 1000);
      const category = clean(item.category, 80);
      const sortOrder = Number.isFinite(Number(item.sort_order)) ? Number(item.sort_order) : 0;
      const enabled = boolValue(item.enabled, true);
      const favorite = boolValue(item.favorite, false);
      const mappedLinkId = item.link_id ? linkMap.get(Number(item.link_id)) : null;
      if (item.link_id && !mappedLinkId) throw new RequestError(`导航关联的短链接不存在：${item.link_id}`, 400);
      if (!mappedLinkId && (!title || !validUrl(url))) throw new RequestError(`备份中的导航无效：${title || url}`, 400);

      if (mode === "replace") {
        const id = Number(item.id);
        if (!Number.isInteger(id) || id <= 0) throw new RequestError(`备份导航 ID 无效：${title}`, 400);
        statements.push(env.DB.prepare(`INSERT INTO navigation(id,title,description,url,icon,category,sort_order,enabled,favorite,link_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,mappedLinkId ? null : title,mappedLinkId ? null : description,mappedLinkId ? null : url,icon,mappedLinkId ? null : category,sortOrder,enabled,mappedLinkId ? null : favorite,mappedLinkId||null,clean(item.created_at,80)||now(),clean(item.updated_at,80)||now()));
      } else if (mappedLinkId) {
        const existing = await env.DB.prepare("SELECT id FROM navigation WHERE link_id=? LIMIT 1").bind(mappedLinkId).first();
        if (existing) statements.push(env.DB.prepare(`UPDATE navigation SET icon=?,sort_order=?,enabled=?,updated_at=? WHERE id=?`).bind(icon,sortOrder,enabled,clean(item.updated_at,80)||now(),Number(existing.id)));
        else statements.push(env.DB.prepare(`INSERT INTO navigation(title,description,url,icon,category,sort_order,enabled,favorite,link_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(null,null,null,icon,null,sortOrder,enabled,null,mappedLinkId,clean(item.created_at,80)||now(),clean(item.updated_at,80)||now()));
      } else {
        const existing = await env.DB.prepare("SELECT id FROM navigation WHERE link_id IS NULL AND title=? AND url=? LIMIT 1").bind(title,url).first();
        if (existing) statements.push(env.DB.prepare(`UPDATE navigation SET description=?,icon=?,category=?,sort_order=?,enabled=?,favorite=?,updated_at=? WHERE id=?`).bind(description,icon,category,sortOrder,enabled,favorite,clean(item.updated_at,80)||now(),Number(existing.id)));
        else statements.push(env.DB.prepare(`INSERT INTO navigation(title,description,url,icon,category,sort_order,enabled,favorite,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(title,description,url,icon,category,sortOrder,enabled,favorite,clean(item.created_at,80)||now(),clean(item.updated_at,80)||now()));
      }
    }
    if (statements.length) await env.DB.batch(statements);
    navAffected += chunk.length;
  }

  for (let i = 0; i < settings.length; i += 50) {
    const statements = settings.slice(i, i + 50).map((item) => {
      const key = clean(item?.key, 100);
      if (!key || !ALLOWED_SETTINGS.includes(key)) throw new RequestError(`备份包含不允许的设置项：${key}`, 400);
      return env.DB.prepare(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(key, clean(item.value, 500));
    });
    if (statements.length) await env.DB.batch(statements);
  }

  for (let i = 0; i < stats.length; i += 50) {
    const statements = stats.slice(i, i + 50).map((item) => {
      const linkId = linkMap.get(Number(item.link_id));
      const day = clean(item.day, 10);
      const clicks = Math.max(0, Number(item.clicks) || 0);
      if (!linkId || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RequestError("备份中的点击统计无效", 400);
      return env.DB.prepare(`INSERT INTO link_daily_stats(link_id,day,clicks) VALUES(?,?,?) ON CONFLICT(link_id,day) DO UPDATE SET clicks=excluded.clicks`).bind(linkId,day,clicks);
    });
    if (statements.length) await env.DB.batch(statements);
    statsAffected += statements.length;
  }

  // link_daily_stats triggers maintain live totals during normal traffic. Restore files
  // carry an authoritative links.clicks value, so re-apply it after restoring stats.
  for (let i = 0; i < links.length; i += 50) {
    const chunk = links.slice(i, i + 50);
    const statements = [];
    for (const item of chunk) {
      const mappedId = linkMap.get(Number(item.id));
      if (!mappedId) continue;
      statements.push(env.DB.prepare("UPDATE links SET clicks=?,last_clicked_at=?,updated_at=? WHERE id=?")
        .bind(Math.max(0, Number(item.clicks) || 0), clean(item.last_clicked_at, 80) || null, clean(item.updated_at, 80) || now(), mappedId));
    }
    if (statements.length) await env.DB.batch(statements);
  }

  return { links: linksAffected, navigation: navAffected, settings: settings.length, stats: statsAffected };
}


function isPrivateIconHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host.includes(":")) return true;
  const parts = host.split(".");
  if (parts.length === 4 && parts.every((part) => /^\d+$/.test(part))) {
    const n = parts.map(Number);
    const [a,b] = n;
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return false;
}

function normalizeFaviconSource(value) {
  const raw = clean(value, 2000);
  if (!validUrl(raw)) throw new RequestError("图标地址必须是 http/https", 400);
  const parsed = new URL(raw);
  if (isPrivateIconHost(parsed.hostname)) throw new RequestError("不允许访问内部网络地址", 400);

  // Convert legacy Google/DuckDuckGo favicon URLs to the actual site origin.
  if (parsed.hostname === "www.google.com" && parsed.pathname === "/s2/favicons") {
    const domain = parsed.searchParams.get("domain");
    if (domain && /^[a-z0-9.-]+$/i.test(domain)) return new URL("https://" + domain + "/").toString();
  }
  if (parsed.hostname === "icons.duckduckgo.com" && parsed.pathname.startsWith("/ip3/")) {
    const host = decodeURIComponent(parsed.pathname.slice(5)).replace(/\.ico$/i, "");
    if (host && /^[a-z0-9.-]+$/i.test(host)) return new URL("https://" + host + "/").toString();
  }
  return parsed.toString();
}

async function iconCacheKey(request, source) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  const url = new URL(request.url);
  url.pathname = "/__sln_favicon_cache/" + hex;
  url.search = "";
  return new Request(url.toString(), { method: "GET" });
}

function faviconFallbackSvg(source) {
  let hostname = "site";
  try { hostname = new URL(source).hostname.replace(/^www\./i, "") || hostname; } catch {}
  const letter = Array.from(hostname)[0]?.toUpperCase() || "S";
  const safe = String(letter).replace(/[<>&"']/g, "");
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#252938"/><text x="32" y="43" text-anchor="middle" font-family="Arial,sans-serif" font-size="34" font-weight="700" fill="#fff">' + safe + '</text></svg>';
}

async function fetchIconResponse(source) {
  const parsed = new URL(source);
  const candidates = [];
  const pathLooksLikeImage = /\.(?:ico|png|jpe?g|gif|webp|svg)(?:$|\?)/i.test(parsed.pathname);
  if (pathLooksLikeImage) candidates.push(source);
  else candidates.push(new URL("/favicon.ico", parsed.origin).toString());
  if (!pathLooksLikeImage) candidates.push(source);

  const tried = new Set();
  for (const candidate of candidates) {
    if (tried.has(candidate)) continue;
    tried.add(candidate);
    try {
      const response = await fetch(candidate, {
        redirect: "follow",
        headers: { "accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8", "user-agent": "ST-Nav-Favicon/1.0" },
      });
      const type = response.headers.get("content-type") || "";
      if (response.ok && (type.startsWith("image/") || type.includes("icon") || type === "application/octet-stream")) {
        return new Response(response.body, { status: 200, headers: { "content-type": type.includes("text/html") ? "image/x-icon" : type, "cache-control": "public, max-age=604800, s-maxage=604800, stale-while-revalidate=86400", "x-content-type-options": "nosniff" } });
      }

      if (!pathLooksLikeImage && response.ok && type.includes("text/html")) {
        const html = (await response.text()).slice(0, 262144);
        const match = html.match(/<link\b[^>]*\brel=["'][^"']*icon[^"']*["'][^>]*>/i) || html.match(/<link\b[^>]*\brel=[^"'][^"']*(?:shortcut|apple-touch-icon)[^"']*["'][^>]*>/i);
        const hrefMatch = match?.[0]?.match(/\bhref=["']([^"']+)["']/i);
        if (hrefMatch?.[1]) {
          const iconUrl = new URL(hrefMatch[1], source).toString();
          if (!tried.has(iconUrl)) {
            tried.add(iconUrl);
            const iconResponse = await fetch(iconUrl, { redirect: "follow", headers: { "accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8", "user-agent": "ST-Nav-Favicon/1.0" } });
            const iconType = iconResponse.headers.get("content-type") || "";
            if (iconResponse.ok && (iconType.startsWith("image/") || iconType.includes("icon") || iconType === "application/octet-stream")) {
              return new Response(iconResponse.body, { status: 200, headers: { "content-type": iconType, "cache-control": "public, max-age=604800, s-maxage=604800, stale-while-revalidate=86400", "x-content-type-options": "nosniff" } });
            }
          }
        }
      }
    } catch (error) {
      console.warn("Favicon fetch failed", candidate, error);
    }
  }

  return new Response(faviconFallbackSvg(source), { status: 200, headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400, s-maxage=86400", "x-content-type-options": "nosniff" } });
}

async function handleFavicon(request, ctx) {
  if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
  const url = new URL(request.url);
  const raw = url.searchParams.get("url") || "";
  if (!raw || raw.length > 2000) return new Response("Invalid icon URL", { status: 400 });
  const source = normalizeFaviconSource(raw);
  const key = await iconCacheKey(request, source);
  if (cacheAvailable()) {
    const cached = await caches.default.match(key);
    if (cached) return cached;
  }
  const response = await fetchIconResponse(source);
  if (cacheAvailable()) {
    waitUntil(ctx, caches.default.put(key, response.clone()));
  }
  return response;
}


function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

async function exportLinksCsv(env, request) {
  const url = new URL(request.url);
  const search = clean(url.searchParams.get("search"), 100).trim();
  const sort = new Set(["created_desc", "created_asc", "clicks_desc", "clicks_asc", "code_asc", "code_desc", "favorite_desc"]).has(url.searchParams.get("sort"))
    ? url.searchParams.get("sort")
    : "created_desc";
  const where = search
    ? `WHERE (links.code LIKE '%' || ? || '%' COLLATE NOCASE
        OR links.url LIKE '%' || ? || '%' COLLATE NOCASE
        OR COALESCE(links.title,'') LIKE '%' || ? || '%' COLLATE NOCASE
        OR COALESCE(links.category,'') LIKE '%' || ? || '%' COLLATE NOCASE)`
    : "";
  const order = {
    created_desc: "links.created_at DESC, links.id DESC",
    created_asc: "links.created_at ASC, links.id ASC",
    clicks_desc: "links.clicks DESC, links.id DESC",
    clicks_asc: "links.clicks ASC, links.id ASC",
    code_asc: "links.code COLLATE NOCASE ASC, links.id ASC",
    code_desc: "links.code COLLATE NOCASE DESC, links.id DESC",
    favorite_desc: "links.favorite DESC, links.id DESC",
  }[sort];
  const binds = search ? [search, search, search, search] : [];
  const origin = url.origin;
  const lines = [
    ["id", "code", "url", "title", "description", "category", "enabled", "favorite", "clicks", "last_clicked_at", "created_at", "updated_at", "navigation_id", "short_url"].join(",")
  ];
  const pageSize = 500;
  let offset = 0;
  while (true) {
    const result = await env.DB.prepare(`SELECT
        links.id, links.code, links.url, links.title, links.description, links.category,
        links.enabled, links.favorite, links.clicks, links.last_clicked_at,
        links.created_at, links.updated_at, navigation.id AS navigation_id
      FROM links
      LEFT JOIN navigation ON navigation.link_id=links.id
      ${where}
      ORDER BY ${order}
      LIMIT ? OFFSET ?`).bind(...binds, pageSize, offset).all();
    const rows = result.results || [];
    for (const item of rows) {
      lines.push([
        item.id, item.code, item.url, item.title, item.description, item.category,
        item.enabled, item.favorite, item.clicks, item.last_clicked_at,
        item.created_at, item.updated_at, item.navigation_id,
        item.code ? `${origin}/${item.code}` : ""
      ].map(csvCell).join(","));
    }
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  const body = "\ufeff" + lines.join("\r\n");
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="slink-nav-links.csv"`,
      "content-range": `items 0-${Math.max(0, lines.length - 2)}/${Math.max(0, lines.length - 1)}`,
      "cache-control": "no-store",
    },
  });
}

async function handleApi(request, env, ctx, parts) {
  const method = request.method.toUpperCase();
  const path = "/" + parts.join("/");

  if (path === "/api/favicon" && method === "GET") return handleFavicon(request, ctx);

  const noDatabase = new Set(["/api/auth/login", "/api/auth/logout", "/api/auth/me", "/api/health", "/api/favicon"]);
  if (!noDatabase.has(path)) await ensureDatabase(env);

  if (path === "/api/auth/login" && method === "POST") {
    if (!sameOrigin(request)) return json({ error: "非法来源" }, 403);
    if (!env.ADMIN_PASSWORD) {
      return json({ error: "服务器尚未配置管理员密码" }, 500);
    }
    if (env.SESSION_SECRET && String(env.SESSION_SECRET).length < 32) {
      return json({ error: "SESSION_SECRET 至少需要 32 个字符" }, 500);
    }
    const rate = checkLoginRateLimit(request);
    if (!rate.ok) return json({ error: "登录尝试过于频繁，请稍后再试" }, 429, { "retry-after": String(rate.retryAfter) });
    const data = await body(request);
    if (!(await safePasswordMatch(data.password ?? "", env.ADMIN_PASSWORD))) {
      recordLoginFailure(request);
      return json({ error: "密码错误" }, 401);
    }
    clearLoginFailures(request);
    const token = await sessionToken(sessionSecret(env));
    return json({ ok: true }, 200, { "Set-Cookie": cookie(SESSION_COOKIE, token) });
  }

  if (path === "/api/auth/logout" && method === "POST") {
    if (!sameOrigin(request)) return json({ error: "非法来源" }, 403);
    return json(
      { ok: true },
      200,
      { "Set-Cookie": cookie(SESSION_COOKIE, "", 0) }
    );
  }

  if (path === "/api/auth/me" && method === "GET") {
    return json({ authenticated: await isAuthed(request, env) });
  }

  if (path === "/api/health" && method === "GET") {
    await ensureDatabase(env);
    return json({ ok: true, version: VERSION, database: true, session_secret: Boolean(env.SESSION_SECRET) });
  }

  if (path === "/api/public/bootstrap" && method === "GET") {
    return cachedPublicBootstrap(request, env, ctx);
  }

  const auth = await requireAuth(request, env);
  if (auth) return auth;

  if (path === "/api/admin/bootstrap" && method === "GET") {
    const url = new URL(request.url);
    const clampPageSize = (value, fallback) => {
      const n = Number(value);
      return [5, 8, 10, 12, 20, 32, 50].includes(n) ? n : fallback;
    };
    const parsePage = (value) => Math.max(1, Math.min(100000, Number.isInteger(Number(value)) ? Number(value) : 1));
    const linksPageSize = clampPageSize(url.searchParams.get("links_page_size"), 10);
    const navPageSize = clampPageSize(url.searchParams.get("nav_page_size"), 12);
    const linksSearch = clean(url.searchParams.get("links_search"), 100).trim();
    const navSearch = clean(url.searchParams.get("nav_search"), 100).trim();
    const navCategory = clean(url.searchParams.get("nav_category"), 80).trim();
    const linksSort = new Set(["created_desc", "created_asc", "clicks_desc", "clicks_asc", "code_asc", "code_desc", "favorite_desc"]).has(url.searchParams.get("links_sort"))
      ? url.searchParams.get("links_sort")
      : "created_desc";
    const requestedLinksPage = parsePage(url.searchParams.get("links_page"));
    const requestedNavPage = parsePage(url.searchParams.get("nav_page"));

    const linksWhere = linksSearch
      ? `WHERE (code LIKE '%' || ? || '%' COLLATE NOCASE
          OR url LIKE '%' || ? || '%' COLLATE NOCASE
          OR COALESCE(title,'') LIKE '%' || ? || '%' COLLATE NOCASE
          OR COALESCE(category,'') LIKE '%' || ? || '%' COLLATE NOCASE)`
      : "";
    const navWhere = `WHERE (navigation.link_id IS NULL OR links.id IS NOT NULL)
      AND (? = '' OR (
        COALESCE(links.title, navigation.title, '') LIKE '%' || ? || '%' COLLATE NOCASE
        OR COALESCE(links.url, navigation.url, '') LIKE '%' || ? || '%' COLLATE NOCASE
        OR COALESCE(links.description, navigation.description, '') LIKE '%' || ? || '%' COLLATE NOCASE
        OR COALESCE(links.category, navigation.category, '') LIKE '%' || ? || '%' COLLATE NOCASE
      ))
      AND (? = '' OR COALESCE(links.category, navigation.category, '') = ?)`;
    const linkOrder = {
      created_desc: "created_at DESC, id DESC",
      created_asc: "created_at ASC, id ASC",
      clicks_desc: "clicks DESC, id DESC",
      clicks_asc: "clicks ASC, id ASC",
      code_asc: "code COLLATE NOCASE ASC, id ASC",
      code_desc: "code COLLATE NOCASE DESC, id DESC",
      favorite_desc: "favorite DESC, id DESC",
    }[linksSort];
    const linkSearchBinds = linksSearch ? [linksSearch, linksSearch, linksSearch, linksSearch] : [];
    const navSearchBinds = [navSearch, navSearch, navSearch, navSearch, navSearch, navCategory, navCategory];

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const startDay = new Date(today);
    startDay.setUTCDate(today.getUTCDate() - 13);
    const start = startDay.toISOString().slice(0, 10);

    const counts = await env.DB.batch([
      env.DB.prepare(`SELECT
        (SELECT COUNT(*) FROM links) links,
        (SELECT COALESCE(SUM(clicks),0) FROM links) clicks,
        (SELECT COUNT(*) FROM navigation) navigation,
        (SELECT COALESCE(SUM(clicks),0) FROM link_daily_stats WHERE day>=?) recentClicks`).bind(start),
      env.DB.prepare("SELECT id,code,url,title,clicks FROM links ORDER BY clicks DESC,id DESC LIMIT 8"),
      env.DB.prepare(`SELECT day, COALESCE(SUM(clicks),0) clicks
       FROM link_daily_stats
       WHERE day>=?
       GROUP BY day
       ORDER BY day`).bind(start),
      env.DB.prepare(`SELECT COUNT(*) AS total FROM links ${linksWhere}`).bind(...linkSearchBinds),
      env.DB.prepare(`SELECT COUNT(*) AS total FROM navigation LEFT JOIN links ON navigation.link_id=links.id ${navWhere}`).bind(...navSearchBinds),
    ]);

    const linkTotal = Number(counts[3].results[0]?.total || 0);
    const navTotal = Number(counts[4].results[0]?.total || 0);
    const linkPages = Math.max(1, Math.ceil(linkTotal / linksPageSize));
    const navPages = Math.max(1, Math.ceil(navTotal / navPageSize));
    const linkPage = Math.min(requestedLinksPage, linkPages);
    const navPage = Math.min(requestedNavPage, navPages);

    const results = await env.DB.batch([
      env.DB.prepare(`SELECT links.id,links.code,links.url,links.title,links.description,links.category,links.enabled,links.clicks,links.last_clicked_at,links.created_at,links.updated_at,links.favorite,
                             navigation.id AS navigation_id
                      FROM links
                      LEFT JOIN navigation ON navigation.link_id=links.id
                      ${linksWhere.replaceAll("code", "links.code").replaceAll("url", "links.url").replaceAll("title", "links.title").replaceAll("category", "links.category")}
                      ORDER BY ${linkOrder.replaceAll("created_at", "links.created_at").replaceAll("clicks", "links.clicks").replaceAll("id", "links.id").replaceAll("code", "links.code").replaceAll("favorite", "links.favorite")}
                      LIMIT ? OFFSET ?`).bind(...linkSearchBinds, linksPageSize, (linkPage - 1) * linksPageSize),
      env.DB.prepare(`SELECT
        navigation.id,
        CASE WHEN navigation.link_id IS NOT NULL THEN COALESCE(links.title, links.code) ELSE navigation.title END AS title,
        CASE WHEN navigation.link_id IS NOT NULL THEN links.description ELSE navigation.description END AS description,
        CASE WHEN navigation.link_id IS NOT NULL THEN NULL ELSE navigation.url END AS url,
        navigation.icon,
        CASE WHEN navigation.link_id IS NOT NULL THEN links.category ELSE navigation.category END AS category,
        navigation.sort_order,
        navigation.enabled,
        CASE WHEN navigation.link_id IS NOT NULL THEN links.favorite ELSE navigation.favorite END AS favorite,
        navigation.created_at,
        navigation.updated_at,
        navigation.link_id,
        links.code,
        links.url AS link_url,
        links.title AS link_title,
        links.description AS link_description,
        links.category AS link_category,
        links.enabled AS link_enabled
       FROM navigation
       LEFT JOIN links ON navigation.link_id = links.id
       ${navWhere}
       ORDER BY navigation.sort_order,navigation.id
       LIMIT ? OFFSET ?`).bind(...navSearchBinds, navPageSize, (navPage - 1) * navPageSize),
      env.DB.prepare(`SELECT DISTINCT COALESCE(links.category, navigation.category) AS category
                      FROM navigation
                      LEFT JOIN links ON navigation.link_id=links.id
                      WHERE navigation.link_id IS NULL OR links.id IS NOT NULL`),
      env.DB.prepare("SELECT id FROM navigation ORDER BY sort_order,id"),
      env.DB.prepare("SELECT key,value FROM settings"),
    ]);

    const origin = new URL(request.url).origin;
    const links = results[0].results.map((item) => ({
      ...item,
      short_url: item.code ? `${origin}/${item.code}` : "",
    }));
    const nav = results[1].results.map((item) => {
      const targetUrl = item.code ? item.link_url : item.url;
      const iconSource = item.icon && !/^https?:\/\/(?:www\.google\.com\/s2\/favicons|icons\.duckduckgo\.com\/ip3\/)/i.test(item.icon) ? item.icon : targetUrl;
      return {
        ...item,
        target_url: targetUrl,
        icon: iconSource ? new URL("/api/favicon?url=" + encodeURIComponent(iconSource), request.url).toString() : "",
        short_url: item.code ? `${origin}/${item.code}` : "",
        url: item.code ? `${origin}/${item.code}` : item.url,
        favorite: item.favorite === null ? 0 : item.favorite,
      };
    });
    const trendMap = new Map(counts[2].results.map((row) => [row.day, Number(row.clicks) || 0]));
    const trend = [];
    for (let offset = 13; offset >= 0; offset--) {
      const day = new Date(today);
      day.setUTCDate(today.getUTCDate() - offset);
      const key = day.toISOString().slice(0, 10);
      trend.push({ day: key, clicks: trendMap.get(key) || 0 });
    }

    return json({
      dashboard: { stats: counts[0].results[0], topLinks: counts[1].results, trend },
      links,
      links_pagination: { page: linkPage, page_size: linksPageSize, total: linkTotal, pages: linkPages },
      navigation: nav,
      navigation_pagination: { page: navPage, page_size: navPageSize, total: navTotal, pages: navPages },
      navigation_categories: results[2].results.map((row) => row.category).filter(Boolean).sort((a, b) => String(a).localeCompare(String(b), "zh-CN")),
      navigation_order: results[3].results.map((row) => Number(row.id)),
      settings: Object.fromEntries(results[4].results.map((x) => [x.key, x.value])),
    });
  }

  
  if (path === "/api/admin/links/export" && method === "GET") {
    return exportLinksCsv(env, request);
  }

  if (path === "/api/admin/backup" && method === "GET") {
    const backup = await makeBackup(env);
    return json(backup, 200, { "cache-control": "no-store" });
  }

  if (path === "/api/admin/restore" && method === "POST") {
    const data = await bodyWithLimit(request, MAX_RESTORE_BODY_BYTES);
    const result = await restoreBackup(env, data.backup, data.mode);
    invalidatePublicCache(request, ctx);
    return json({ ok: true, ...result });
  }

  if (path === "/api/admin/links/import" && method === "POST") {
    const data = await body(request);
    const rows = Array.isArray(data.rows) ? data.rows : [];
    const mode = ["skip", "update", "rename"].includes(data.mode) ? data.mode : "skip";
    if (!rows.length) return json({ imported: 0, skipped: 0, failed: 0 });
    if (rows.length > 100) return json({ error: "单次 CSV 导入最多 100 条，请分批提交" }, 413);
    let imported = 0, skipped = 0, failed = 0;
    for (const item of rows) {
      try {
        let code = clean(item.code, 64);
        const url = clean(item.url, 2000);
        if (!validUrl(url)) throw new RequestError("URL 必须是 http/https", 400);
        if (code && (!CODE_RE.test(code) || RESERVED_CODES.has(code.toLowerCase()))) throw new RequestError("短码格式无效或为保留字", 400);
        const title = clean(item.title, 200);
        const description = clean(item.description, 500);
        const category = clean(item.category, 80);
        const enabled = boolValue(item.enabled, true);
        const favorite = boolValue(item.favorite, false);
        let existing = code ? await env.DB.prepare("SELECT id FROM links WHERE code=?").bind(code).first() : null;
        if (existing) {
          if (mode === "skip") { skipped++; continue; }
          if (mode === "update") {
            await env.DB.prepare(`UPDATE links SET url=?,title=?,description=?,category=?,enabled=?,favorite=?,updated_at=? WHERE id=?`).bind(url,title,description,category,enabled,favorite,now(),Number(existing.id)).run();
            await env.DB.prepare(`UPDATE navigation SET icon=?,enabled=?,updated_at=? WHERE link_id=?`).bind(faviconUrl(url),enabled,now(),Number(existing.id)).run();
            imported++; continue;
          }
          if (mode === "rename") code = "";
        }
        if (!code) {
          let created = false;
          for (let attempt = 0; attempt < 5 && !created; attempt++) {
            const candidate = randomCode();
            try {
              await env.DB.prepare(`INSERT INTO links(code,url,title,description,category,enabled,favorite,updated_at) VALUES(?,?,?,?,?,?,?,?)`).bind(candidate,url,title,description,category,enabled,favorite,now()).run();
              created = true;
            } catch (error) {
              if (!String(error?.message || "").toLowerCase().includes("unique")) throw error;
            }
          }
          if (!created) throw new RequestError("无法生成唯一短码", 503);
        } else {
          await env.DB.prepare(`INSERT INTO links(code,url,title,description,category,enabled,favorite,updated_at) VALUES(?,?,?,?,?,?,?,?)`).bind(code,url,title,description,category,enabled,favorite,now()).run();
        }
        imported++;
      } catch (error) {
        failed++;
        if (error instanceof RequestError && error.status >= 500) throw error;
      }
    }
    invalidatePublicCache(request, ctx);
    return json({ ok: true, imported, skipped, failed });
  }

  if (path === "/api/admin/links/bulk" && method === "POST") {
    const data = await body(request);
    const allowedActions = new Set(["add_navigation", "remove_navigation", "enable", "disable", "delete"]);
    const action = String(data.action || "");
    if (!allowedActions.has(action)) {
      return json({ error: "批量操作类型无效" }, 400);
    }

    if (!Array.isArray(data.ids) || !data.ids.length) {
      return json({ error: "请至少选择一个短链接" }, 400);
    }

    const ids = [...new Set(data.ids.map(Number))];
    if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
      return json({ error: "短链接 ID 无效" }, 400);
    }
    if (ids.length > 2000) {
      return json({ error: "单次最多处理 2000 个短链接，请分批操作" }, 400);
    }

    const placeholders = (count) => Array.from({ length: count }, () => "?").join(",");
    const chunks = (list, size) => {
      const result = [];
      for (let i = 0; i < list.length; i += size) result.push(list.slice(i, i + size));
      return result;
    };

    if (action === "remove_navigation") {
      let affected = 0;
      for (const chunk of chunks(ids, 90)) {
        const marks = placeholders(chunk.length);
        const result = await env.DB.prepare(
          `DELETE FROM navigation WHERE link_id IN (${marks})`
        ).bind(...chunk).run();
        affected += Number(result.meta?.changes || 0);
      }
      invalidatePublicCache(request, ctx);
      return json({ ok: true, affected, failed: Math.max(0, ids.length - affected) });
    }

    if (action === "add_navigation") {
      // One INSERT...SELECT keeps the operation efficient for large selections and
      // the UNIQUE(link_id) index makes repeated "add to navigation" idempotent.
      let affected = 0;
      for (const chunk of chunks(ids, 90)) {
        const marks = placeholders(chunk.length);
        // Fetch selected links once, then insert them in bounded D1 batches.
        const selected = await env.DB.prepare(
          `SELECT id,code,title,description,url,category,enabled,favorite
           FROM links WHERE id IN (${marks})`
        ).bind(...chunk).all();

        if (!selected.results.length) continue;
        const existing = await env.DB.prepare(
          `SELECT link_id FROM navigation WHERE link_id IN (${marks})`
        ).bind(...chunk).all();
        const existingIds = new Set(existing.results.map((row) => Number(row.link_id)));
        const pending = selected.results.filter((row) => !existingIds.has(Number(row.id)));
        if (!pending.length) continue;

        for (const pendingBatch of chunks(pending, 90)) {
          const maxResult = await env.DB.prepare(
            "SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM navigation"
          ).first();
          const baseOrder = Number(maxResult?.max_order ?? -1);
          const statements = pendingBatch.map((link, index) =>
            env.DB.prepare(
              `INSERT INTO navigation
               (link_id,icon,sort_order,enabled,updated_at)
               VALUES(?,?,?,?,?)`
            ).bind(
              Number(link.id),
              faviconUrl(link.url),
              baseOrder + index + 1,
              Number(link.enabled) ? 1 : 0,
              now()
            )
          );
          const results = await env.DB.batch(statements);
          affected += results.filter((result) => Number(result.meta?.changes || 0) > 0).length;
        }
      }
      invalidatePublicCache(request, ctx);
      return json({ ok: true, affected, failed: ids.length - affected });
    }

    let affected = 0;
    const deletedCodes = [];
    for (const chunk of chunks(ids, 90)) {
      const marks = placeholders(chunk.length);
      const timestamp = now();

      if (action === "delete") {
        const rows = await env.DB.prepare(
          `SELECT code FROM links WHERE id IN (${marks})`
        ).bind(...chunk).all();
        deletedCodes.push(...rows.results.map((row) => row.code));
        const result = await env.DB.prepare(
          `DELETE FROM links WHERE id IN (${marks})`
        ).bind(...chunk).run();
        affected += Number(result.meta?.changes || 0);
        continue;
      }

      const enabled = action === "enable" ? 1 : 0;
      const results = await env.DB.batch([
        env.DB.prepare(
          `UPDATE links SET enabled=?,updated_at=? WHERE id IN (${marks})`
        ).bind(enabled, timestamp, ...chunk),
        env.DB.prepare(
          `UPDATE navigation SET enabled=?,updated_at=? WHERE link_id IN (${marks})`
        ).bind(enabled, timestamp, ...chunk),
      ]);
      affected += Number(results[0]?.meta?.changes || 0);
    }

    invalidatePublicCache(request, ctx);
    if (action === "delete") {
      for (const code of deletedCodes) invalidateRedirectCache(request, ctx, code);
    }
    return json({ ok: true, affected, failed: ids.length - affected });
  }

  if (path === "/api/admin/links/ids" && method === "GET") {
    const url = new URL(request.url);
    const search = clean(url.searchParams.get("search"), 100).trim();
    const sort = new Set(["created_desc", "created_asc", "clicks_desc", "clicks_asc", "code_asc", "code_desc", "favorite_desc"]).has(url.searchParams.get("sort"))
      ? url.searchParams.get("sort")
      : "created_desc";
    const where = search
      ? `WHERE (code LIKE '%' || ? || '%' COLLATE NOCASE
          OR url LIKE '%' || ? || '%' COLLATE NOCASE
          OR COALESCE(title,'') LIKE '%' || ? || '%' COLLATE NOCASE
          OR COALESCE(category,'') LIKE '%' || ? || '%' COLLATE NOCASE)`
      : "";
    const order = {
      created_desc: "created_at DESC, id DESC",
      created_asc: "created_at ASC, id ASC",
      clicks_desc: "clicks DESC, id DESC",
      clicks_asc: "clicks ASC, id ASC",
      code_asc: "code COLLATE NOCASE ASC, id ASC",
      code_desc: "code COLLATE NOCASE DESC, id DESC",
      favorite_desc: "favorite DESC, id DESC",
    }[sort];
    const binds = search ? [search, search, search, search] : [];
    const result = await env.DB.prepare(`SELECT id FROM links ${where} ORDER BY ${order} LIMIT 2000`).bind(...binds).all();
    const count = result.results.length;
    if (count >= 2000) return json({ error: "当前筛选结果超过 2000 项，请缩小筛选范围后再选择全部" }, 413);
    return json({ ids: result.results.map((row) => Number(row.id)), total: count });
  }

  if (path === "/api/admin/links/check-code" && method === "GET") {
    const url = new URL(request.url);
    const code = clean(url.searchParams.get("code"), 64);
    const excludeIdRaw = url.searchParams.get("exclude_id");
    const excludeId = excludeIdRaw && /^\d+$/.test(excludeIdRaw) ? Number(excludeIdRaw) : null;

    if (!code) return json({ available: true, message: "留空将自动生成" });
    if (!CODE_RE.test(code)) {
      return json({ available: false, reason: "invalid", message: "格式：2-64 位字母、数字、_、-" });
    }
    if (RESERVED_CODES.has(code.toLowerCase())) {
      return json({ available: false, reason: "reserved", message: "该短码为系统保留字" });
    }

    const existing = await env.DB.prepare("SELECT id FROM links WHERE code=? LIMIT 1").bind(code).first();
    const available = !existing || (excludeId !== null && Number(existing.id) === excludeId);
    return json({ available, reason: available ? "available" : "exists", message: available ? "短码可用" : "短码已存在" });
  }

if (path === "/api/admin/links" && method === "POST") {
    const data = await body(request);
    const url = clean(data.url, 2000);
    if (!validUrl(url)) return json({ error: "URL 必须是 http/https" }, 400);

    let code = clean(data.code, 64);
    const autoCode = !code;
    if (!autoCode && !CODE_RE.test(code)) {
      return json({ error: "短码格式不合法：仅允许 2-64 位字母、数字、_、-" }, 400);
    }
    if (!autoCode && RESERVED_CODES.has(code.toLowerCase())) {
      return json({ error: `短码 ${code} 为系统保留字，请换一个` }, 400);
    }

    const insert = () => env.DB.prepare(
      `INSERT INTO links(code,url,title,description,category,enabled,favorite,updated_at)
       VALUES(?,?,?,?,?,?,?,?)`
    ).bind(
      code,
      url,
      clean(data.title, 200),
      clean(data.description, 500),
      clean(data.category, 80),
      data.enabled === false ? 0 : 1,
      boolValue(data.favorite, false),
      now()
    ).run();

    for (let attempt = 0; attempt < (autoCode ? 5 : 1); attempt++) {
      if (autoCode) code = randomCode();
      try {
        await insert();
        invalidatePublicCache(request, ctx);
        invalidateRedirectCache(request, ctx, code);
        return json({ ok: true, code });
      } catch (error) {
        if (String(error?.message || "").toLowerCase().includes("unique")) {
          if (autoCode) continue;
          return json({ error: "短码已存在" }, 409);
        }
        throw error;
      }
    }
    return json({ error: "无法生成唯一短码，请稍后重试" }, 503);
  }

  const favoriteMatch = path.match(/^\/api\/admin\/links\/(\d+)\/favorite$/);
  if (favoriteMatch && method === "PATCH") {
    const id = Number(favoriteMatch[1]);
    const data = await body(request);
    const favorite = boolValue(data.favorite, false);
    const timestamp = now();
    const result = await env.DB.prepare("UPDATE links SET favorite=?,updated_at=? WHERE id=?").bind(favorite, timestamp, id).run();
    if (!result.meta?.changes) return json({ error: "短链接不存在" }, 404);
    return json({ ok: true, favorite });
  }

  const linkStatusMatch = path.match(/^\/api\/admin\/links\/(\d+)\/status$/);
  if (linkStatusMatch && method === "PATCH") {
    const id = Number(linkStatusMatch[1]);
    const data = await body(request);
    const enabled = boolValue(data.enabled, false) ? 1 : 0;
    const timestamp = now();
    const results = await env.DB.batch([
      env.DB.prepare("UPDATE links SET enabled=?,updated_at=? WHERE id=?").bind(enabled, timestamp, id),
      env.DB.prepare("UPDATE navigation SET enabled=?,updated_at=? WHERE link_id=?").bind(enabled, timestamp, id),
    ]);
    if (!results[0]?.meta?.changes) return json({ error: "短链接不存在" }, 404);
    invalidatePublicCache(request, ctx);
    return json({ ok: true, enabled });
  }

  const linkMatch = path.match(/^\/api\/admin\/links\/(\d+)$/);
  if (linkMatch) {
    const id = Number(linkMatch[1]);

    if (method === "PUT") {
      const data = await body(request);
      const code = clean(data.code, 64);
      const url = clean(data.url, 2000);

      if (!CODE_RE.test(code)) {
        return json({ error: "短码格式不合法：仅允许 2-64 位字母、数字、_、-" }, 400);
      }
      if (RESERVED_CODES.has(code.toLowerCase())) {
        return json({ error: `短码 ${code} 为系统保留字，请换一个` }, 400);
      }
      if (!validUrl(url)) return json({ error: "URL 必须是 http/https" }, 400);

      const previous = await env.DB.prepare("SELECT code FROM links WHERE id=?").bind(id).first();
      if (!previous) return json({ error: "短链接不存在" }, 404);

      try {
        const timestamp = now();
        const results = await env.DB.batch([
          env.DB.prepare(
            `UPDATE links SET code=?,url=?,title=?,description=?,category=?,enabled=?,updated_at=?
             WHERE id=?`
          ).bind(
            code,
            url,
            clean(data.title, 200),
            clean(data.description, 500),
            clean(data.category, 80),
            data.enabled === false ? 0 : 1,
            timestamp,
            id
          ),
          env.DB.prepare(
            `UPDATE navigation
             SET icon=?,enabled=?,updated_at=?
             WHERE link_id=?`
          ).bind(
            faviconUrl(url),
            data.enabled === false ? 0 : 1,
            timestamp,
            id
          ),
        ]);

        if (!results[0].meta?.changes) return json({ error: "短链接不存在" }, 404);
      } catch (error) {
        if (String(error?.message || "").toLowerCase().includes("unique")) {
          return json({ error: "短码已存在" }, 409);
        }
        throw error;
      }
      invalidatePublicCache(request, ctx);
      invalidateRedirectCache(request, ctx, previous.code);
      invalidateRedirectCache(request, ctx, code);
      return json({ ok: true });
    }

    if (method === "DELETE") {
      const previous = await env.DB.prepare("SELECT code FROM links WHERE id=?").bind(id).first();
      const result = await env.DB.prepare("DELETE FROM links WHERE id=?")
        .bind(id)
        .run();
      if (!result.meta?.changes) return json({ error: "短链接不存在" }, 404);
      invalidatePublicCache(request, ctx);
      invalidateRedirectCache(request, ctx, previous?.code);
      return json({ ok: true });
    }
  }

  if (path === "/api/admin/navigation" && method === "POST") {
    const data = await body(request);

    if (data.link_id !== undefined && data.link_id !== null && data.link_id !== "") {
      const linkId = Number(data.link_id);

      if (!Number.isInteger(linkId) || linkId <= 0) {
        return json({ error: "短链接 ID 无效" }, 400);
      }

      const [linkResult, existsResult, maxResult] = await env.DB.batch([
        env.DB.prepare("SELECT id,code,url,title,description,category,enabled,favorite FROM links WHERE id=?").bind(linkId),
        env.DB.prepare("SELECT id FROM navigation WHERE link_id=? LIMIT 1").bind(linkId),
        env.DB.prepare("SELECT COALESCE(MAX(sort_order),-1) m FROM navigation"),
      ]);
      const link = linkResult.results[0] || null;

      if (!link) {
        return json({ error: "短链接不存在" }, 404);
      }

      if (existsResult.results.length) {
        return json({ error: "这个短链接已经在导航里了" }, 409);
      }

      const icon = faviconUrl(link.url);

      await env.DB.prepare(
        `INSERT INTO navigation(link_id,icon,sort_order,enabled,updated_at)
         VALUES(?,?,?,?,?)`
      )
        .bind(
          linkId,
          icon,
          Number(maxResult.results[0]?.m ?? -1) + 1,
          data.enabled === false || link.enabled === 0 ? 0 : 1,
          now()
        )
        .run();

      invalidatePublicCache(request, ctx);
      return json({ ok: true });
    }

    const title = clean(data.title, 120);
    const url = clean(data.url, 2000);

    if (!title || !validUrl(url)) {
      return json({ error: "标题和有效 URL 必填" }, 400);
    }

    await env.DB.prepare(
      `INSERT INTO navigation
       (title,description,url,icon,category,sort_order,enabled,favorite,updated_at)
       SELECT ?,?,?,?,?,COALESCE(MAX(sort_order),-1)+1,?,?,?
       FROM navigation`
    )
      .bind(
        title,
        clean(data.description, 500),
        url,
        clean(data.icon, 1000),
        clean(data.category, 80),
        data.enabled === false ? 0 : 1,
        boolValue(data.favorite, false),
        now()
      )
      .run();

    invalidatePublicCache(request, ctx);
    return json({ ok: true });
  }

  if (path === "/api/admin/navigation/ids" && method === "GET") {
    const url = new URL(request.url);
    const search = clean(url.searchParams.get("search"), 100).trim();
    const category = clean(url.searchParams.get("category"), 80).trim();
    const navWhere = `WHERE (navigation.link_id IS NULL OR links.id IS NOT NULL)
      AND (? = '' OR (
        COALESCE(links.title, navigation.title, '') LIKE '%' || ? || '%' COLLATE NOCASE
        OR COALESCE(links.url, navigation.url, '') LIKE '%' || ? || '%' COLLATE NOCASE
        OR COALESCE(links.description, navigation.description, '') LIKE '%' || ? || '%' COLLATE NOCASE
        OR COALESCE(links.category, navigation.category, '') LIKE '%' || ? || '%' COLLATE NOCASE
      ))
      AND (? = '' OR COALESCE(links.category, navigation.category, '') = ?)`;
    const binds = [search, search, search, search, search, category, category];
    const result = await env.DB.prepare(
      `SELECT navigation.id
       FROM navigation
       LEFT JOIN links ON navigation.link_id=links.id
       ${navWhere}
       ORDER BY navigation.sort_order,navigation.id
       LIMIT 2001`
    ).bind(...binds).all();
    if (result.results.length > 2000) {
      return json({ error: "当前筛选结果超过 2000 项，请缩小筛选范围后再选择全部" }, 413);
    }
    return json({ ids: result.results.map((row) => Number(row.id)), total: result.results.length });
  }

  if (path === "/api/admin/navigation/bulk" && method === "POST") {
    const data = await body(request);
    const action = String(data.action || "");
    if (!["enable", "disable", "delete"].includes(action)) return json({ error: "批量操作类型无效" }, 400);
    if (!Array.isArray(data.ids) || !data.ids.length) return json({ error: "请至少选择一个导航项目" }, 400);
    const ids = [...new Set(data.ids.map(Number))];
    if (ids.some((id) => !Number.isInteger(id) || id <= 0)) return json({ error: "导航 ID 无效" }, 400);
    if (ids.length > 2000) return json({ error: "单次最多处理 2000 个导航项目，请分批操作" }, 400);

    // D1/SQLite limits the number of bound parameters in a prepared statement.
    // Keep each IN (...) statement at 90 IDs (plus the two update values),
    // then execute all chunks as one D1 batch so the operation remains atomic.
    const chunkSize = 90;
    const timestamp = now();
    const enabled = action === "enable" ? 1 : 0;
    const statements = [];

    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => "?").join(",");
      statements.push(
        action === "delete"
          ? env.DB.prepare(`DELETE FROM navigation WHERE id IN (${placeholders})`).bind(...chunk)
          : env.DB.prepare(`UPDATE navigation SET enabled=?,updated_at=? WHERE id IN (${placeholders})`).bind(enabled, timestamp, ...chunk)
      );
    }

    const results = await env.DB.batch(statements);
    const affected = results.reduce((sum, result) => sum + Number(result.meta?.changes || 0), 0);
    invalidatePublicCache(request, ctx);
    return json({ ok: true, affected, failed: Math.max(0, ids.length - affected) });
  }

  if (path === "/api/admin/navigation/reorder" && method === "POST") {
    const data = await body(request);
    if (!Array.isArray(data.ids) || data.ids.some((id) => !Number.isInteger(Number(id)))) {
      return json({ error: "排序数据无效" }, 400);
    }

    const ids = data.ids.map(Number);
    if (new Set(ids).size !== ids.length) return json({ error: "排序数据存在重复项目" }, 400);

    const existing = await env.DB.prepare("SELECT id FROM navigation").all();
    const existingIds = new Set(existing.results.map((row) => Number(row.id)));
    if (ids.length !== existingIds.size || ids.some((id) => !existingIds.has(id))) {
      return json({ error: "排序数据必须包含全部且仅包含现有导航项目" }, 400);
    }

    const statements = ids.map((id, index) =>
      env.DB.prepare("UPDATE navigation SET sort_order=?,updated_at=? WHERE id=?")
        .bind(index, now(), id)
    );
    if (statements.length) await env.DB.batch(statements);
    invalidatePublicCache(request, ctx);
    return json({ ok: true });
  }

  const navFavoriteMatch = path.match(/^\/api\/admin\/navigation\/(\d+)\/favorite$/);
  if (navFavoriteMatch && method === "PATCH") {
    const id = Number(navFavoriteMatch[1]);
    const data = await body(request);
    const favorite = boolValue(data.favorite, false);
    const current = await env.DB.prepare("SELECT id,link_id FROM navigation WHERE id=?").bind(id).first();
    if (!current) return json({ error: "导航不存在" }, 404);
    const timestamp = now();
    if (current.link_id) {
      await env.DB.prepare("UPDATE links SET favorite=?,updated_at=? WHERE id=?").bind(favorite, timestamp, Number(current.link_id)).run();
    } else {
      await env.DB.prepare("UPDATE navigation SET favorite=?,updated_at=? WHERE id=?").bind(favorite, timestamp, id).run();
    }
    return json({ ok: true, favorite });
  }

  const navStatusMatch = path.match(/^\/api\/admin\/navigation\/(\d+)\/status$/);
  if (navStatusMatch && method === "PATCH") {
    const id = Number(navStatusMatch[1]);
    const data = await body(request);
    const enabled = boolValue(data.enabled, false) ? 1 : 0;
    const current = await env.DB.prepare("SELECT id,link_id FROM navigation WHERE id=?").bind(id).first();
    if (!current) return json({ error: "导航不存在" }, 404);
    const timestamp = now();
    const statements = [
      env.DB.prepare("UPDATE navigation SET enabled=?,updated_at=? WHERE id=?").bind(enabled, timestamp, id),
    ];
    if (current.link_id) {
      statements.push(env.DB.prepare("UPDATE links SET enabled=?,updated_at=? WHERE id=?").bind(enabled, timestamp, Number(current.link_id)));
    }
    await env.DB.batch(statements);
    invalidatePublicCache(request, ctx);
    return json({ ok: true, enabled });
  }

  const navMatch = path.match(/^\/api\/admin\/navigation\/(\d+)$/);
  if (navMatch) {
    const id = Number(navMatch[1]);

    if (method === "PUT") {
      const data = await body(request);
      const current = await env.DB.prepare(
        "SELECT id,link_id FROM navigation WHERE id=?"
      ).bind(id).first();
      if (!current) return json({ error: "导航不存在" }, 404);

      if (current.link_id) {
        return json({ error: "此导航已关联短链接，请在「短链接」中编辑内容" }, 409);
      }

      const title = clean(data.title, 120);
      const url = clean(data.url, 2000);
      if (!title || !validUrl(url)) return json({ error: "标题和有效 URL 必填" }, 400);

      const result = await env.DB.prepare(
        `UPDATE navigation SET title=?,description=?,url=?,icon=?,category=?,enabled=?,updated_at=?
         WHERE id=?`
      )
        .bind(
          title,
          clean(data.description, 500),
          url,
          clean(data.icon, 1000),
          clean(data.category, 80),
          data.enabled === false ? 0 : 1,
          now(),
          id
        )
        .run();

      if (!result.meta?.changes) return json({ error: "导航不存在" }, 404);
      invalidatePublicCache(request, ctx);
      return json({ ok: true });
    }

    if (method === "DELETE") {
      const result = await env.DB.prepare("DELETE FROM navigation WHERE id=?")
        .bind(id)
        .run();
      if (!result.meta?.changes) return json({ error: "导航不存在" }, 404);
      invalidatePublicCache(request, ctx);
      return json({ ok: true });
    }
  }

  if (path === "/api/admin/settings" && method === "PUT") {
    const data = await body(request);
    const statements = ALLOWED_SETTINGS
      .filter((key) => key in data)
      .map((key) =>
        env.DB.prepare(
          `INSERT INTO settings(key,value) VALUES(?,?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value`
        ).bind(key, clean(data[key], 500))
      );

    if (statements.length) await env.DB.batch(statements);
    invalidatePublicCache(request, ctx);
    return json({ ok: true });
  }

  return json({ error: "Not found" }, 404);
}

async function handleRedirect(request, env, ctx, code) {
  await ensureDatabase(env);
  if (!CODE_RE.test(code)) return null;
  let link = null;

  if (cacheAvailable()) {
    try {
      const cached = await caches.default.match(redirectCacheKey(request, code));
      if (cached) link = await cached.json();
    } catch (error) {
      console.error("Redirect cache read failed", error);
    }
  }

  if (!link) {
    link = await env.DB.prepare(
      "SELECT id,code,url FROM links WHERE code=? AND enabled=1"
    ).bind(code).first();
    if (!link) return null;

    if (cacheAvailable()) {
      try {
        const response = json(link, 200, { "cache-control": PUBLIC_CACHE_CONTROL });
        const put = caches.default.put(redirectCacheKey(request, code), response);
        if (ctx?.waitUntil) ctx.waitUntil(put);
      } catch (error) {
        console.error("Redirect cache write failed", error);
      }
    }
  }

  const timestamp = now();
  const day = timestamp.slice(0, 10);
  // Keep the total and daily aggregate in one atomic D1 batch. This avoids runtime
  // triggers and keeps click accounting consistent across local/remote D1.
  waitUntil(ctx, env.DB.batch([
    env.DB.prepare("UPDATE links SET clicks=clicks+1,last_clicked_at=?,updated_at=? WHERE id=?")
      .bind(timestamp, timestamp, link.id),
    env.DB.prepare(`INSERT INTO link_daily_stats(link_id,day,clicks) VALUES(?,?,1)
      ON CONFLICT(link_id,day) DO UPDATE SET clicks=link_daily_stats.clicks+1`)
      .bind(link.id, day),
  ]).catch((error) => console.error("Click analytics write failed", error)));
  return Response.redirect(link.url, 302);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const parts = routeParts(url.pathname);

    try {
      if (parts[0] === "api") return await handleApi(request, env, ctx, parts);

      if (url.pathname === "/admin" || url.pathname === "/admin/") {
        const assetResponse = embeddedAsset("admin.html");
        const headers = new Headers(assetResponse.headers);
        Object.entries(SECURITY_HEADERS).forEach(([key, value]) => headers.set(key, value));
        headers.set("cache-control", "no-store");
        return new Response(assetResponse.body, { status: 200, headers });
      }

      if (parts.length === 1 && parts[0] && parts[0] !== "admin.html") {
        const redirect = await handleRedirect(request, env, ctx, parts[0]);
        if (redirect) return redirect;
      }

      const assetResponse = embeddedAsset(url.pathname);
      if (!assetResponse) return json({ error: "Not Found" }, 404);
      const headers = new Headers(assetResponse.headers);
      Object.entries(SECURITY_HEADERS).forEach(([key, value]) => headers.set(key, value));
      return new Response(assetResponse.body, { status: 200, headers });
    } catch (error) {
      if (error instanceof RequestError) {
        return json({ error: error.message }, error.status);
      }
      console.error("Unhandled request error", error);
      return json({ error: "服务器内部错误，请稍后重试" }, 500);
    }
  },
};
