# Plugin Stats

A download dashboard for your own published Obsidian plugins, right inside
Obsidian.

## What it shows

For each configured GitHub repository (default: all of yours):

- **Total downloads** across all releases, with per-release and per-version
  breakdown
- **Daily snapshots** — every refresh records today's totals into plugin data
  (kept 120 days); the panel shows deltas since the last snapshot and since
  the first one, plus a sparkline trend
- **Official directory detection** — fetches Obsidian's official
  `community-plugin-stats.json` and flags each plugin id once it has been
  accepted into the community directory (with official total downloads)

## Data sources

Both read-only, no login required:

- `api.github.com/repos/{owner}/{repo}/releases` (asset download counts)
- `raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugin-stats.json`

Refresh is manual (button or command) to respect the unauthenticated GitHub
rate limit; the panel caches results between refreshes.

## Settings

- GitHub username
- Repository list (comma separated)
- Community directory plugin ids (comma separated)
