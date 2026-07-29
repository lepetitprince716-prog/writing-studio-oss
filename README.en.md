# writing-studio

[中文](README.md)

A local writing studio for long-form fiction: single-user, binds `127.0.0.1` only, reads and writes your own Markdown vault directly (Obsidian-compatible), with the panel's own data (SQLite) kept entirely out of the vault.

## Read these two things first

- **The web UI is Simplified Chinese only, with no locale switch.** The server's `localePreset` setting only affects a handful of sidebar section headings (WorldGraph uses those same heading names to locate the writing-status stop point), and which lint rule pack loads — it does not affect the React UI's copy, and it does not affect the AI system prompts, which stay Chinese regardless of what `localePreset` is set to (see `apps/server/src/prompts/locales/index.ts`). If you can't read a Chinese interface, know that before you clone.
- **There is no authentication.** The server binds loopback only and checks the `Origin` header, but that is not authentication: any other process on the same machine has full read/write access to your vault, and can spend your AI account's credits through whatever CLI you've configured. See [SECURITY.md](SECURITY.md) for the full threat model.

## What it is

- **Vault editing and drafts**: the server parses a project-configured chapter tree; only the manuscript tree, the drafts directory, sidebar Markdown files a project explicitly declares, and the file `graph.relationsFile` points at go through the document API — all four are readable and writable, and writes all go through the same SHA256-checked optimistic lock. The drafts directory is config-driven (`draftsDir`), written inside the vault, and visible to Obsidian in both directions.
- **Sidebar and threads**: structured DTOs for the setting index, characters, writing status, and foreshadowing; WebSocket notifications for external edits; anchors, revisions, AI conversation threads and run records. The writer-facing DTO filters out content marked by the project's configured `authorOnlyMarkers` list — not a fixed literal string; the example vault uses the marker `"Author only"`, but the actual marker text is project-defined.
- **Rewrite and versioning**: structured rewrites land in a read-only diff first; only after you confirm does the result reach the editor buffer, and the manuscript still needs an explicit save before it's written back to the vault. Pre-rewrite content, AI candidates, and saved content are all stored by SHA in the panel's SQLite, so version history can be diffed and restored.
- **Canon conflict check**: `/api/projects/:pid/documents/:docId/conflict-check` is a live, registered route, and the web app ships a full panel for it (`ConflictFindingsPanel`). Beyond that one feature, letting the AI propose canon changes on its own is genuinely not implemented yet.
- **Agent backends**: a built-in `echo` backend (no external CLI needed, works on any platform, good for smoke-testing) plus adapters for five external CLIs — Claude Code, Codex, OpenCode, Grok CLI, and Pi. The writer profile is granted equally to every external CLI, including Codex, whenever the binary, auth, and filesystem-sandbox conditions are met. The planner profile is currently fail-closed for every external CLI — it never invokes the CLI and never reads the vault.
- **WorldGraph relationship graph**: once a project declares a `graph` config, a read-only relationship graph becomes available; semantic relationships come only from explicit Markdown tables. The default view is a local 2D graph of entities related to the current document, switchable to a global 3D view or a paginated list with no WebGL. Author and writer-safe projections are each generated server-side, and graph data never enters the AI context automatically. Details in the [WorldGraph design doc](docs/design/2026-07-22-worldgraph.md).

## What you need

- Node.js >= 22
- pnpm 11.5.2 (the repo pins the exact version via Corepack; `corepack enable` picks it up automatically)
- A Markdown vault you want to write in (not required up front — the repo ships a minimal example)
- macOS, if you want to use Claude, OpenCode, or Grok — those three CLIs' writer permission always depends on macOS's `sandbox-exec` (Seatbelt), and they will not be misreported as available on other platforms. Codex depends on it too by default (`seatbelt` mode); setting `WRITING_STUDIO_CODEX_SANDBOX=native` swaps that for Codex's own permission profile and drops the macOS requirement, trading it for isolation that's only as good as Codex's own sandbox — see [SECURITY.md](SECURITY.md). `echo` and `pi` are exempt from this and work on any platform

## Install

```bash
git clone <this-repo-url>
cd writing-studio
corepack enable
pnpm install
```

## First run

Right after cloning you can run `pnpm dev`: if `data/registry.json` doesn't exist yet, the server still starts normally, `GET /api/projects` returns an empty array, and nothing on disk is scanned or modified. To see something, register a project first:

```bash
cp data/registry.example.json data/registry.json
pnpm dev
```

`registry.example.json` enables the repo's minimal example vault (`examples/basic-vault`) by default: one manuscript chapter, one setting index, one character card, one writing-status record, and a two-node relationship graph, all self-describing placeholder content — none of it is real story material. The writing-status file is not decoration — `graph.stopSourceId` points at it, and without it the graph can't resolve a stop point, so requesting the writer-safe view throws. To start from an empty list instead, set that entry's `enabled` to `false`.

## Pointing at your own vault

There are two ways to register a real project.

**Option one: hand-write a registry entry.** Edit `data/registry.json`, add an entry pointing at your vault, and put a `.writing-studio/project.json` inside that vault (you can copy `examples/basic-vault/.writing-studio/project.json` and adjust it to your own directory layout). The project `id` must match in both places.

**Option two: use the scaffolding command**, which generates an empty skeleton and registers it for you:

```bash
pnpm --filter @writing-studio/server create-project -- \
  --id my-novel --name "Project display name" --vault /absolute/path/to/your-vault --locale en
```

`--locale` accepts `zh-CN` (default) or `en`. As noted above under "read these two things first", it only changes sidebar section headings (including the heading names WorldGraph uses to locate the stop-point section) and the lint rule pack — it will not turn the UI or the AI prompts into English. The skeleton's setting-index and character-card examples are placeholder markers only; once you fill in real content, or move an example out of its comment, remove the marker itself. A new project's writing-status "story stop" section starts empty: the planner sees the full relationship graph and a "no stop point yet" notice, and the writer-safe preview stays an empty projection. Only once you write an explicit chapter reference into the stop-point section does the writer projection start releasing content up to that point — creating a first chapter on its own does not advance the stop point.

`vaultRoot` can be an absolute path, or a path relative to the directory `registry.json` lives in.

After hand-writing or editing `project.json`, you can validate it on its own with `pnpm --filter @writing-studio/server validate-config -- <absolute vault root> [--json]` — a read-only check of the schema and cross-field constraints (such as whether `graph.stopSourceId` resolves), which does not modify anything.

## Configuring a project

The vault's `.writing-studio/project.json` declares everything structural about a project. Common fields (this is an excerpt, not a complete file that would pass schema validation as-is — see the full field list linked at the end of this file):

```jsonc
{
  "schemaVersion": 1,
  "id": "project identifier, must match the registry entry",
  "displayName": "project display name",
  "localePreset": "en",               // or "zh-CN"; see above
  "contentTree": { "root": "manuscript directory name", "levels": [ /* chapter-tree level patterns */ ] },
  "draftsDir": "drafts directory name",
  "sidebarSources": [ /* parsing rules for setting-index, character-card, writing-status, etc. Markdown files */ ],
  "graph": { "schemaVersion": 1 /* optional; declaring it enables the read-only relationship graph */ },
  "aiProfiles": {
    "writer": { "readable": ["globs the AI may read"], "forbidden": [], "contextSources": ["sidebar source ids auto-injected each turn"] },
    "planner": { "readable": ["..."], "allowVaultBrowsing": true },
    "defaultProfile": "writer"
  },
  "defaultAgentId": "default agent id, e.g. echo"
}
```

A few security-relevant fields worth knowing:

- `aiProfiles.<name>.readable` / `forbidden`: glob allow/deny lists; deny always wins.
- `contextSources`: sidebar sources auto-injected into model context each turn; content is uniformly filtered through the writer DTO, and raw-text sources can never be auto-injected.
- `lint`: custom style rules, disabling built-in rules by id, replacing the idiom-stacking word list.
- `graph`: needs its own `schemaVersion` (currently 1), the relationship file path, and a data source id that resolves the stop point; if unset, no graph entry point is exposed anywhere.

The writing-status data source (the `sidebarSources` entry whose `parserConfig.kind` is `writingStatus`) looks up each section in the writing-status file by the heading name in `parserConfig.sectionHeadings`. Leave that field unset and each section matches its `localePreset` locale's default heading instead (under `zh-CN`, the storylines section defaults to the heading 故事线; the other sections work the same way). If your writing-status file uses a different heading — whether from an older convention or your own habit — put the actual heading text into `sectionHeadings.storylines` (and the matching field for any other section: `stopPoint`, `activeForeshadow`, `characterOneLiners`, `redLines`, `expressionBaseline`) so parsing recognizes it.

The full field list and defaults live in `examples/basic-vault/.writing-studio/project.json` and the zod schemas in `packages/contract`.

## Running it

```bash
pnpm dev          # start server + web together, dev mode
pnpm build        # production build for web
```

Common environment overrides:

```bash
WRITING_STUDIO_DATA_DIR=/absolute/path      # where the panel's own data (SQLite, registry) lives; defaults to data/ in the repo
WRITING_STUDIO_REGISTRY_PATH=/absolute/path/to/registry.json   # changes only the registry file's location
WRITING_STUDIO_PORT=8787                    # server port
WRITING_STUDIO_WEB_PORT=5183                # web port; Vite proxies API/WebSocket traffic to the server port above
WRITING_STUDIO_RUN_TIMEOUT_MS=600000        # timeout for a single Agent CLI run (chat, rewrite, etc.); defaults to 300000 (5 minutes)
WRITING_STUDIO_GENERATE_TIMEOUT_MS=900000   # timeout for a whole-chapter generation run (origin: generate); defaults to 600000 (10 minutes)
```

Don't commit your personal `data/registry.json` or any `.sqlite` file — `.gitignore` already excludes them. The only template meant to be committed is `data/registry.example.json`.

The manuscript editor prefers `LXGW WenKai` if it's installed locally, falling back to Source Han Serif or a system serif font otherwise. Nothing is fetched over the network for fonts; install one yourself if you want it.

## Wiring up an AI backend

The built-in `echo` backend needs no external program and is enough to smoke-test the whole UI/API flow. To wire up a real model, point the corresponding CLI's executable path: `WRITING_STUDIO_CLAUDE_PATH`, `WRITING_STUDIO_CODEX_PATH`, `WRITING_STUDIO_OPENCODE_PATH`, and `WRITING_STUDIO_GROK_PATH` default to a bare-command `PATH` lookup; `WRITING_STUDIO_PI_PATH` defaults to `~/.local/bin/pi` (an absolute path, not looked up on `PATH`). All of them can be overridden explicitly:

```bash
WRITING_STUDIO_CLAUDE_PATH=/path/to/claude \
WRITING_STUDIO_CODEX_PATH=/path/to/codex \
WRITING_STUDIO_CODEX_SANDBOX=seatbelt \
WRITING_STUDIO_OPENCODE_PATH=/path/to/opencode \
WRITING_STUDIO_GROK_PATH=/path/to/grok \
WRITING_STUDIO_PI_PATH=/path/to/pi \
pnpm dev
```

`/api/agents` reports live probe results for each CLI, and the selector only enables combinations that are actually available — it never overstates availability. A few points worth knowing:

- Claude, OpenCode, and Grok's writer permission always depend on macOS's `sandbox-exec`. When `sandbox-exec` is unavailable (non-macOS, or a local environment where it doesn't work), `/api/agents` reports those CLIs as supporting no profile at all — it does not weaken the permission and run anyway.
- Codex depends on `sandbox-exec` too in its default mode (`seatbelt`), same rule as above. `WRITING_STUDIO_CODEX_SANDBOX` accepts `seatbelt` (default) or `native`. `native` uses Codex's own permission profile instead of wrapping it in `sandbox-exec` at all — including on macOS — so in `native` mode, whether `sandbox-exec` is usable or whether the host is macOS has no bearing on what `/api/agents` reports. That trade-off (isolation becomes whatever Codex's own sandbox provides) should only be turned on after you've verified it yourself; see [SECURITY.md](SECURITY.md).
- The Pi backend never goes through `sandbox-exec` and works on any platform — but that also means it relies entirely on the `pi` CLI's own sandboxing and permission model. Whatever isolation that CLI provides is all writing-studio has.
- The planner profile is currently fail-closed for every external CLI: it never invokes the CLI and never reads the vault.

The model catalog is just a hint for the selector, not a server-side allowlist. To override an agent's preset model list, add `agent-models.json` in the panel's data directory (`WRITING_STUDIO_DATA_DIR`, `data/` by default):

```json
{
  "opencode": [
    { "id": "provider/model-id", "label": "My display label", "isDefault": true }
  ]
}
```

For the security model and credential boundary — which processes can read/write your vault, whose credentials an AI CLI actually runs with — see [SECURITY.md](SECURITY.md).

## Tests

```bash
pnpm typecheck    # type-checks every workspace; the gate for contract changes
pnpm test         # tests across every workspace: contract + server + web
pnpm verify       # typecheck → build → test, in order
```

CI runs two lanes: the `macos-14` lane runs the full `pnpm verify` (typecheck → build → test) and is the authoritative full check. A `ubuntu-latest` lane runs on every push/PR too, but only `pnpm -r typecheck` plus the contract and web test suites — no build, and no server tests, since the server's Seatbelt sandbox tests need macOS. To reproduce either lane locally, run `pnpm verify` or the matching subset by hand.

Some `apps/server` tests exercise the macOS Seatbelt sandbox directly and skip themselves on any non-macOS platform, or where `sandbox-exec` isn't usable locally. An overall passing run with some entries reported as skipped is expected — it's not lost coverage, just tests that don't apply to your platform.

The graph-layout wall-clock performance benchmark is skipped by default (unreliable under shared CPU); set `WRITING_STUDIO_PERF=1` on a dedicated machine to enable it. CI's macOS lane already sets it.

Three test files (`apps/server/test/context.test.ts`, `apps/server/test/sidebar.test.ts`, `packages/contract/test/schemas.test.ts`) also read `WRITING_STUDIO_LOCAL_VAULT`. Point it at the absolute path of your own real vault and each of them runs an extra smoke check against it; leave it unset and they skip cleanly — again, not lost coverage, just an opt-in check most contributors don't need to set up.

## Reference docs

- [SECURITY.md](SECURITY.md) — threat model, the authentication boundary, sandbox platform limits, the AI CLI credential model
- [CONTRIBUTING.md](CONTRIBUTING.md) — dev setup, `pnpm verify`, workspace layout
- [docs/design/2026-07-22-worldgraph.md](docs/design/2026-07-22-worldgraph.md) — the WorldGraph relationship graph's Markdown canon format, time semantics, and safe projections
- [docs/design/2026-07-24-context-menu.md](docs/design/2026-07-24-context-menu.md) — the panel's shared context-menu component, positioning, and per-surface behavior
- `examples/basic-vault/` — a minimal, runnable vault template with a sample project config

## License

[MIT](LICENSE)
