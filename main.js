/* Plugin Stats —— 插件下载量看板
 * 数据源（全部只读、无需登录）：
 *   1. GitHub Releases API：每个仓库的总下载量 + 逐版本资产明细
 *   2. obsidianmd/obsidian-releases 的 community-plugin-stats.json：官方目录收录后
 *      的逐版本下载量（含未上架检测）
 * 本插件每次刷新把当日总量存入 data.json 快照，展示「较昨日/较首次」增量与趋势条。
 */
const { Plugin, ItemView, Notice, PluginSettingTab, Setting, requestUrl } = require("obsidian");

const VIEW_TYPE = "plugin-stats-view";
const OFFICIAL_STATS_URL = "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugin-stats.json";
const CP_LIST_URL = "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json";

// ---- 内置领域分类规则（顺序即优先级；settings.domainJson 可整体替换） ----
const DOMAIN_RULES = [
  ["AI 与自动化", ["ai", "gpt", "llm", "chatgpt", "copilot", "assistant", "automation", "templater", "quickadd", "macro", "chatbot"]],
  ["任务与项目", ["task", "todo", "project", "kanban", "gtd", "planner", "checklist", "habit", "tracker", "reminder", "issue"]],
  ["日历与日记", ["calendar", "daily", "journal", "diary", "periodic", "heatmap", "pomodoro", "schedule", "appointment"]],
  ["写作与小说", ["writing", "write", "writer", "novel", "fiction", "prose", "draft", "longform", "manuscript", "screenplay", "word count", "typewriter"]],
  ["知识管理与图谱", ["graph", "backlink", "zettel", "knowledge", "mindmap", "outline", "canvas", "whiteboard", "excalidraw", "spaced", "flashcard", "anki", "memory", "moc"]],
  ["查询与可视化", ["dataview", "query", "chart", "dashboard", "table", "plot", "diagram", "mermaid", "base", "database", "notion"]],
  ["开发与代码", ["code", "developer", "snippet", "syntax", "programming", "git", "github", "terminal", "shell", "script", "api", "debug", "python", "javascript", "sql"]],
  ["同步与导出", ["sync", "publish", "export", "pandoc", "pdf", "word", "docx", "hugo", "vitepress", "quartz", "static", "upload", "backup", "webdav", "s3"]],
  ["学习与语言", ["learn", "study", "vocabulary", "language", "dictionary", "translate", "review", "exam", "textbook"]],
  ["媒体与外观", ["image", "audio", "video", "music", "media", "gallery", "banner", "icon", "theme", "css", "font", "color", "appearance", "embed", "banner"]],
  ["效率与界面", ["hotkey", "shortcut", "sidebar", "status", "command", "menu", "pane", "layout", "focus", "wysiwyg", "swiper", "launcher", "starred", "bookmark", "recent"]],
  ["搜索与链接", ["search", "omnisearch", "find", "navigate", "jump", "link", "url", "web", "browser", "embed web"]],
];

const DEFAULT_SETTINGS = {
  owner: "121212165",
  repos: "obsidian-clipping-finder, obsidian-ai-flavor-checker, obsidian-scan-card-box, obsidian-daoyu-studio, obsidian-qs8-panel, obsidian-story-ledger, obsidian-jev-decision-log, obsidian-fanqie-drafter",
  pluginIds: "clipping-finder, ai-flavor-checker, scan-card-box, daoyu-studio, qs8-panel, story-ledger, jev-decision-log, fanqie-drafter",
  watchlist: "templater-obsidian, dataview, periodic-notes",
  autoSnapshot: true,
  goalsJson: "{}", // {"仓库名": 目标下载量}
  domainJson: "", // 领域分类规则 JSON [["领域名",["关键词",...]],...]，整体替换内置规则
};

function fmt(n) {
  if (n >= 10000) return (n / 10000).toFixed(1) + "w";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}
function svgChart(series, w, h) {
  // series 升序 [{d,total}]；总量折线（accent）+ 日增柱（faint）
  if (series.length < 2) return null;
  const deltas = series.map((x, i) => (i === 0 ? 0 : Math.max(0, x.total - series[i - 1].total)));
  const tMin = Math.min(...series.map((x) => x.total)), tMax = Math.max(...series.map((x) => x.total));
  const dMax = Math.max(...deltas, 1);
  const px = (i) => 4 + (i / (series.length - 1)) * (w - 8);
  const ty = (v) => h - 6 - ((v - tMin) / Math.max(1, tMax - tMin)) * (h - 20);
  const dy = (v) => h - 6 - (v / dMax) * (h - 20) * 0.5;
  const pts = series.map((x, i) => `${px(i)},${ty(x.total)}`).join(" ");
  const bw = Math.max(1.5, (w - 8) / series.length - 1);
  const bars = deltas.map((v, i) => `<rect x="${px(i) - bw / 2}" y="${dy(v)}" width="${bw}" height="${h - 6 - dy(v)}" fill="var(--text-faint)" opacity="0.45"/>`).join("");
  const last = series[series.length - 1];
  const first = series[0];
  const up = last.total >= first.total;
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">
    ${bars}
    <polyline points="${pts}" fill="none" stroke="var(--interactive-accent)" stroke-width="1.8"/>
    <circle cx="${px(series.length - 1)}" cy="${ty(last.total)}" r="2.5" fill="var(--interactive-accent)"/>
    <text x="${w - 4}" y="10" text-anchor="end" font-size="9" fill="${up ? "var(--text-success)" : "var(--text-error)"}">${up ? "+" : ""}${last.total - first.total}</text>
  </svg>`;
}

function spark(history, width) {
  // history: [{d, total}] 升序；把总量映射成字符条
  if (history.length < 2) return "";
  const vals = history.map((h) => h.total);
  const min = Math.min(...vals), max = Math.max(...vals);
  const blocks = "▁▂▃▄▅▆▇█";
  const recent = history.slice(-width);
  return recent.map((h) => {
    const t = max === min ? 1 : (h.total - min) / (max - min);
    return blocks[Math.min(7, Math.round(t * 7))];
  }).join("");
}

module.exports = class PluginStats extends Plugin {
  async onload() {
    // data.json 结构：{ settings: {...}, snapshot: {date: {repo: total}} }；
    // 兼容旧版直接存 settings 的格式。全新安装 loadData() 返回 null，必须兜底。
    const saved = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved.settings || saved);
    this.snapshots = saved.snapshot || {};
    this.etags = saved.etags || {};        // ETag 缓存，省 GitHub API 配额
    this.achieved = saved.achieved || {};  // 已达成目标的仓库
    this.cache = { repos: {}, official: null, ts: 0 };

    this.addRibbonIcon("line-chart", "插件下载看板", () => this.openView());
    this.addCommand({ id: "open-view", name: "打开下载看板", callback: () => this.openView() });
    this.addCommand({ id: "refresh", name: "刷新数据", callback: async () => { await this.refreshAll(); this.rerenderViews(); } });
    this.addCommand({ id: "export-snapshots", name: "导出快照 CSV", callback: () => this.exportSnapshots() });
    this.addCommand({ id: "weekly-report", name: "生成 Markdown 周报", callback: () => this.generateWeekly() });
    this.addSettingTab(new StatsSettingTab(this.app, this));
    this.registerView(VIEW_TYPE, (leaf) => new StatsView(leaf, this));

    // 每天首次启动静默快照（不阻塞加载）
    if (this.settings.autoSnapshot) {
      const today = new Date().toISOString().slice(0, 10);
      const last = Object.keys(this.snapshots).sort().pop();
      if (last !== today) {
        setTimeout(() => this.refreshAll().then(() => this.rerenderViews()).catch(() => {}), 8000);
      }
    }
  }
  onunload() { this.app.workspace.detachLeavesOfType(VIEW_TYPE); }

  /** settings 与 snapshot 合并落盘，避免两处互相覆盖 */
  async saveState() {
    await this.saveData({ settings: this.settings, snapshot: this.snapshots, etags: this.etags, achieved: this.achieved });
  }

  /** 带条件请求的 JSON 拉取：304 时返回 null（调用方沿用缓存） */
  async fetchJSON(url, etagKey) {
    const headers = { "User-Agent": "obsidian-plugin-stats" };
    if (this.etags[etagKey]) headers["If-None-Match"] = this.etags[etagKey];
    let res;
    try {
      res = await requestUrl({ url, headers });
    } catch (e) {
      if (e && (e.status === 304 || e.code === 304)) return null;
      throw e;
    }
    if (res.status === 304) return null;
    const etag = res.headers && (res.headers.etag || res.headers.ETag);
    if (etag && etag !== this.etags[etagKey]) {
      this.etags[etagKey] = etag;
      await this.saveState();
    }
    return res.json;
  }

  /** 某仓库目标（goalsJson） */
  goalOf(repo) {
    try { return JSON.parse(this.settings.goalsJson || "{}")[repo] || 0; } catch (e) { return 0; }
  }

  /** 领域规则：settings.domainJson 可整体替换内置规则 */
  domainRules() {
    if (this.settings.domainJson) {
      try {
        const arr = JSON.parse(this.settings.domainJson);
        if (Array.isArray(arr) && arr.length && arr.every((r) => Array.isArray(r) && r[0] && Array.isArray(r[1]))) return arr;
      } catch (e) {}
    }
    return DOMAIN_RULES;
  }

  /** 按 名称+简介 关键词打分分类；无命中归「其他」 */
  classify(name, desc) {
    const text = ((name || "") + " " + (desc || "")).toLowerCase();
    let best = { cat: "其他", score: 0 };
    for (const [cat, kws] of this.domainRules()) {
      let score = 0;
      for (const kw of kws) {
        if (text.includes(kw)) score += kw.length >= 5 ? 2 : 1;
      }
      if (score > best.score) best = { cat, score };
    }
    return best.cat;
  }

  /** 拉取插件元数据并构建领域索引 {cat: [{id, dl}]}（下载量降序） */
  async buildDomains() {
    const meta = await this.fetchJSON(CP_LIST_URL, "cplist");
    if (meta) this.cache.meta = meta;
    const list = this.cache.meta || [];
    const all = this.cache.allStats || {};
    const domains = {};
    for (const e of list) {
      const st = all[e.id];
      if (!st) continue; // stats 与目录列表交集
      const cat = this.classify(e.name, e.description);
      (domains[cat] = domains[cat] || []).push({ id: e.id, name: e.name, dl: st.downloads || 0 });
    }
    for (const cat of Object.keys(domains)) domains[cat].sort((a, b) => b.dl - a.dl);
    this.cache.domains = domains;
    // 蓝海雷达：机会分 = 需求密度(领域中位/全域最大中位, 70%) + 头部分散度(1-Top1占比, 30%)
    const opp = [];
    for (const cat of Object.keys(domains)) {
      const list = domains[cat];
      if (list.length < 5) continue; // 样本太少的领域不评
      const dls = list.map((x) => x.dl);
      const total = dls.reduce((s, v) => s + v, 0);
      const med = list[Math.floor(list.length / 2)].dl;
      const top1 = list[0].dl / Math.max(1, total);
      opp.push({ cat, n: list.length, total, med, top1, score: 0 });
    }
    const maxMed = Math.max(...opp.map((o) => o.med), 1);
    for (const o of opp) {
      o.score = Math.round(((o.med / maxMed) * 0.7 + (1 - o.top1) * 0.3) * 100);
    }
    opp.sort((a, b) => b.score - a.score);
    this.cache.opportunity = opp;
  }

  /** 生成 Markdown 周报笔记 */
  async generateWeekly() {
    const snap = this.snapshots;
    const days = Object.keys(snap).sort();
    if (days.length < 2) { new Notice("快照不足 2 天，明天再来生成周报"); return; }
    const today = days[days.length - 1];
    const idx7 = Math.max(0, days.length - 8);
    const weekStart = days[idx7];
    const repos = this.repoList();
    const all = this.cache.allStats || (await this.fetchJSON(OFFICIAL_STATS_URL, "official")) || null;
    const lines = [
      "# 插件周报 " + today,
      "",
      `统计区间：${weekStart} ~ ${today}（${Math.min(7, days.length - 1)} 天）`,
      "",
      "| 插件 | 当前总量 | 周增量 | 目标进度 |",
      "|---|---|---|---|",
    ];
    const rows = [];
    for (const repo of repos) {
      const cur = snap[today][repo];
      if (cur == null) continue;
      const base = days[idx7][repo] != null ? days[idx7][repo] : snap[days[0]][repo];
      const d7 = cur - base;
      const goal = this.goalOf(repo);
      const goalTxt = goal ? `${Math.round((cur / goal) * 100)}%` : "—";
      rows.push({ repo, cur, d7 });
      lines.push(`| ${repo} | ${cur} | +${d7} | ${goalTxt} |`);
    }
    lines.push("");
    if (all) {
      const ids = Object.keys(all);
      const sorted = ids.map((k) => [k, all[k].downloads || 0]).sort((a, b) => b[1] - a[1]);
      lines.push("## 官方目录排名", "");
      for (const r of rows) {
        const id = r.repo.replace(/^obsidian-/, "");
        if (all[id]) {
          const rank = sorted.findIndex(([k]) => k === id) + 1;
          lines.push(`- ${id}：#${rank}/${ids.length}（官方 ${all[id].downloads}）`);
        } else {
          lines.push(`- ${id}：未收录`);
        }
      }
      lines.push("");
      const watch = this.settings.watchlist.split(",").map((x) => x.trim()).filter(Boolean);
      lines.push("## 竞品对照", "");
      for (const id of watch) {
        const rank = sorted.findIndex(([k]) => k === id) + 1;
        lines.push(`- ${id}：#${rank}（${all[id] ? all[id].downloads : "—"}）`);
      }
    }
    const f = await this.app.vault.create(`插件周报-${today}.md`, lines.join("\n") + "\n");
    new Notice("周报已生成");
    this.app.workspace.getLeaf("tab").openFile(f);
  }
  async saveSettings() { await this.saveState(); }

  /** 快照历史导出 CSV */
  exportSnapshots() {
    const snap = this.snapshots;
    const days = Object.keys(snap).sort();
    const repoKeys = [...new Set(days.flatMap((d) => Object.keys(snap[d])))];
    const rows = [["date", ...repoKeys].join(",")];
    for (const d of days) rows.push([d, ...repoKeys.map((r) => snap[d][r] ?? "")].join(","));
    const blob = new Blob(["\ufeff" + rows.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `plugin-stats-snapshots-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    new Notice(`已导出 ${days.length} 天快照`);
  }

  async openView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
  }

  rerenderViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) leaf.view.render();
  }

  repoList() { return this.settings.repos.split(",").map((s) => s.trim()).filter(Boolean); }
  idList() { return this.settings.pluginIds.split(",").map((s) => s.trim()).filter(Boolean); }

  /** 快照历史：{date: {repoKey: total}} */
  history() { return this.snapshots || {}; }

  async saveSnapshot(totals) {
    const today = new Date().toISOString().slice(0, 10);
    const snapshot = Object.assign({}, this.snapshots || {});
    snapshot[today] = Object.assign({}, snapshot[today] || {}, totals);
    // 只留最近 120 天
    const days = Object.keys(snapshot).sort();
    while (days.length > 120) delete snapshot[days.shift()];
    this.snapshots = snapshot;
    await this.saveState();
  }

  async refreshAll() {
    const totals = {};
    for (const repo of this.repoList()) {
      try {
        const releases = await this.fetchJSON(
          `https://api.github.com/repos/${this.settings.owner}/${repo}/releases?per_page=100`,
          "gh:" + repo
        );
        if (!releases) { // 304：沿用缓存
          const old = this.cache.repos[repo];
          if (old && old.total != null) totals[repo] = old.total;
          continue;
        }
        const perRelease = releases.map((r) => ({
          tag: r.tag_name,
          date: (r.published_at || "").slice(0, 10),
          downloads: (r.assets || []).reduce((s, a) => s + (a.download_count || 0), 0),
          assets: (r.assets || []).map((a) => ({ name: a.name, n: a.download_count || 0 })),
        })).sort((a, b) => b.date.localeCompare(a.date));
        const total = perRelease.reduce((s, r) => s + r.downloads, 0);
        this.cache.repos[repo] = { perRelease, total };
        totals[repo] = total;
      } catch (e) {
        this.cache.repos[repo] = { error: String(e.message || e) };
      }
    }
    // 官方目录收录检测 + 全量排行
    try {
      const stats = await this.fetchJSON(OFFICIAL_STATS_URL, "official");
      if (stats) this.cache.allStats = stats;
      const official = {};
      for (const id of this.idList()) {
        if (stats[id]) official[id] = { total: stats[id].downloads, versions: Object.keys(stats[id]).filter((k) => !["downloads", "updated"].includes(k)).length };
      }
      this.cache.official = official;
      if (this.cache.allStats) await this.buildDomains();
    } catch (e) {
      this.cache.officialError = String(e.message || e);
    }
    await this.saveSnapshot(totals);
    this.cache.ts = Date.now();
    // 目标达成检测（每个目标只提醒一次）
    for (const repo of Object.keys(totals)) {
      const goal = this.goalOf(repo);
      if (goal && totals[repo] >= goal && !this.achieved[repo + ":" + goal]) {
        this.achieved[repo + ":" + goal] = true;
        new Notice(`🎉 ${repo} 达成目标：${totals[repo]}/${goal} 下载！`);
      }
    }
    await this.saveState();
  }

  /** 较前一次快照增量 */
  delta(repo, total) {
    const snap = this.history();
    const days = Object.keys(snap).filter((d) => snap[d] && snap[d][repo] != null).sort();
    if (!days.length) return null;
    const today = new Date().toISOString().slice(0, 10);
    const prevDay = days[days.length - 1] === today && days.length > 1 ? days[days.length - 2] : days[days.length - 1];
    const prev = snap[prevDay][repo];
    const first = snap[days[0]][repo];
    return {
      day: days[days.length - 1] === today && days.length > 1 ? total - prev : null,
      since: total - first, sinceDate: days[0],
    };
  }
};

class StatsView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "插件下载看板"; }
  getIcon() { return "line-chart"; }

  async onOpen() { await this.render(); }
  onClose() { this.contentEl.empty(); }

  async render() {
    const { contentEl } = this;
    const plugin = this.plugin;
    contentEl.empty();
    contentEl.createEl("h4", { text: "📈 插件下载看板" });
    const bar = contentEl.createDiv();
    bar.style.cssText = "display:flex; gap:8px; margin-bottom:8px; align-items:center; flex-wrap:wrap;";
    const refresh = bar.createEl("button", { text: "刷新", cls: "mod-cta" });
    refresh.onclick = async () => {
      refresh.disabled = true; refresh.setText("刷新中…");
      await plugin.refreshAll();
      refresh.disabled = false; refresh.setText("刷新");
      this.render();
    };
    const exportBtn = bar.createEl("button", { text: "导出快照CSV" });
    exportBtn.onclick = () => plugin.exportSnapshots();
    const reportBtn = bar.createEl("button", { text: "生成周报" });
    reportBtn.onclick = async () => {
      reportBtn.disabled = true;
      await plugin.generateWeekly();
      reportBtn.disabled = false;
    };

    // 区间切换 + 汇总趋势图
    const histAll = plugin.history();
    const allDays = Object.keys(histAll).sort();
    this.range = this.range || 7;
    const rangeEl = contentEl.createDiv();
    rangeEl.style.cssText = "display:flex; gap:4px; align-items:center; margin-bottom:6px;";
    rangeEl.createEl("span", { text: "区间", attr: { style: "font-size:12px; color:var(--text-muted);" } });
    for (const r of [7, 30, 0]) {
      const b = rangeEl.createEl("button", { text: r === 0 ? "全部" : r + "天" });
      b.style.cssText = "padding:2px 8px; font-size:12px;" + (this.range === r ? "; background:var(--interactive-accent); color:var(--text-on-accent);" : "");
      b.onclick = () => { this.range = r; this.render(); };
    }
    const chartDays = allDays.slice(this.range === 0 ? 0 : -this.range);
    const totalsByDay = chartDays.map((d) => ({ d, total: Object.values(histAll[d] || {}).reduce((s, v) => s + (v || 0), 0) }));
    const chartWrap = contentEl.createDiv();
    chartWrap.style.cssText = "border:1px solid var(--background-modifier-border); border-radius:8px; padding:6px; margin-bottom:8px;";
    chartWrap.createEl("div", { text: `全仓库总下载趋势（${chartDays.length} 个快照）`, attr: { style: "font-size:11px; color:var(--text-muted); margin-bottom:2px;" } });
    const svgHost = chartWrap.createDiv();
    if (svgChart(totalsByDay, 600, 90)) {
      svgHost.innerHTML = svgChart(totalsByDay, 600, 90);
      svgHost.title = totalsByDay.map((x) => `${x.d}: ${x.total}`).join("\n");
    } else {
      svgHost.setText("快照不足 2 天，明天开始出图");
      svgHost.style.cssText = "color:var(--text-muted); font-size:12px; padding:20px; text-align:center;";
    }
    // ---- Hero 汇总 + 热力条 ----
    const metric = (label, value, color) => {
      const cell = hero.createDiv();
      cell.style.cssText = "flex:1; text-align:center; padding:6px 4px;";
      cell.createEl("div", { text: value, attr: { style: `font-size:18px; font-weight:700; color:${color || "var(--text-normal)"};` } });
      cell.createEl("div", { text: label, attr: { style: "font-size:11px; color:var(--text-muted);" } });
    };
    const hero = contentEl.createDiv();
    hero.style.cssText = "display:flex; background:var(--background-secondary); border-radius:10px; padding:6px; margin-bottom:8px;";
    const gTotals = totalsByDay.map((x) => x.total);
    const gLast = gTotals.length ? gTotals[gTotals.length - 1] : 0;
    const gDeltas = gTotals.map((v, i) => (i ? Math.max(0, v - gTotals[i - 1]) : 0));
    const d7sum = gDeltas.slice(-7).reduce((s, v) => s + v, 0);
    const bestDay = gDeltas.length ? Math.max(...gDeltas) : 0;
    const bestIdx = gDeltas.indexOf(bestDay);
    const listedN = plugin.cache.allStats ? plugin.idList().filter((id) => plugin.cache.allStats[id]).length : 0;
    metric("总下载", fmt(gLast), "var(--interactive-accent)");
    metric(this.range === 0 ? "全期增量" : `近${this.range}日增量`, "+" + fmt(d7sum), "var(--text-success)");
    metric("最高单日", gDeltas.length ? "+" + fmt(bestDay) : "—");
    metric("峰值日", bestDay > 0 && chartDays[bestIdx] ? chartDays[bestIdx].slice(5) : "—");
    metric("官方收录", `${listedN}/${plugin.idList().length}`);

    if (allDays.length >= 3) {
      const heat = contentEl.createDiv();
      heat.style.cssText = "display:flex; align-items:center; gap:2px; margin-bottom:8px; flex-wrap:wrap;";
      heat.createEl("span", { text: "近14日增量", attr: { style: "font-size:11px; color:var(--text-muted); margin-right:4px;" } });
      const last14 = allDays.slice(-14);
      const deltas14 = last14.map((d, i) => {
        if (!i) return 0;
        const prev = Object.values(histAll[last14[i - 1]] || {}).reduce((s, v) => s + (v || 0), 0);
        const cur = Object.values(histAll[d] || {}).reduce((s, v) => s + (v || 0), 0);
        return Math.max(0, cur - prev);
      });
      const hMax = Math.max(...deltas14, 1);
      const shades = ["", "color:var(--text-muted);", "color:var(--text-normal); font-weight:600;", "color:var(--interactive-accent); font-weight:600;", "color:var(--interactive-accent); font-weight:700; background:var(--background-modifier-hover);"];
      last14.forEach((d, i) => {
        const level = deltas14[i] === 0 ? 0 : Math.min(4, Math.floor((deltas14[i] / hMax) * 4.999) + 1);
        const cell = heat.createSpan({ text: d.slice(8) });
        cell.style.cssText = "font-size:10px; padding:2px 3px; border-radius:3px; background:var(--background-secondary); " + shades[level];
        cell.title = `${d}: +${deltas14[i]}`;
      });
    }

    const tsEl = bar.createEl("span", {
      text: plugin.cache.ts ? `更新于 ${new Date(plugin.cache.ts).toLocaleTimeString()}` : "未刷新",
      attr: { style: "color:var(--text-muted); font-size:12px; margin-left:auto;" },
    });

    // ---- 赛道概览：你的插件在官方 8000+ 插件中的位置 ----
    const all = plugin.cache.allStats;
    if (all) {
      const ids = Object.keys(all);
      const sorted = ids.map((k) => [k, all[k].downloads || 0]).sort((a, b) => b[1] - a[1]);
      const rankOf = (id) => sorted.findIndex(([k]) => k === id) + 1;
      const overview = contentEl.createDiv();
      overview.style.cssText = "padding:8px; margin-bottom:8px; background:var(--background-secondary); border-radius:8px; font-size:12px; line-height:1.8;";
      overview.createEl("div", { text: `🏛 官方社区目录共 ${ids.length} 个插件（中位 ${fmt(sorted[Math.floor(ids.length / 2)][1])} 下载）`, attr: { style: "font-weight:600;" } });
      const mine = plugin.idList().filter((id) => all[id]);
      if (mine.length) {
        const ranked = mine.map((id) => ({ id, rank: rankOf(id), total: all[id].downloads || 0 })).sort((a, b) => a.rank - b.rank);
        for (const r of ranked) {
          const line = overview.createDiv();
          line.style.cssText = "display:flex; justify-content:space-between;";
          line.createEl("span", { text: `#${r.rank} ${r.id}` });
          line.createEl("span", { text: `${fmt(r.total)} · 超越 ${Math.round((1 - r.rank / ids.length) * 100)}% 插件`, attr: { style: "color:var(--text-muted);" } });
        }
      } else {
        overview.createEl("div", { text: "你的插件尚未收录——提交上架后这里会出现官方排名", attr: { style: "color:var(--text-muted);" } });
      }
      // 竞品关注
      const watch = plugin.settings.watchlist.split(",").map((s) => s.trim()).filter(Boolean);
      if (watch.length) {
        const wEl = overview.createDiv();
        wEl.style.marginTop = "4px";
        wEl.createEl("div", { text: "🔭 竞品关注", attr: { style: "font-weight:600;" } });
        for (const id of watch) {
          const line = wEl.createDiv();
          line.style.cssText = "display:flex; justify-content:space-between;";
          const rk = all[id] ? `#${rankOf(id)}` : "未收录";
          line.createEl("span", { text: `${rk} ${id}` });
          line.createEl("span", { text: all[id] ? fmt(all[id].downloads || 0) : "—", attr: { style: "color:var(--text-muted);" } });
        }
      }

      // 对比条形图（对数刻度：蓝=我方 灰=竞品）
      const cmpIds = [
        ...plugin.idList().filter((id) => all[id]).map((id) => ({ id, dl: all[id].downloads || 0, mine: true })),
        ...watch.filter((id) => all[id]).map((id) => ({ id, dl: all[id].downloads || 0, mine: false })),
      ];
      if (cmpIds.length >= 2) {
        const maxDl = Math.max(...cmpIds.map((x) => x.dl), 1);
        const cmp = contentEl.createDiv();
        cmp.style.cssText = "border:1px solid var(--background-modifier-border); border-radius:8px; padding:8px; margin-bottom:8px;";
        cmp.createEl("div", { text: "⚖ 量级对比（对数刻度 · 蓝=我方 灰=竞品）", attr: { style: "font-size:11px; color:var(--text-muted); margin-bottom:4px;" } });
        const lg = (v) => Math.log10(Math.max(10, v)) - 1;
        const lgMax = lg(maxDl);
        for (const x of cmpIds.sort((a, b) => b.dl - a.dl)) {
          const row = cmp.createDiv();
          row.style.cssText = "display:flex; align-items:center; gap:6px; margin:3px 0; font-size:11px;";
          row.createEl("span", { text: x.id, attr: { style: `width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; ${x.mine ? "font-weight:600;" : "color:var(--text-muted);"}` } });
          const track = row.createDiv();
          track.style.cssText = "flex:1; height:10px; background:var(--background-secondary); border-radius:5px; overflow:hidden;";
          const fill = track.createDiv();
          fill.style.cssText = `height:100%; width:${Math.max(2, (lg(x.dl) / lgMax) * 100)}%; background:${x.mine ? "var(--interactive-accent)" : "var(--text-faint)"}; border-radius:5px;`;
          row.createEl("span", { text: fmt(x.dl), attr: { style: "width:48px; text-align:right; color:var(--text-muted);" } });
        }
      }
    }

    // ---- 领域细分 ----
    const domains = plugin.cache.domains;
    if (domains && Object.keys(domains).length) {
      const catNames = Object.keys(domains).sort((a, b) => domains[b].length - domains[a].length);
      const dWrap = contentEl.createDiv();
      dWrap.style.cssText = "border:1px solid var(--background-modifier-border); border-radius:8px; padding:8px; margin-bottom:8px; font-size:12px;";
      dWrap.createEl("div", {
        text: "🗂 领域细分（" + catNames.length + " 个领域 · 关键词分类，可在设置自定义）",
        attr: { style: "font-weight:600; margin-bottom:4px;" },
      });
      const metaById = {};
      for (const e of plugin.cache.meta || []) metaById[e.id] = e;
      const myIds = plugin.idList().filter((id) => all[id]);
      for (const id of myIds) {
        const meta = metaById[id] || {};
        const cat = plugin.classify(meta.name, meta.description);
        const list2 = domains[cat] || [];
        const idx = list2.findIndex((x) => x.id === id);
        const med = list2.length ? list2[Math.floor(list2.length / 2)].dl : 0;
        const top = list2.slice(0, 3).map((x) => x.id).join(", ");
        const row = dWrap.createDiv();
        row.style.cssText = "padding:3px 0; border-top:1px solid var(--background-modifier-border);";
        row.createEl("div", {
          text: id + " → " + cat + "：领域内 #" + (idx + 1) + "/" + list2.length + " · 领域中位 " + fmt(med),
          attr: { style: "font-weight:600;" },
        });
        row.createEl("div", { text: "领域头部：" + top, attr: { style: "color:var(--text-muted);" } });
      }
      if (!myIds.length) {
        dWrap.createEl("div", { text: "插件收录后这里显示其领域内排名。", attr: { style: "color:var(--text-muted);" } });
      }
      // 各领域规模条（点击查看该领域 Top10）
      const scale = dWrap.createDiv();
      scale.style.marginTop = "4px";
      const maxN = Math.max(...catNames.map((c) => domains[c].length), 1);
      for (const cat of catNames) {
        const list2 = domains[cat];
        const med = list2[Math.floor(list2.length / 2)].dl;
        const row = scale.createDiv();
        row.style.cssText = "display:flex; align-items:center; gap:6px; margin:2px 0; cursor:pointer;";
        row.createEl("span", { text: cat, attr: { style: "width:110px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis;" } });
        const track = row.createDiv();
        track.style.cssText = "flex:1; height:8px; background:var(--background-secondary); border-radius:4px; overflow:hidden;";
        const fill = track.createDiv();
        fill.style.cssText = "height:100%; width:" + Math.max(2, (list2.length / maxN) * 100) + "%; background:var(--interactive-accent); opacity:0.7;";
        row.createEl("span", {
          text: list2.length + "个 · 中位" + fmt(med),
          attr: { style: "width:110px; text-align:right; color:var(--text-muted);" },
        });
        row.title = "点击查看该领域 Top10";
        row.onclick = () => { domainSel.value = cat; renderLb("", cat); lbWrap.open = true; };
      }
    }

    // ---- 蓝海雷达：找需求强、供给少、头部弱的领域 ----
    const oppList = plugin.cache.opportunity;
    if (oppList && oppList.length) {
      const oWrap = contentEl.createDiv();
      oWrap.style.cssText = "border:1px solid var(--background-modifier-border); border-radius:8px; padding:8px; margin-bottom:8px; font-size:12px;";
      oWrap.createEl("div", {
        text: "🛰 蓝海雷达 · 领域机会分（需求密度70% + 头部分散度30%，★=你已有插件）",
        attr: { style: "font-weight:600; margin-bottom:4px;" },
      });
      const myDomains = new Set();
      const metaById = {};
      for (const e of plugin.cache.meta || []) metaById[e.id] = e;
      for (const id of plugin.idList()) {
        const m = metaById[id];
        if (m && all[id]) myDomains.add(plugin.classify(m.name, m.description));
      }
      const maxScore = Math.max(...oppList.map((o) => o.score), 1);
      const verdict = (o) => (o.score >= 55 ? "🌊 蓝海" : o.score >= 40 ? "⚖ 均衡" : "🔥 红海");
      for (const o of oppList.slice(0, 10)) {
        const row = oWrap.createDiv();
        row.style.cssText = "display:flex; align-items:center; gap:6px; margin:3px 0;";
        row.createEl("span", {
          text: (myDomains.has(o.cat) ? "★ " : "") + o.cat,
          attr: { style: "width:130px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; font-weight:" + (myDomains.has(o.cat) ? "600" : "400") + ";" },
        });
        const track = row.createDiv();
        track.style.cssText = "flex:1; height:10px; background:var(--background-secondary); border-radius:5px; overflow:hidden;";
        const fill = track.createDiv();
        fill.style.cssText = "height:100%; width:" + Math.max(2, (o.score / maxScore) * 100) + "%; background:" + (o.score >= 55 ? "var(--text-success)" : o.score >= 40 ? "var(--interactive-accent)" : "var(--text-faint)") + ";";
        row.createEl("span", {
          text: o.score + "分 " + verdict(o) + " · " + o.n + "个 · 中位" + fmt(o.med) + " · 头部占" + Math.round(o.top1 * 100) + "%",
          attr: { style: "width:230px; text-align:right; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" },
        });
        row.title = o.cat + "：" + o.n + " 个插件，总下载 " + o.total + "，中位 " + o.med + "，Top1 占比 " + Math.round(o.top1 * 100) + "%。机会分=需求密度(70%)+头部分散度(30%)";
      }
      oWrap.createEl("div", {
        text: "解读：中位下载高=真实需求；插件数少/头部占比低=供给不足，新插件更容易被看见。★ 是你已进入的领域，对比同分领域可判断深耕还是新开。",
        attr: { style: "color:var(--text-muted); margin-top:4px; line-height:1.5;" },
      });
    }

    // ---- 全量排行榜（搜索 + 领域筛选） ----
    if (all) {
      const lbWrap = contentEl.createEl("details");
      lbWrap.style.marginBottom = "8px";
      lbWrap.createEl("summary", { text: "🏅 全量排行榜（搜索 / 领域筛选）", attr: { style: "cursor:pointer; font-weight:600; font-size:13px;" } });
      const controls = lbWrap.createDiv();
      controls.style.cssText = "display:flex; gap:6px; margin:6px 0;";
      const search = controls.createEl("input", { type: "text", placeholder: "搜插件 id，如 dataview" });
      search.style.cssText = "flex:1; padding:4px 8px;";
      const domainSel = controls.createEl("select");
      domainSel.style.cssText = "width:140px; font-size:12px;";
      domainSel.createEl("option", { value: "", text: "全部领域" });
      const domains2 = plugin.cache.domains || {};
      for (const cat of Object.keys(domains2).sort()) {
        domainSel.createEl("option", { value: cat, text: cat + " (" + domains2[cat].length + ")" });
      }
      const lbList = lbWrap.createDiv();
      lbList.style.cssText = "max-height:240px; overflow-y:auto; font-size:12px;";
      const renderLb = (kw, cat) => {
        lbList.empty();
        let shown = 0;
        if (cat && domains2[cat]) {
          const entries = domains2[cat].map((x) => [x.id, x.dl]);
          for (let i = 0; i < entries.length && shown < 30; i++) {
            const id = entries[i][0], dl = entries[i][1];
            if (kw && !id.includes(kw)) continue;
            shown++;
            const row = lbList.createDiv();
            row.style.cssText = "display:flex; justify-content:space-between; padding:2px 6px;";
            row.createEl("span", { text: "#" + (i + 1) + " " + id });
            row.createEl("span", { text: fmt(dl), attr: { style: "color:var(--text-muted);" } });
          }
        } else {
          const entries = Object.entries(all).map(([id, v]) => [id, v.downloads || 0]).sort((a, b) => b[1] - a[1]);
          for (let i = 0; i < entries.length && shown < 30; i++) {
            const id = entries[i][0], dl = entries[i][1];
            if (kw && !id.includes(kw)) continue;
            shown++;
            const row = lbList.createDiv();
            row.style.cssText = "display:flex; justify-content:space-between; padding:2px 6px;";
            row.createEl("span", { text: "#" + (i + 1) + " " + id });
            row.createEl("span", { text: fmt(dl), attr: { style: "color:var(--text-muted);" } });
          }
        }
        if (!shown) lbList.createEl("div", { text: "无匹配", attr: { style: "color:var(--text-muted); padding:4px 6px;" } });
      };
      renderLb("", "");
      search.oninput = () => renderLb(search.value.trim().toLowerCase(), domainSel.value);
      domainSel.onchange = () => renderLb(search.value.trim().toLowerCase(), domainSel.value);
    }

    const listEl = contentEl.createDiv();
    const repos = plugin.repoList();
    const hist = plugin.history();
    const days = Object.keys(hist).sort();
    repos.sort((a, b) => ((plugin.cache.repos[b] || {}).total || 0) - ((plugin.cache.repos[a] || {}).total || 0));

    for (const repo of repos) {
      const data = plugin.cache.repos[repo];
      const item = listEl.createDiv("ps-item");
      item.style.cssText = "padding:8px; margin-bottom:6px; border:1px solid var(--background-modifier-border); border-radius:8px;";

      if (!data) {
        item.createEl("div", { text: repo + " — 点「刷新」拉取", attr: { style: "color:var(--text-muted); font-size:12px;" } });
        continue;
      }
      if (data.error) {
        item.createEl("div", { text: `${repo} ❌ ${data.error}`, attr: { style: "color:var(--text-error); font-size:12px;" } });
        continue;
      }

      const head = item.createDiv();
      head.style.cssText = "display:flex; justify-content:space-between; align-items:baseline;";
      head.createEl("div", { text: repo, attr: { style: "font-weight:700;" } });
      head.createEl("div", { text: `${fmt(data.total)} 下载`, attr: { style: "font-weight:700; color:var(--interactive-accent);" } });

      const d = plugin.delta(repo, data.total);
      const deltaLine = item.createDiv();
      deltaLine.style.cssText = "font-size:12px; color:var(--text-muted); margin:2px 0;";
      const parts = [];
      if (d && d.day != null) parts.push(`较上次快照 +${d.day}`);
      if (d) parts.push(`自 ${d.sinceDate} 以来 +${d.since}`);
      deltaLine.setText(parts.length ? parts.join(" ｜ ") : "首次快照，明天开始有增量");

      // 目标进度条
      const goal = plugin.goalOf(repo);
      if (goal) {
        const pct = Math.min(100, Math.round((data.total / goal) * 100));
        const gw = item.createDiv();
        gw.style.cssText = "display:flex; align-items:center; gap:6px; margin:3px 0; font-size:11px; color:var(--text-muted);";
        const track = gw.createDiv();
        track.style.cssText = "flex:1; height:6px; background:var(--background-modifier-border); border-radius:3px; overflow:hidden;";
        const fill = track.createDiv();
        fill.style.cssText = `height:100%; width:${pct}%; background:var(--interactive-accent);`;
        gw.createEl("span", { text: `🎯 ${data.total}/${goal}（${pct}%）` });
      }

      // 官方收录
      const id = repo.replace(/^obsidian-/, "");
      const off = plugin.cache.official && plugin.cache.official[id];
      const offEl = item.createDiv();
      offEl.style.cssText = "font-size:12px; margin:2px 0;";
      offEl.setText(off ? `🏛 官方目录已收录：${fmt(off.total)} 下载 / ${off.versions} 个版本` : "⏳ 未进官方目录（提交后自动检测）");

      // 快照趋势 + 增长统计（日均 / 近7日 / 峰值 / 预计达标）
      const series = days.map((k) => ({ d: k, total: hist[k][repo] })).filter((x) => x.total != null);
      if (series.length >= 2) {
        const dl = series.map((x, i) => (i ? Math.max(0, x.total - series[i - 1].total) : 0)).slice(1);
        const avg = Math.round(dl.reduce((s, v) => s + v, 0) / dl.length);
        const best = Math.max(...dl);
        const win = dl.slice(-7);
        const avg7 = Math.round(win.reduce((s, v) => s + v, 0) / Math.max(1, win.length));
        const goal2 = plugin.goalOf(repo);
        let eta = "";
        if (goal2 && data.total < goal2 && avg7 > 0) {
          const need = Math.ceil((goal2 - data.total) / avg7);
          eta = ` · 🎯按近7日均速约 ${need} 天达标`;
        }
        const stat = item.createDiv();
        stat.style.cssText = "font-size:11px; color:var(--text-muted); margin:2px 0;";
        stat.setText(`日均 ${avg} · 近7日均 ${avg7} · 峰值 +${best}${eta}`);
        const sp = item.createDiv();
        sp.style.cssText = "font-family:monospace; font-size:13px; color:var(--text-faint); margin-top:2px;";
        sp.setText(spark(series, 60) || "");
        sp.title = series.map((s) => `${s.d}: ${s.total}`).join("\n");
      }

      // 逐版本
      const det = item.createEl("details");
      det.createEl("summary", { text: `${data.perRelease.length} 个版本明细`, attr: { style: "font-size:12px; cursor:pointer; color:var(--text-muted);" } });
      const maxDl = Math.max(...data.perRelease.map((r) => r.downloads), 1);
      for (const r of data.perRelease) {
        const row = det.createDiv();
        row.style.cssText = "position:relative; display:flex; justify-content:space-between; font-size:12px; padding:2px 4px; overflow:hidden;";
        const barBg = row.createDiv();
        barBg.style.cssText = `position:absolute; inset:0; width:${Math.max(3, (r.downloads / maxDl) * 100)}%; background:var(--background-modifier-hover);`;
        const lbl = row.createSpan({ text: `${r.tag}（${r.date}）` });
        const val = row.createSpan({ text: fmt(r.downloads), attr: { style: "color:var(--text-muted);" } });
        lbl.style.position = "relative"; val.style.position = "relative";
      }
    }

    if (plugin.cache.officialError) {
      contentEl.createEl("div", { text: "官方目录数据拉取失败：" + plugin.cache.officialError, attr: { style: "color:var(--text-error); font-size:12px;" } });
    }
    contentEl.createEl("div", { text: "📦 我的插件（按下载量排序）", attr: { style: "font-weight:600; margin:8px 0 4px; font-size:13px;" } });
    contentEl.createEl("div", {
      text: `快照已存 ${days.length} 天`,
    });
    // 上架待办：官方目录收录清单对照
    if (plugin.cache.allStats) {
      const unlisted = plugin.idList().filter((id) => !plugin.cache.allStats[id]);
      const listed = plugin.idList().filter((id) => plugin.cache.allStats[id]);
      const todo = contentEl.createDiv();
      todo.style.cssText = "padding:6px 8px; margin-top:6px; background:var(--background-secondary); border-radius:6px; font-size:12px;";
      todo.createEl("div", { text: `📤 上架进度：${listed.length} 已收录 / ${plugin.idList().length} 计划`, attr: { style: "font-weight:600;" } });
      if (unlisted.length) {
        todo.createEl("div", {
          text: `待提交或待过审：${unlisted.join("、")}（community.obsidian.md 提交后自动出现）`,
          attr: { style: "color:var(--text-muted); margin-top:2px;" },
        });
      }
    }
    contentEl.createEl("div", {
      text: "",
      attr: { style: "color:var(--text-muted); font-size:11px; margin-top:4px;" },
    });
  }
}

class StatsSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName("GitHub 用户名").addText((t) =>
      t.setValue(this.plugin.settings.owner).onChange(async (v) => {
        this.plugin.settings.owner = v.trim() || "121212165"; await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName("仓库列表").setDesc("逗号分隔，将拉取各仓库 Releases 的下载量").addTextArea((t) =>
      t.setValue(this.plugin.settings.repos).onChange(async (v) => {
        this.plugin.settings.repos = v; await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName("官方目录插件 ID").setDesc("用于在 community-plugin-stats.json 中检测是否已被收录").addTextArea((t) =>
      t.setValue(this.plugin.settings.pluginIds).onChange(async (v) => {
        this.plugin.settings.pluginIds = v; await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName("竞品关注列表").setDesc("逗号分隔的官方插件 id，看板顶部显示其排名与下载量").addTextArea((t) =>
      t.setValue(this.plugin.settings.watchlist).onChange(async (v) => {
        this.plugin.settings.watchlist = v; await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName("每日自动快照").setDesc("每天首次打开 Obsidian 时静默刷新一次").addToggle((t) =>
      t.setValue(this.plugin.settings.autoSnapshot).onChange(async (v) => {
        this.plugin.settings.autoSnapshot = v; await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName("领域分类规则（JSON，可选）")
      .setDesc('整体替换内置领域规则。格式 [["领域名",["关键词",...]],...]，按 名称+简介 关键词匹配。细分你的赛道，如 [["网文写作",["novel","fiction","fanqie"]]]')
      .addTextArea((t) => {
        t.setValue(this.plugin.settings.domainJson || "");
        t.inputEl.style.minHeight = "100px";
        t.inputEl.style.fontFamily = "monospace";
        t.onChange(async (v) => {
          this.plugin.settings.domainJson = v;
          await this.plugin.saveSettings();
        });
      });
    new Setting(containerEl).setName("下载目标（JSON）")
      .setDesc('{"仓库名": 目标下载数}，如 {"obsidian-clipping-finder": 500}。面板显示进度条，达成时提醒一次')
      .addTextArea((t) => {
        t.setValue(this.plugin.settings.goalsJson || "{}");
        t.inputEl.style.minHeight = "60px";
        t.inputEl.style.fontFamily = "monospace";
        t.onChange(async (v) => {
          this.plugin.settings.goalsJson = v;
          await this.plugin.saveSettings();
        });
      });
  }
}
