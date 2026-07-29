# writing-studio

[English](README.en.md)

本地长篇小说写作面板：单用户、只绑定 `127.0.0.1`，直接读写你自己的 Markdown vault（与 Obsidian 兼容），面板自身的数据（SQLite）完全隔离在 vault 之外。

## 先看这两条

- **界面只有简体中文，没有语言切换。** 服务端的 `localePreset` 只影响侧栏部分小节标题、WorldGraph 据此定位写作状态里的停点段落、以及 lint 内置规则包，不影响 React 界面本身的文案，也不影响 AI 系统提示词——提示词无论 `localePreset` 设成什么都固定是中文（见 `apps/server/src/prompts/locales/index.ts`）。不认识中文界面就别 clone 了。
- **没有身份验证。** 服务端只绑定 loopback 并校验 Origin，这不是身份验证：同一台机器上的任何其他进程都能直接读写你的 vault，也能用你配置的 AI CLI 花掉你的账号额度。威胁模型与边界见 [SECURITY.md](SECURITY.md)。

## 这是什么

- **vault 编辑与草稿**：服务端按项目配置解析章节树；只有正文树、草稿目录、项目显式声明的侧栏 Markdown 文件，以及 `graph.relationsFile` 指向的关系图文件，能走文档 API——四类都可读可写，写入统一走同一套按 SHA256 校验的乐观锁。草稿目录由配置项 `draftsDir` 决定，写入 vault 内、与 Obsidian 双向可见。
- **侧栏与线程**：设定索引、角色、写作状态、伏笔的结构化 DTO；外部改动的 WebSocket 通知；锚点、修订、AI 对话线程与运行记录。writer 视角的 DTO 会过滤掉项目配置的 `authorOnlyMarkers` 列表标记的作者专属内容（不是某个固定字符串——示例 vault 里用的标记是 `"Author only"`，实际文本由项目自定义）。
- **改写与版本**：结构化改写先进入只读 diff，用户确认后才落进编辑器 buffer；正文仍需再次显式保存才写回 vault。改写前内容、AI 候选、保存内容都按 SHA 存进面板 SQLite，版本历史可对比、可恢复。
- **canon 冲突检查**：`/api/projects/:pid/documents/:docId/conflict-check` 是一条已注册的实际路由，web 端有完整面板（`ConflictFindingsPanel`）。这条线之外，「AI 自动提出设定变更建议」目前确实没有实现。
- **Agent 后端**：内置 `echo`（无需外部 CLI，任意平台可用，适合冒烟测试）以及对 Claude Code、Codex、OpenCode、Grok CLI、Pi 五个外部 CLI 的适配。写手（writer）profile 在满足二进制、鉴权和文件系统沙箱条件时对所有外部 CLI 一视同仁地开放，含 Codex；规划（planner）profile 对所有外部 CLI 目前一律 fail-closed，不会调用 CLI 也不会读 vault。
- **WorldGraph 关系图**：项目声明 `graph` 配置后启用只读关系图，语义关系只来自显式 Markdown 表格；默认是当前文档相关实体的局部 2D 图，可切到全局 3D 或无 WebGL 的分页列表。作者视角与 writer 安全视角分别由服务端生成，图数据不会自动进入 AI 上下文。细节见 [WorldGraph 设计文档](docs/design/2026-07-22-worldgraph.md)。

## 你需要什么

- Node.js ≥ 22
- pnpm 11.5.2（仓库用 Corepack 声明了精确版本，`corepack enable` 后自动拿到对应版本）
- 一个想拿来写作的 Markdown vault（没有也行，仓库自带最小示例）
- macOS，如果你要用 Claude、OpenCode、Grok 写作——这三个 CLI 的写手权限始终依赖 macOS 专有的 `sandbox-exec`（Seatbelt），非 macOS 平台上不会被虚报成可用。Codex 默认（`seatbelt` 模式）同样依赖它；把 `WRITING_STUDIO_CODEX_SANDBOX` 设成 `native` 可以换成 Codex 自身的 permission profile、从而不再要求 macOS，但隔离效果随之变成 Codex 自己的沙箱，见 [SECURITY.md](SECURITY.md)。`echo`、`pi` 不受此限制，任意平台可用

## 安装

```bash
git clone <this-repo-url>
cd writing-studio
corepack enable
pnpm install
```

## 首次运行

clone 后可以直接 `pnpm dev`：如果还没有 `data/registry.json`，服务端会正常启动，`GET /api/projects` 返回空数组，不扫描也不修改任何 vault。想看到内容，先登记一个项目：

```bash
cp data/registry.example.json data/registry.json
pnpm dev
```

`registry.example.json` 默认启用仓库自带的最小示例 vault（`examples/basic-vault`）：一章正文、一份设定索引、一张角色卡、一份写作状态记录、一份两节点的关系网，全部是自描述占位内容，不是任何真实小说。写作状态文件不是装饰性的——`graph.stopSourceId` 指向它，缺了这份文件关系图会无法解析停点，请求 writer 安全视角会直接报错。想从空列表开始，把这条目的 `enabled` 改成 `false`。

## 指向你自己的 vault

有两种方式登记一个真实项目。

**方式一：手写 registry 条目。** 编辑 `data/registry.json`，新增一条指向你 vault 的记录，再在 vault 内放一份 `.writing-studio/project.json`（可从 `examples/basic-vault/.writing-studio/project.json` 复制后按自己的目录结构调整）。两处的项目 id 必须一致。

**方式二：用脚手架命令生成空骨架并自动登记：**

```bash
pnpm --filter @writing-studio/server create-project -- \
  --id my-novel --name "项目显示名" --vault /absolute/path/to/your-vault --locale zh-CN
```

`--locale` 接受 `zh-CN`（默认）或 `en`；参见上面「先看这两条」——它只改变侧栏小节标题（含 WorldGraph 用来定位停点段落的标题名）和 lint 规则包这两处，不会让界面或 AI 提示词变成英文。骨架里的设定索引与角色卡示例条目只是待填标记，填入真实内容或把示例复制到注释外之后请删掉标记本身。新项目的写作状态停点默认为空：planner 能看到完整关系图，外加一条「还没有停点」的提示；writer 安全投影在停点解析出来之前始终是空的。只有在停点段落写入明确的章节引用后，writer 投影才会开始放出截至该处的内容——单独新建第一章不会自动推进停点。

`vaultRoot` 可以写绝对路径，也可以写相对 `registry.json` 所在目录的路径。

手写或改过 `project.json` 之后，可以用 `pnpm --filter @writing-studio/server validate-config -- <绝对路径的 vault 根目录> [--json]` 单独校验它——只读检查 schema 和跨字段约束（比如 `graph.stopSourceId` 能否解析），不修改任何文件。

## 配置一个项目

vault 内的 `.writing-studio/project.json` 声明这个项目的一切结构性设定，常用字段（下面是节选，不是可直接复制落盘、通过 schema 校验的完整文件——完整字段见文末链接）：

```jsonc
{
  "schemaVersion": 1,
  "id": "项目标识符，须与 registry 条目一致",
  "displayName": "项目显示名",
  "localePreset": "zh-CN",           // 或 "en"；见上面的说明
  "contentTree": { "root": "正文目录名", "levels": [ /* 章节树层级模式 */ ] },
  "draftsDir": "草稿目录名",
  "sidebarSources": [ /* 侧栏数据源：设定索引、角色卡、写作状态等 Markdown 文件的解析规则 */ ],
  "graph": { "schemaVersion": 1 /* 可选，声明后启用只读关系图 */ },
  "aiProfiles": {
    "writer": { "readable": ["允许 AI 读取的 glob"], "forbidden": [], "contextSources": ["自动注入的侧栏数据源 id"] },
    "planner": { "readable": ["..."], "allowVaultBrowsing": true },
    "defaultProfile": "writer"
  },
  "defaultAgentId": "默认使用的 agent id，如 echo"
}
```

几个安全相关的字段值得记住：

- `aiProfiles.<name>.readable` / `forbidden`：glob allow/deny，deny 始终优先。
- `contextSources`：每轮自动注入模型上下文的侧栏数据源，内容统一经 writer DTO 过滤，原始文本源不能自动注入。
- `lint`：自定义 style 规则、按 id 禁用内置规则、替换成语堆叠检测词表。
- `graph`：需要自己的 `schemaVersion`（当前 1）、关系文件路径，以及可解析停点的数据源 id；不配置就不暴露关系图入口。

写作状态数据源（`sidebarSources` 里 `parserConfig.kind` 为 `writingStatus` 的条目）按 `parserConfig.sectionHeadings` 里的标题名去写作状态文件里找对应小节；不写这个字段时，各小节按 `localePreset` 对应语言的默认标题匹配（`zh-CN` 下故事线小节默认标题是「故事线」，其余小节同理）。如果你的写作状态文件用了别的标题——不管是历史遗留还是自定义习惯——把实际标题填进 `sectionHeadings.storylines`（以及其他对应字段：`stopPoint`、`activeForeshadow`、`characterOneLiners`、`redLines`、`expressionBaseline`），解析才认得出来。

完整字段和默认值以 `examples/basic-vault/.writing-studio/project.json` 与 `packages/contract` 里的 zod schema 为准。

## 运行

```bash
pnpm dev          # 并行启动 server + web，开发模式
pnpm build        # web 生产构建
```

常用环境变量覆盖：

```bash
WRITING_STUDIO_DATA_DIR=/absolute/path      # 面板自有数据（SQLite、registry）的落盘位置，默认仓库内 data/
WRITING_STUDIO_REGISTRY_PATH=/absolute/path/to/registry.json   # 只改 registry 文件位置
WRITING_STUDIO_PORT=8787                    # server 端口
WRITING_STUDIO_WEB_PORT=5183                # web 端口，Vite 会把 API/WebSocket 代理到上面的 server 端口
WRITING_STUDIO_RUN_TIMEOUT_MS=600000        # 对话/改写等单次 Agent CLI 调用超时，默认 300000（5 分钟）
WRITING_STUDIO_GENERATE_TIMEOUT_MS=900000   # 整章生成（generate 来源的 run）超时，默认 600000（10 分钟）
```

不要提交个人的 `data/registry.json` 或任何 `.sqlite` 文件，`.gitignore` 已经排除了它们，唯一保留的模板是 `data/registry.example.json`。

正文编辑器优先使用本机安装的 `LXGW WenKai`（霞鹜文楷），未安装时依次回退到思源宋体、系统宋体。不联网加载字体，想用就自行安装。

## 接一个 AI 后端

内置 `echo` 后端不需要任何外部程序，适合先跑通整条 UI/API 流程。要接真实模型，给对应 CLI 配置可执行文件路径：`WRITING_STUDIO_CLAUDE_PATH`、`WRITING_STUDIO_CODEX_PATH`、`WRITING_STUDIO_OPENCODE_PATH`、`WRITING_STUDIO_GROK_PATH` 默认从 `PATH` 按裸命令名查找；`WRITING_STUDIO_PI_PATH` 默认是 `~/.local/bin/pi`（绝对路径，不查 `PATH`）。所有路径都可以显式覆盖：

```bash
WRITING_STUDIO_CLAUDE_PATH=/path/to/claude \
WRITING_STUDIO_CODEX_PATH=/path/to/codex \
WRITING_STUDIO_CODEX_SANDBOX=seatbelt \
WRITING_STUDIO_OPENCODE_PATH=/path/to/opencode \
WRITING_STUDIO_GROK_PATH=/path/to/grok \
WRITING_STUDIO_PI_PATH=/path/to/pi \
pnpm dev
```

`/api/agents` 返回每个 CLI 的实时探测结果，选择器只会启用真正可用的组合，不会虚报。几个要点：

- Claude、OpenCode、Grok 的写手权限始终依赖 macOS 的 `sandbox-exec`；`sandbox-exec` 不可用（非 macOS，或本机环境不支持）时，`/api/agents` 会把这些 CLI 报成不支持任何 profile，不会弱化权限继续跑。
- Codex 默认模式（`seatbelt`）同样依赖 `sandbox-exec`，规则同上。`WRITING_STUDIO_CODEX_SANDBOX` 接受 `seatbelt`（默认）或 `native`；`native` 使用 Codex 自身的 permission profile、完全不再套外层 `sandbox-exec`——包括在 macOS 上——所以 `native` 模式下 `sandbox-exec` 是否可用、当前平台是不是 macOS，都不影响 `/api/agents` 报出的可用性。这个权衡（隔离效果变成 Codex 自己的沙箱）应只在你自己验证过之后再启用，细节见 [SECURITY.md](SECURITY.md)。
- Pi 后端不经过 `sandbox-exec`，在任意平台都可用，但也因此完全依赖 `pi` 这个 CLI 自己的沙箱与权限机制——它提供多少隔离，writing-studio 就只有多少。
- 所有外部 CLI 的 planner（规划）profile 目前一律 fail-closed，不调用 CLI，不读 vault。

模型目录只是选择器提示，不是白名单。想覆盖某个 agent 的预设模型列表，在面板数据目录（`WRITING_STUDIO_DATA_DIR`，默认 `data/`）新增 `agent-models.json`：

```json
{
  "opencode": [
    { "id": "provider/model-id", "label": "自定义显示名", "isDefault": true }
  ]
}
```

安全模型与凭据边界（哪些进程能读写你的 vault、AI CLI 用谁的凭据跑）见 [SECURITY.md](SECURITY.md)。

## 测试

```bash
pnpm typecheck    # 全仓类型检查（contract 变更的门禁）
pnpm test         # contract + server + web 全部工作区的测试
pnpm verify       # typecheck → build → test，按顺序跑
```

CI 有两条 lane：`macos-14` lane 跑的就是完整 `pnpm verify`（typecheck → build → test），是权威的全量校验；`ubuntu-latest` lane 每次 push/PR 都跑，但只执行 `pnpm -r typecheck` 加 contract、web 两个工作区的测试，不 build、也不跑 server 测试（server 的 Seatbelt 沙箱测试需要 macOS）。本地想复现哪条 lane，对应跑 `pnpm verify` 或按上面的范围手动跑子集。

`apps/server` 里有一部分测试直接练习 macOS 的 Seatbelt 沙箱，在非 macOS 平台或本机 `sandbox-exec` 不可用时会自我跳过；测试整体通过、但有条目显示 skipped 是预期结果，不代表覆盖率下降。

图布局的墙钟性能基准默认 skip（共享 CPU 环境下不稳定），独占机器上设 `WRITING_STUDIO_PERF=1` 启用；CI 的 macOS lane 已经默认开启。

三个测试文件（`apps/server/test/context.test.ts`、`apps/server/test/sidebar.test.ts`、`packages/contract/test/schemas.test.ts`）还会读 `WRITING_STUDIO_LOCAL_VAULT`。设成你自己一个真实 vault 的绝对路径，这几个文件会额外跑一组针对那个 vault 的冒烟检查；不设就干净跳过——同样不是覆盖率下降，只是个大多数贡献者不需要配的可选项。

## 参考文档

- [SECURITY.md](SECURITY.md) — 威胁模型、身份验证边界、沙箱平台限制、AI CLI 凭据模型
- [CONTRIBUTING.md](CONTRIBUTING.md) — 开发环境、`pnpm verify`、工作区结构
- [docs/design/2026-07-22-worldgraph.md](docs/design/2026-07-22-worldgraph.md) — WorldGraph 关系图的 Markdown 正典格式、时间语义、安全投影
- [docs/design/2026-07-24-context-menu.md](docs/design/2026-07-24-context-menu.md) — 面板内右键菜单的组件、定位与各交互面规范
- `examples/basic-vault/` — 最小可运行的 vault 模板，含项目配置示例

## License

[MIT](LICENSE)
