# WorldGraph 关系网机制

- 日期：2026-07-22
- 范围：通用 Writing Studio 功能规范，适用于任意项目
- 真相源：vault 内由 `graph.relationsFile` 指向的关系文件（zh-CN 脚手架默认 `关系网.md`，英文示例是 `relationship-graph.md`）；SQLite 不保存第二份图数据

## 1. 产品边界

功能范围是“只读关系图 + 编辑关系文件”：用户在图中浏览、筛选、定位出处；修改关系时关闭图，用现有编辑器改 `relationsFile` 指向的 Markdown。图内不提供新增、删除、拖线、表单写回或 AI 提案队列。

普通 Obsidian wikilink 不自动成为语义关系。WorldGraph 只借用 Obsidian Graph View 的全局图、局部图、邻接深度、筛选、方向表达和力参数交互；wikilink 在本设计中仅表示时间或出处证据。

默认视图是当前文档相关实体的局部二维图，邻接深度默认 1、可调至 3。当前文档命中多个实体时使用多中心种子；没有命中时显示搜索入口，不擅自选择最高度节点。用户可按需切换全局三维图。

WorldGraph 首版是 UI-only：不自动进入 Agent 上下文，也不声称“写手视角预览”等同于 Agent 的实际上下文。作者 UI 显式请求 `planner`；安全预览重新请求 `writer`，绝不在客户端从 planner 数据中过滤。

## 2. Markdown 正典格式

`ProjectConfig.graph.relationsFile` 指向唯一关系真相源。文件支持四个 GFM 表格章节，其中只有“关系”章节必需。内置中英文节名及表头见 contract 的 `DEFAULT_GRAPH_MARKDOWN_ALIASES`；项目配置的 aliases 只追加本地别名，不替换内置别名。

```markdown
# 关系网

## 节点类型

| ID | 名称 | 视觉族 |
| --- | --- | --- |
| character | 人物 | character |

## 关系类型

| ID | 名称 | 视觉族 | 有向 | 反向名称 |
| --- | --- | --- | --- | --- |
| ally | 盟友 | custom | false | 盟友 |
| owns | 持有 | item | true | 持有者 |

## 节点

| ID | 名称 | 别名 | 类型 | 生效章 | 揭示章 | 失效章 | 可见性 | 置信 | 出处 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| char:roleA | 角色A | RoleA | character | @start | [[正文/第一部/第1章.md\|第1章]] | | public | confirmed | [[角色设定.md#角色A\|角色A]] |
| char:roleB | 角色B | RoleB | character | @start | [[正文/第一部/第3章.md\|第3章]] | | public | confirmed | [[角色设定.md#角色B\|角色B]] |

## 关系

| ID | 源 | 关系 | 目标 | 生效章 | 揭示章 | 失效章 | 可见性 | 置信 | 出处 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| rel:r001 | @char:roleA | ally | @char:roleB | [[正文/第一部/第3章.md\|第3章]] | [[正文/第一部/第5章.md\|第5章]] | | public | confirmed | [[正文/第一部/第5章.md#示例小节\|第5章]] |
```

通用英文模板位于 `examples/basic-vault/relationship-graph.md`。

### 2.1 ID、类型与端点

- 显式节点和所有关系必须有稳定 ASCII ID，例如 `char:roleA`、`rel:r001`。ID 可使用 ASCII 字母、数字、`. _ : / -`，长度不超过 128；重命名显示名称不得改变 ID。
- 节点类型和关系类型也是自由 ASCII ID。项目可以定义任何叙事语义；contract 不固定中文枚举。
- `视觉族` 仅影响颜色和图例，值限于 `character | faction | place | item | event | skill | species | rule | foreshadow | custom | unknown`。未声明类型或未知视觉语义归入 `custom/unknown` 并产生诊断，不丢弃原数据。
- 关系方向由关系类型定义。`有向` 使用 `true/false`；无向关系应填写 `false`。详情面板用 `反向名称` 描述有向边的逆向阅读；无向关系可复用正向名称。
- 关系端点优先写 `@ID`。也接受唯一名称或别名。零匹配时生成稳定 `implicit:<hash>` 节点并告警；多匹配时产生错误诊断并拒绝该关系。
- `别名` 与多个 `出处` 使用半角或全角分号分隔；解析后去除首尾空白并去重。
- GFM 表格单元格内 wikilink 的 alias 分隔符必须写成 `\|`；解析器在拆列后还原为标准 Obsidian `|`。

### 2.2 时间语义

三个时间字段互不替代：

- `activeFrom` / `生效章`：实体或关系何时在故事世界中生效。
- `inactiveFrom` / `失效章`：从哪个故事点起失效，采用独占语义。
- `revealedAt` / `揭示章`：正文何时向写手或读者揭示，是安全投影门禁。

时间值可写精确章节 wikilink、`@start` 或留空。`@start` 表示故事开始前已经成立；空白表示未知，绝不自动解释为故事开始。数字简写只在 `contentTree.leaf.numberingScope=book` 且章号唯一时接受；`perLevel` 项目必须使用精确 docId/wikilink。

服务端把章节树展平为稳定的 `StoryPoint { docId, order, label, chapterNo }`。所有比较使用 `order`，`chapterNo` 只是显示信息，允许重复。若 `inactiveFrom.order <= activeFrom.order` 或揭示/生效引用无法解析，输出结构化诊断。

### 2.3 安全字段与出处

- `可见性`：`public | authorOnly`。
- `置信`：`confirmed | inferred | question`。
- writer 只接收 `public + confirmed`，且还必须通过时间和出处门禁。
- 出处必须使用精确 Obsidian wikilink，例如 `[[正文/第二部/第71章.md#某标题|第71章]]`。普通字符串不提升为文件权限。
- 出处解析为 `GraphSourceRef { docId, heading, label }`。重复标题、标题不存在或文件不存在均产生诊断；不靠模糊标题猜测。

## 3. Contract Interface

公共类型位于 `packages/contract/src/graph.ts`。语义 DTO 包含：

- `GraphView`、`GraphVisibility`、`GraphConfidence`、`GraphVisualFamily`
- `StoryPoint`、`GraphStoryTime`、`GraphSourceRef`
- `NodeTypeDefinition`、`RelationTypeDefinition`
- `WorldNode`、`WorldEdge`
- `GraphDiagnostic`、`WorldGraphCounts`、`WorldGraphSnapshot`
- `GraphSourceExcerpt`

`WorldNode` 与 `WorldEdge` 都保留 `activeFrom`、`revealedAt`、`inactiveFrom`、安全字段和结构化出处。不存在单一 `unresolved` 字段；伏笔状态由时间切片和关系语义推导。

DTO 不含 `x/y/z/color/size`。布局、颜色、节点尺寸、相机和抽样属于前端当前视图的推导值，不能污染语义 Interface。

`WorldGraphSnapshot` 是一次安全投影的完整快照：

```ts
interface WorldGraphSnapshot {
  view: 'writer' | 'planner';
  version: string;                 // 当前投影独立的 SHA-256
  stopPoint: StoryPoint | null;    // resolved writer 快照必须非空；unset 时为 null
  stopState: 'resolved' | 'unset'; // unset=尚无停点合法空态（writer 得零泄露空投影）
  storyPoints: StoryPoint[];
  nodeTypes: NodeTypeDefinition[];
  relationTypes: RelationTypeDefinition[];
  nodes: WorldNode[];
  edges: WorldEdge[];
  counts: { nodeTypes: number; relationTypes: number; nodes: number; edges: number };
  diagnostics: GraphDiagnostic[];  // 最多 200 条
  diagnosticCount: number;         // 截断前诊断总数
}
```

`counts` 必须等于本投影返回数组的长度，不得携带 planner 原图总数。`version` 在完成安全投影并重新计算目录、数组、数量与诊断后生成，不能复用源文件 SHA 或另一种 view 的缓存键。

### 3.1 可选项目配置

```json
{
  "graph": {
    "schemaVersion": 1,
    "relationsFile": "relationship-graph.md",
    "stopSourceId": "writing_status",
    "typeSources": [
      { "sourceId": "characters", "defaultTypeId": "character" },
      {
        "sourceId": "setting_index",
        "sectionTypeIds": { "Places": "place", "Factions": "faction" }
      }
    ],
    "aliases": {
      "sections": { "relations": ["Relationships"] },
      "relations": { "revealedAt": ["Revealed in"] }
    }
  }
}
```

- `graph` 整节可选；未配置时服务端和 Web 完全隐藏功能。
- `relationsFile` 是以 `.md` 结尾的 vault-relative POSIX 路径，并单独加入现有 document allowlist，因此只有它获得现有乐观锁 PUT 权限；出处不会因此获得 PUT 权限。
- 所有图路径（`relationsFile`、`GraphSourceRef.docId` 与传输层 `docId`）都使用 canonical vault-relative POSIX docId：拒绝绝对路径、空段、`.`/`..` 段、反斜杠和 control characters。已有文件经 `realpath` 取得其物理拼写后再作为返回 docId；不会以 basename 或宽松大小写猜测替代。
- 解析任一现有路径时，只要路径链上出现 symlink 就 fail closed，即使它最终仍在 vault 内；这样 allowlist、writer profile 与出处授权都不会通过别名绕过。
- `stopSourceId` 必须指向现有 `writingStatus` sidebar source。writer 停点重复或无法映射为唯一 `StoryPoint` 时返回 422，不回退到最新章；停点未设置（停点段为空且无数值停点）是合法空态——返回 200 + `stopState:'unset'`，writer 得到零泄露空投影。
- `typeSources` 只引用现有结构化、可产出节点名称的 sidebar source。每项至少定义 `defaultTypeId` 或 `sectionTypeIds`；`sectionTypeIds` 对规范化 section path 采用最长前缀匹配（例如 `一、地理` 可匹配 `一、地理 > 1.2 水系`）；重复 source ID 配置无效。
- `aliases` 所有层级 strict，数组不得为空；未知键使项目配置无效，防止拼写错误静默失效。

### 3.2 传输 Interface

```text
GET /api/projects/:pid/graph?view=writer|planner
GET /api/projects/:pid/sources/:docId?heading=...&view=writer|planner
WS  graph.updated
```

- `view` 省略时始终默认 `writer`。
- 图端点返回 `WorldGraphSnapshot`。无 graph 配置返回 `NOT_FOUND`；writer 停点无效返回 `GRAPH_STOP_POINT_INVALID`（HTTP 422）；超过硬上限返回 `GRAPH_TOO_LARGE`（HTTP 422）。
- source 端点返回 `GraphSourceExcerpt { source, markdown, truncated }`，单次最多 12,000 字符。请求的 `{docId, heading}` 必须出现在当前 view 快照的结构化出处中，并再次通过 profile allow/deny；它不能作为任意 vault 文件浏览器。
- `graph.updated` 只有 `{ kind, seq }`，不携带节点名、路径、数量、view 或 version。客户端收到后重新请求自己当前的 view；WS 重连也重新读取。

## 4. 深层 WorldGraphModule

WorldGraph 的外部 Seam 只暴露投影快照、受限出处和失效通知。REST、Web 与测试依赖同一个深层 Module Interface，不直接调用解析器、缓存或 watcher：

```ts
interface WorldGraphModule {
  snapshot(view: GraphView): Promise<WorldGraphSnapshot>;
  sourceExcerpt(ref: GraphSourceRef, view: GraphView): Promise<GraphSourceExcerpt>;
  subscribeInvalidation(listener: () => void): () => void;
}
```

具体方法名可按 server 代码风格调整，但 Interface 的三项能力和错误模式必须保持。该 Depth 给调用者的 Leverage 是“一次调用即得到可传输的安全快照”；Locality 是解析、时间线、安全投影、诊断、缓存和监听都在一个 Implementation 内验证。REST 与 WS 是薄 Adapter，不另做业务过滤。

内部顺序固定：

1. 读取关系文件和配置声明的结构化 sidebar 来源。
2. 解析表格、稳定 ID、名称/别名、类型、时间和精确出处。
3. 构造 planner 原图与完整结构化诊断。
4. 按 `view` 执行服务端安全投影。
5. 对投影后数据重新计算类型目录、节点、边、数量和安全诊断。
6. 对当前投影生成独立稳定 version hash，并写入按 `projectId + view + source identities` 隔离的缓存。

监听关系文件、章节树、停点 source 与声明的 typeSources。原子替换、父目录恢复、SHA 相同的自写回声都必须正确去重；任何真实变化只广播无数据失效通知。

## 5. writer 安全投影

writer 投影必须在服务端同时满足：

- 节点和边为 `public + confirmed`。
- `revealedAt` 存在且不晚于停点。
- `activeFrom` 为 `@start` 或存在且不晚于停点；未知时间默认排除。
- `inactiveFrom` 已发生时排除对象；未来失效时间若对象仍可见，返回值改为 `null`，不泄漏具体未来点。
- `storyPoints` 只返回停点及更早的条目；不泄漏未来章节的标题、docId 或数量。
- 边的两个端点都已通过 writer 节点门禁；过滤边后再次裁剪不再被任何可见边引用的隐式节点。
- 每个出处匹配 writer profile 的 `readable`，且不命中 `forbidden`；deny 始终优先。
- authorOnly-only 端点、隐藏关系类型、未来/隐藏来源、planner 原图计数、伏笔解决状态和 planner diagnostics 全部移除。
- 类型目录只包含投影后节点/边实际引用且可安全展示的定义。

停点重复、悬空或无法解析时 fail closed，返回明确 422；停点未设置返回 200 + `stopState:'unset'`（planner 完整图 + warning 诊断，writer 空投影）。writer 和 planner 缓存必须双向隔离；先请求任一 view 都不能污染后一请求。

## 6. 结构化诊断与规模

每条 `GraphDiagnostic` 包含 `code`、`severity`、`entityKind`、`entityId`、vault-relative `file`、一基 `line`、表格数据 `tableRow` 和人类可读 `message`。固定代码至少覆盖：

- `MISSING_COLUMN`、`INVALID_VALUE`、`DUPLICATE_ID`、`AMBIGUOUS_NAME`
- `UNDECLARED_TYPE`、`IMPLICIT_NODE`、`ORPHAN_NODE`
- `INVALID_STORY_POINT`、`INVERTED_TIME_RANGE`
- `SOURCE_NOT_FOUND`、`SOURCE_HEADING_NOT_FOUND`、`SOURCE_HEADING_AMBIGUOUS`
- `MISSING_SAFETY_FIELD`、`GRAPH_TOO_LARGE`

单个快照最多返回 200 条诊断，同时通过 `diagnosticCount` 报告总数。writer 只能看到该投影自身可安全生成的诊断，不能复用 planner 诊断。

服务端硬上限为 5,000 节点 / 15,000 边。超过时明确报错，不静默截断，也不返回部分快照。全局三维渲染预算为 1,000 节点 / 3,000 边；超过预算时 Web 明示采用以稳定 ID/version 为种子的确定性抽样。局部图的深度扩展始终从服务端完整快照计算，不从全局抽样结果计算。

## 7. Web 浏览与渲染

### 7.1 单一筛选管线

局部二维、全局三维和 DOM 列表必须消费同一个语义快照与同一个纯筛选结果。筛选覆盖实体类型、关系类型、置信、可见性、孤立节点和时间未知项；搜索覆盖名称、别名与类型名称。时间切片使用 `StoryPoint.order`，不能使用可能重复的 `chapterNo`。

图工作区覆盖现有 center，但 `EditorPane` 保持挂载并设为 `inert`，以保留未保存内容。Esc 关闭图并恢复先前焦点；“编辑关系数据”关闭图并打开 `relationsFile`。

可直接编辑的正文、sidebar 或 relationsFile 出处进入编辑器并定位唯一标题；其他允许的正典出处使用受限只读摘录抽屉。任何不允许的出处都不显示可执行跳转。

### 7.2 同一 R3F 渲染器

- `GraphViewShell` 与 Three 重型模块分级 lazy load，图依赖形成独立 chunk。
- 同一套 R3F Canvas、`InstancedMesh` 和 `LineSegments` 支持两种模式。
- 局部图：`d3-force-3d.numDimensions(2)`、`z=0`、正交俯视、平移缩放。
- 全局图：相同节点/边 buffer 切换 `numDimensions(3)`、透视相机与 OrbitControls；保留 x/y，并用稳定 ID 确定性生成初始 z，避免切换爆炸。
- 单击选择，双击重新居中。方向同时使用箭头或线型与详情文字表达，颜色不是唯一编码。
- 布局面板提供中心力、斥力、连接力、连接距离和恢复默认值；拖动期间节流，停止拖动 150ms 后再热。

### 7.3 性能、动效与降级

- D3 原地修改稳定布局对象；每 tick 只安排一次 node matrix 与 edge position buffer 同步更新和一次 `invalidate()`。
- R3F 使用 `frameloop="demand"`；模拟 settle 后停止 RAF。数据、筛选或力参数变化才再热。
- `devicePixelRatio` 上限 1.5；性能不足时优先降低 Bloom 和 DPR，不降低语义正确性。
- 未回收伏笔首版使用静态 halo，不运行持续脉冲。
- `prefers-reduced-motion` 禁用相机补间、damping、闪烁和持续动画。
- 无 WebGL2、上下文丢失或用户主动选择时，使用分页 DOM 关系列表。列表是可选择、可复制、可键盘操作的无障碍 Interface，不是第二套图渲染器。
- WebGL context loss 保留搜索、筛选、深度和当前选择，并自动切到列表。

图模块要求 React 19 与 R3F 9。`d3-force-3d` 没有官方类型包，仓库只声明实际用到的最小本地 `.d.ts`，不为整个库伪造类型。

## 8. 性能与验收要求

解析与时间：

- 支持中英文表头与自定义 aliases、自由关系类型、稳定 ID。
- 名称/别名唯一，歧义拒绝，零匹配生成隐式节点。
- 出处使用精确 wikilink；重复标题、缺失标题、多个出处均需正确处理。
- `numberingScope=perLevel` 下重复章号、`@start`、未知时间、失效点的独占边界需正确处理。

安全与缓存：

- planner→writer 与 writer→planner 两种缓存顺序互不污染。
- writer 投影的所有字段不含 authorOnly 内容、未来名称、未来数量、未来出处、未来失效点或 planner 专属诊断。
- forbidden 始终覆盖 readable；边的隐藏端点不会以孤立节点或类型计数形式残留。
- 停点重复、悬空、非法时 fail closed；停点未设置时返回 `stopState:'unset'` 合法空态（writer 空投影）。

文件与传输：

- `relationsFile` 编辑走既有的 stale-write 检测、原子写和版本历史机制。
- 原子替换、内容哈希去重、父目录恢复和 WS 重连后重新读取均需正确处理。
- `graph.updated` 通知不携带任何图数据。
- source excerpt 有界、只读、按 view 区分，且不扩大文档的 PUT 权限范围。

Web 与性能：

- 图打开期间编辑器未保存内容不丢失；Esc 关闭图与焦点恢复行为正确。
- 局部二维、全局三维、DOM 列表消费同一筛选结果。
- 渲染预算内（1,000 节点 / 3,000 边）：力导布局每帧计算 p95 ≤ 8ms，4 秒内收敛（settle），交互帧 p95 ≤ 16.7ms，收敛后不再产生连续渲染请求。
- Graph/Three 相关代码拆分为独立 chunk，不随编辑器首屏一起加载。
- 功能在断网环境下完整可用：不依赖 CDN、远程字体、额外网络端口或第三方图库运行时。

## 9. 超出范围

- AI 抽取与 proposal queue。
- 图内新增、删除、拖线和坐标持久化。
- 普通 Obsidian wikilink 自动关系层。
- Agent 图上下文注入。
- 跨 vault 联图。
- Neo4j、Cypher 或 SQLite 图数据库。
