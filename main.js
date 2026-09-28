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

const DEFAULT_SETTINGS = {
  owner: "121212165",
  repos: "obsidian-clipping-finder, obsidian-ai-flavor-checker, obsidian-scan-card-box, obsidian-daoyu-studio, obsidian-qs8-panel, obsidian-story-ledger, obsidian-jev-decision-log, obsidian-fanqie-drafter",
  pluginIds: "clipping-finder, ai-flavor-checker, scan-card-box, daoyu-studio, qs8-panel, story-ledger, jev-decision-log, fanqie-drafter",
  watchlist: "templater-obsidian, dataview, periodic-notes",
  autoSnapshot: true,
};

function fmt(n) {
  if (n >= 10000) return (n / 10000).toFixed(1) + "w";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.cache = { repos: {}, official: null, ts: 0 };

    this.addRibbonIcon("line-chart", "插件下载看板", () => this.openView());
    this.addCommand({ id: "open-view", name: "打开下载看板", callback: () => this.openView() });
    this.addCommand({ id: "refresh", name: "刷新数据", callback: async () => { await this.refreshAll(); this.rerenderViews(); } });
    this.addCommand({ id: "export-snapshots", name: "导出快照 CSV", callback: () => this.exportSnapshots() });
    this.addSettingTab(new StatsSettingTab(this.app, this));
    this.registerView(VIEW_TYPE, (leaf) => new StatsView(leaf, this));

    // 每天首次启动静默快照（不阻塞加载）
    if (this.settings.autoSnapshot) {
      const today = new Date().toISOString().slice(0, 10);
      const last = Object.keys(this.data.snapshot || {}).sort().pop();
      if (last !== today) {
        setTimeout(() => this.refreshAll().then(() => this.rerenderViews()).catch(() => {}), 8000);
      }
    }
  }
  onunload() { this.app.workspace.detachLeavesOfType(VIEW_TYPE); }
  async saveSettings() { await this.saveData(this.settings); }

  /** 快照历史导出 CSV */
  exportSnapshots() {
    const snap = this.data.snapshot || {};
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
  history() { return this.data.snapshot || {}; }

  async saveSnapshot(totals) {
    const today = new Date().toISOString().slice(0, 10);
    const snapshot = Object.assign({}, this.data.snapshot || {});
    snapshot[today] = Object.assign({}, snapshot[today] || {}, totals);
    // 只留最近 120 天
    const days = Object.keys(snapshot).sort();
    while (days.length > 120) delete snapshot[days.shift()];
    this.data.snapshot = snapshot;
    await this.saveData(this.data);
  }

  async refreshAll() {
    const totals = {};
    for (const repo of this.repoList()) {
      try {
        const res = await requestUrl({
          url: `https://api.github.com/repos/${this.settings.owner}/${repo}/releases?per_page=100`,
          headers: { "User-Agent": "obsidian-plugin-stats" },
        });
        const releases = res.json;
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
      const res = await requestUrl({ url: OFFICIAL_STATS_URL });
      const stats = res.json;
      this.cache.allStats = stats;
      const official = {};
      for (const id of this.idList()) {
        if (stats[id]) official[id] = { total: stats[id].downloads, versions: Object.keys(stats[id]).filter((k) => !["downloads", "updated"].includes(k)).length };
      }
      this.cache.official = official;
    } catch (e) {
      this.cache.officialError = String(e.message || e);
    }
    await this.saveSnapshot(totals);
    this.cache.ts = Date.now();
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
    const tsEl = bar.createEl("span", {
      text: plugin.cache.ts ? `更新于 ${new Date(plugin.cache.ts).toLocaleTimeString()}` : "未刷新",
      attr: { style: "color:var(--text-muted); font-size:12px;" },
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
    }

    // ---- 全量排行榜（搜索） ----
    if (all) {
      const lbWrap = contentEl.createEl("details");
      lbWrap.style.marginBottom = "8px";
      lbWrap.createEl("summary", { text: "🏅 全量排行榜（搜索任意插件）", attr: { style: "cursor:pointer; font-weight:600; font-size:13px;" } });
      const search = lbWrap.createEl("input", { type: "text", placeholder: "搜插件 id，如 dataview" });
      search.style.cssText = "width:100%; margin:6px 0; padding:4px 8px;";
      const lbList = lbWrap.createDiv();
      lbList.style.cssText = "max-height:240px; overflow-y:auto; font-size:12px;";
      const renderList = (kw) => {
        lbList.empty();
        const entries = Object.entries(all).map(([id, v]) => [id, v.downloads || 0]).sort((a, b) => b[1] - a[1]);
        let shown = 0;
        for (let i = 0; i < entries.length && shown < 30; i++) {
          const [id, dl] = entries[i];
          if (kw && !id.includes(kw)) continue;
          shown++;
          const row = lbList.createDiv();
          row.style.cssText = "display:flex; justify-content:space-between; padding:2px 6px;";
          row.createEl("span", { text: `#${i + 1} ${id}` });
          row.createEl("span", { text: fmt(dl), attr: { style: "color:var(--text-muted);" } });
        }
        if (!shown) lbList.createEl("div", { text: "无匹配", attr: { style: "color:var(--text-muted); padding:4px 6px;" } });
      };
      renderList("");
      search.oninput = () => renderList(search.value.trim().toLowerCase());
    }

    const listEl = contentEl.createDiv();
    const repos = plugin.repoList();
    const hist = plugin.history();
    const days = Object.keys(hist).sort();

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

      // 官方收录
      const id = repo.replace(/^obsidian-/, "");
      const off = plugin.cache.official && plugin.cache.official[id];
      const offEl = item.createDiv();
      offEl.style.cssText = "font-size:12px; margin:2px 0;";
      offEl.setText(off ? `🏛 官方目录已收录：${fmt(off.total)} 下载 / ${off.versions} 个版本` : "⏳ 未进官方目录（提交后自动检测）");

      // 快照趋势
      const series = days.map((k) => ({ d: k, total: hist[k][repo] })).filter((x) => x.total != null);
      if (series.length >= 2) {
        const sp = item.createDiv();
        sp.style.cssText = "font-family:monospace; font-size:13px; color:var(--text-faint); margin-top:2px;";
        sp.setText(spark(series, 60) || "");
        sp.title = series.map((s) => `${s.d}: ${s.total}`).join("\n");
      }

      // 逐版本
      const det = item.createEl("details");
      det.createEl("summary", { text: `${data.perRelease.length} 个版本明细`, attr: { style: "font-size:12px; cursor:pointer; color:var(--text-muted);" } });
      for (const r of data.perRelease) {
        const row = det.createDiv();
        row.style.cssText = "display:flex; justify-content:space-between; font-size:12px; padding:2px 4px;";
        row.createEl("span", { text: `${r.tag}（${r.date}）` });
        row.createEl("span", { text: fmt(r.downloads), attr: { style: "color:var(--text-muted);" } });
      }
    }

    if (plugin.cache.officialError) {
      contentEl.createEl("div", { text: "官方目录数据拉取失败：" + plugin.cache.officialError, attr: { style: "color:var(--text-error); font-size:12px;" } });
    }
    contentEl.createEl("div", {
      text: `快照已存 ${days.length} 天`,
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
  }
}
