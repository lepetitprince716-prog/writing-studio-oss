# 右键菜单体系设计（writing-studio 面板）

面板内所有自定义右键菜单共用同一套实现：`apps/web/src/components/ContextMenu.tsx`（组件 + `useContextMenu` hook）、`apps/web/src/lib/clipboard.ts`（复制工具）。样式在 `apps/web/src/styles/overlays.css`（`.context-menu*` 规则）与 `apps/web/src/styles/tokens.css`（`--shadow-lg`）。各交互面的菜单内容由纯函数生成，位于 `components/ContextMenu.tsx`（章节、草稿）、`components/thread-menu-specs.ts`（AI 消息、线程列表）、`components/sidebar/sidebar-menu-specs.ts`（正典侧栏词条）、`graph/graph-menu-specs.ts`（关系图列表）。

本文档描述这套右键菜单的行为规范：组件 API、定位与层级、键盘可达性、各交互面的菜单项与禁用条件，以及它与浏览器原生菜单、选区浮动条的分工边界。

---

## 1. 目标与非目标

### 1.1 目标

1. 用一个共享 `ContextMenu` 组件 + `useContextMenu` hook 承载面板内所有自定义右键菜单，全仓只有一套菜单代码、一套层级、一套关闭时机。
2. 覆盖六个交互面：章节树章节节点、章节树草稿、AI 消息、AI 线程列表项、正典侧栏词条、关系图列表行。
3. 菜单只承担「针对某个具体对象的低频动作」。高频动作留在既有可见控件上（工具栏按钮、选区浮动条、`CanonRepairButton`），右键不做它们的镜像。
4. 键盘完全可达（ARIA menu 模式），Escape/点击外部/滚动均可关闭，焦点可还原。

### 1.2 非目标

| 不做的面 | 理由 |
|---|---|
| **编辑器正文区（`.cm-content`）** | CodeMirror 编辑区是 contenteditable，原生右键提供撤销/剪切/复制/粘贴/拼写建议/输入法候选，其中「粘贴」在 Web 上无法用 JS 等价替代系统剪贴板读取。语义动作（提问/改写）由选区浮动条承担，两者不重复。编辑器一律放行原生菜单。 |
| **图谱 3D/2D 画布** | 画布上的 `MapControls`/`OrbitControls` 默认绑定右键手势（旋转/平移），自建右键需要改写 `mouseButtons` 并区分点击与拖拽。图谱只在列表视图（`GraphRelationList`）提供右键，那里没有手势冲突。 |
| **章节树目录节点** | 唯一有价值的项是「全部展开/折叠」，但目录展开状态是组件内 `useState`，要做这个需要先把整棵树改成受控，属于树重构而非菜单。 |
| **版本历史列表（`RevisionHistory`）** | 它在 Modal 内，现有按钮（恢复、导出溯源）已覆盖全部动作，右键只是重复入口。 |
| **项目列表 / 顶栏 / 生成工作区 beats** | 对象语义弱，没有 ≥2 个有意义的菜单项。 |
| **触屏长按触发** | 见 §2.7：不实现长按手势，只预留 API 扩展点。 |
| **多选 + 批量操作** | 全仓没有任何列表支持多选，多选是独立特性。 |
| **二级子菜单 / hover 展开** | 一级项 ≤8，不做嵌套。 |

---

## 2. 共享 ContextMenu 组件

### 2.1 API 形状

```ts
/** 一个可执行菜单项。 */
export interface ContextMenuItem {
  id: string;
  label: string;
  /** 返回 Promise 时组件不等待，菜单在触发瞬间即关闭。 */
  onSelect: () => void | Promise<void>;
  /** 危险项：红色文字 + 与其他项之间强制分隔线。每个菜单最多一个分组。 */
  danger?: boolean;
  disabled?: boolean;
  /** 禁用原因，渲染为 title；禁用项仍参与朗读但不参与方向键落点。 */
  disabledReason?: string;
  /** 右侧灰字，纯展示，组件不负责绑定该快捷键。 */
  hint?: string;
}

export interface ContextMenuSeparator {
  id: string;
  separator: true;
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuSeparator;

/** 打开一个菜单所需的全部信息。 */
export interface ContextMenuSpec {
  /** 屏读用，形如「第 12 章 · 操作」。 */
  label: string;
  items: ContextMenuEntry[];
}

export interface ContextMenuOpenState extends ContextMenuSpec {
  anchor: { x: number; y: number } | { rect: DOMRect };
  /** 键盘打开时首项自动聚焦；鼠标打开时不抢焦点直到用户按方向键。 */
  via: 'pointer' | 'keyboard';
  /** 关闭时把焦点还给它。 */
  restoreTo: HTMLElement | null;
}
```

Hook（每个使用方一个实例，状态留在组件局部，不进全局 store）：

```ts
export function useContextMenu(): {
  state: ContextMenuOpenState | null;
  /** 绑到列表项的 onContextMenu。内部处理 preventDefault / stopPropagation / Shift 放行。 */
  openFromEvent: (event: React.MouseEvent, spec: ContextMenuSpec) => void;
  /** 绑到列表项的 onKeyDown，响应 ContextMenu 键与 Shift+F10。 */
  openFromKeyboard: (event: React.KeyboardEvent, spec: ContextMenuSpec) => void;
  close: () => void;
};
```

组件：

```tsx
export function ContextMenu({
  state,
  onClose,
}: {
  state: ContextMenuOpenState | null;
  onClose: () => void;
}): React.JSX.Element | null;
```

调用侧的典型用法：

```tsx
const menu = useContextMenu();
// ...
<DraftSection onContextMenu={(e, draft) => menu.openFromEvent(e, draftMenuSpec(draft))} />
<ContextMenu state={menu.state} onClose={menu.close} />
```

`draftMenuSpec(draft)` 是一个纯函数，返回 `ContextMenuSpec`。菜单内容一律用纯函数构造，这样禁用条件、危险项、分隔线都能单测，不需要渲染 DOM。

### 2.2 定位策略（含视口边缘翻转）

1. **两遍渲染**。首帧以 `visibility: hidden; left: 0; top: 0` 挂载（portal 到 body，尺寸不受任何容器影响）。
2. `useLayoutEffect` 里 `getBoundingClientRect()` 拿到真实 `w/h`，在同一帧内 `setState` 提交最终坐标，用户看不到中间态。
3. 计算规则（`GAP = 8` 为视口内边距，`OFFSET = 2` 为指针偏移）：

```
锚点：pointer → (clientX, clientY)；keyboard → (rect.left, rect.bottom + 2)

水平：
  x = anchorX + OFFSET
  if (x + w > vw - GAP) x = anchorX - w - OFFSET      // 翻到指针左侧
  if (x < GAP)          x = GAP                        // 仍溢出则贴边

垂直：
  y = anchorY + OFFSET
  if (y + h > vh - GAP) y = anchorY - h - OFFSET      // 翻到指针上方
  if (y < GAP) {
    y = GAP
    maxHeight = vh - 2 * GAP                           // 菜单比视口还高：贴顶 + 内滚
  }
```

4. 键盘打开时用 `rect` 而非指针，菜单左对齐锚元素、贴其下沿；翻转规则相同。
5. **不追踪**：定位只算一次。滚动、resize、内容变化一律关闭而非重算——菜单是瞬时对象，追踪没有价值只有 bug。

菜单宽度：`min-width: 168px; max-width: 280px`，标签超长时 `text-overflow: ellipsis`（章节标题可能很长）。

### 2.3 Portal 与层级

菜单用 `createPortal(node, document.body)` 挂载到根层叠上下文，而不是内联渲染在触发它的面板子树里——面板容器本身有自己的层叠上下文，内部再高的 z-index 也只在容器内部排序，不会真正压过 Modal 或 Toast。

层级表（`overlays.css` 顶部注释）：

| 值 | 用途 | 层叠上下文 |
|---|---|---|
| 50 | modal-backdrop | 根（portal） |
| 60 | toast-host | 根（portal），高于 modal，保证 Modal 打开时复制/失败反馈仍可见 |
| 80 | context-menu | 根（portal） |

### 2.4 关闭时机

| 触发 | 监听方式 | 说明 |
|---|---|---|
| 点击菜单外部 | `document.addEventListener('pointerdown', handler, true)`（捕获） | 用 `menuRef.current.contains(e.target)` 判归属。用 `pointerdown` 而非 `click`，右键按下时就关掉上一个菜单，天然保证同时只开一个 |
| 点击菜单内某项 | 项自身 `onClick` 里先 `onClose()` 再执行 `onSelect()` | 顺序固定：先关后执行。若动作会弹 Modal（如删除确认），菜单必须已经不在，否则焦点还原会打架 |
| Escape | `document.addEventListener('keydown', handler, true)` + `event.stopPropagation()` | 捕获阶段拦下并阻止冒泡，全局 Escape 优先级链看不到这次 Escape。焦点还给 `restoreTo` |
| 滚动 | `window.addEventListener('scroll', close, true)`（捕获，覆盖所有可滚动祖先） | 直接关，不重算 |
| resize / window blur | `resize` + `blur` → close | |
| 文档/项目切换 | 调用侧 `useEffect(() => menu.close(), [activeDocId, activeProjectId])` | 局部 state 不会随文档/项目切换自动清空，调用侧需显式处理 |
| 组件卸载 | hook 的 cleanup | 窄视口抽屉关闭会卸载面板 |

不做的：不做「移出菜单 N 毫秒自动关」（无子菜单，没必要）；不做点击遮罩层关闭（不加遮罩层，见 §2.6）。

### 2.5 键盘可达（ARIA menu 模式）

结构：

```html
<div class="context-menu" role="menu" aria-label="{spec.label}" tabindex="-1">
  <button type="button" role="menuitem" tabindex="-1" class="context-menu-item">…</button>
  <div class="context-menu-separator" role="separator"></div>
  <button type="button" role="menuitem" tabindex="-1"
          class="context-menu-item danger" aria-disabled="true" title="{disabledReason}">…</button>
</div>
```

行为（roving focus，用真实 DOM 焦点）：

| 按键 | 行为 |
|---|---|
| `ArrowDown` / `ArrowUp` | 在未禁用项之间移动，两端循环。禁用项跳过 |
| `Home` / `End` | 首个/最后一个未禁用项 |
| `Enter` / `Space` | 激活当前项 |
| `Escape` | 关闭 + 焦点还原 |
| `Tab` / `Shift+Tab` | 关闭 + 焦点还原，然后不阻止默认，让 Tab 从触发元素继续走 |

焦点策略：

- `via: 'keyboard'` → 打开即聚焦首个可用项。
- `via: 'pointer'` → 不抢焦点，容器 `tabIndex={-1}` 且首帧后聚焦落在容器上；用户按 `ArrowDown` 时才移到首项。
- 打开时 `restoreTo = document.activeElement`，关闭时把焦点还给它。
- 不做 Tab 陷阱：菜单不是模态，Tab 应该逃出去。

触发入口（除 `onContextMenu` 外）：`Shift + F10`（Windows/Linux 惯例）与 `ContextMenu` 键，两者都在 `openFromKeyboard` 里处理。macOS 没有这两个按键的惯例映射，但列表项都是可 Tab 到的按钮，Tab + Enter 已能打开对应对象，不额外映射快捷键。

### 2.6 视觉与样式

```css
/* overlays.css */
.context-menu {
  position: fixed;
  z-index: 80;
  min-width: 168px;
  max-width: 280px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-raised);
  box-shadow: var(--shadow-lg);
  overflow-y: auto;            /* 超高时贴顶内滚，见 §2.2 */
}
.context-menu-item { /* … */ }
.context-menu-item:hover,
.context-menu-item:focus-visible { background: var(--accent-soft); outline: none; }
.context-menu-item[aria-disabled='true'] { color: var(--muted); cursor: default; }
.context-menu-item[aria-disabled='true']:hover { background: transparent; }
.context-menu-item.danger { color: var(--danger); }
.context-menu-separator { height: 1px; margin: 4px 6px; background: var(--border); }
.context-menu-hint { float: right; margin-left: var(--space-4); color: var(--muted); font-size: var(--fs-xs); }
```

全部走 tokens 变量，零字面色值。

不加遮罩层：菜单用捕获阶段的 `pointerdown` 就够关闭判定，加遮罩会吞掉「点外部同时选中外部元素」这个正常预期。

### 2.7 触屏降级

不实现长按手势，但把 API 口子留好：`ContextMenuOpenState.anchor` 已支持 `{ rect }` 形式，未来的长按或「⋯」按钮只需构造一个 rect 调 hook 即可，组件本身不用改。若未来要做，推荐方案是在 `(pointer: coarse)` 下给列表项渲染一个「⋯」按钮调用同一个 spec——可发现、可命中、零手势冲突。

### 2.8 与浏览器原生菜单共存（精确放行判定）

`openFromEvent` 的第一步是放行判定，判定为放行时直接 return、不 `preventDefault`，浏览器照常弹原生菜单：

```ts
const NATIVE_MENU_SELECTOR =
  'input, textarea, select, [contenteditable="true"], [contenteditable=""], .cm-editor, a[href]';

function shouldYieldToNative(event: React.MouseEvent): boolean {
  // 1) 逃生门：按住 Shift 右键 → 永远给原生（用户可用它取回「检查元素」）
  if (event.shiftKey) return true;

  const target = event.target;
  if (!(target instanceof Element)) return true;   // 保守：非元素目标一律放行

  // 2) 文本输入 / 可编辑区 / 链接 → 原生（撤销、粘贴、拼写、输入法候选、复制链接地址无法替代）
  //    .cm-editor 覆盖整个 CodeMirror 实例，含 EditorPane 与 RevisionHistory 的 MergeView
  if (target.closest(NATIVE_MENU_SELECTOR)) return true;

  // 3) 用户当前有跨元素的文本选区，且右键点在选区内 → 原生（用户意图是复制这段文字）
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && selection.containsNode(target, true)) return true;

  return false;
}
```

规则取舍：

- 规则 2 的 `.cm-editor` 覆盖 `RevisionHistory` 的只读 MergeView，那里用户想复制旧版本文字，原生菜单正合适。
- 规则 3 用 `containsNode(target, true)`（partial 匹配）而不是精确 range 命中测试：用户先划词再右键，几乎总是点在选中区里。
- 规则 1 的 Shift 逃生门需要让用户知晓，否则会以为「检查元素」没了。

反过来，列表项即使显示的是文本也走自建菜单（章节标题、词条名、AI 消息），因为「复制这段文字」的需求由菜单里的「复制 X」项显式满足，语义比原生的「复制」更准（复制标题而不是复制标题里被误选的三个字）。

### 2.9 与选区浮动条的分工

| | 选区浮动条（`.selection-bubble`） | 右键菜单 |
|---|---|---|
| 触发对象 | 编辑器里的一段文字 | 列表里的一个对象（章节 / 消息 / 词条 / 关系） |
| 触发方式 | 划词后自动出现 | 显式右键 |
| 承担动作 | 提问、改写（对选中文本发起 AI 线程） | 打开、复制、跳转、删除、重命名 |
| 是否重叠 | 零重叠：浮动条不做复制/删除，菜单不做「对选区提问」 | |

判定规则：动作的对象是「一段文字」就归浮动条，是「一个实体」就归右键菜单。编辑器里没有实体，所以编辑器没有右键菜单；列表里没有自由选区，所以列表没有浮动条。

菜单项统一在 `onMouseDown` 上 `preventDefault`：正典侧栏与线程面板都紧邻输入框，点菜单项若导致输入框失焦会丢掉未提交内容。

---

## 3. 面 × 动作矩阵

统一约定：每面 ≤8 个一级项，无子菜单；「切换文档」类动作共享同一组禁用条件（`running` 时置灰并给出 `disabledReason`，因为打开文档本身在 AI 运行中会被拦截）；剪贴板统一走 `apps/web/src/lib/clipboard.ts`。

### 3.1 章节树 · 章节节点

| # | 菜单项 | 说明 | 禁用条件 |
|---|---|---|---|
| 1 | 打开 | 打开该章节文档 | 已是当前文档 / AI 运行中 |
| 2 | 打开并查看版本历史… | 打开文档后展开版本历史面板 | AI 运行中 |
| 3 | 重命名章节… | 打开输入框 Modal，提交后调用重命名接口，正文与文件路径同步更新 | AI 运行中 / 项目未配置章节标题识别规则 / 当前文档有未保存修改 |
| 4 | 对整章提意见 | 打开文档后发起一个针对全文的 AI 线程 | AI 运行中 |
| — | *分隔线* | | |
| 5 | 复制章节标题 | | 无 |
| 6 | 复制文档路径 | | 无 |

不提供「删除」：正式章节没有回收站，误删无法找回。

### 3.2 章节树 · 草稿

| # | 菜单项 | 说明 | 禁用条件 |
|---|---|---|---|
| 1 | 打开 | | 已是当前文档 / AI 运行中 |
| 2 | 对整章提意见 | | AI 运行中 |
| — | *分隔线* | | |
| 3 | 复制标题 | | 无 |
| 4 | 复制文档路径 | | 无 |
| — | *分隔线（危险分组）* | | |
| 5 | 删除草稿… | 移入草稿目录下的 `.trash`，可找回；确认框写明目标路径 | 无 |

### 3.3 AI 消息

消息分 `user` / `assistant` 两类，菜单项按角色裁剪。

| # | 菜单项 | 角色 | 说明 | 禁用条件 |
|---|---|---|---|---|
| 1 | 复制内容 | 两者 | | 内容为空 |
| 2 | 引用到输入框 | 两者 | 追加带 `>` 前缀的引用块到输入框并聚焦，不清空已输入内容 | AI 运行中 |
| — | *分隔线（仅 assistant）* | | | |
| 3 | 查看改写并应用… | 仅 assistant | 与消息上已有按钮同一判定条件 | 该消息无改写结果 |

不提供「重试这一条」（涉及运行生命周期与消息截断语义，属独立特性）、「删除消息」（线程是溯源链的一环，删消息会打断溯源）、「复制消息 ID」（仅调试价值）。

### 3.4 AI 线程列表项

| # | 菜单项 | 说明 | 禁用条件 |
|---|---|---|---|
| 1 | 打开 | | 已是当前线程 |
| 2 | 重命名线程… | Modal 输入框，乐观更新线程列表与当前标题，失败回滚并提示 | AI 运行中且是当前线程 |
| — | *分隔线* | | |
| 3 | 复制线程全文 | 拉取该线程全部消息拼接为文本 | 无 |

不提供归档：线程数据模型没有归档状态，重命名是唯一交付的写操作。

### 3.5 正典侧栏词条

覆盖四个结构化正典视图（设定索引 / 写作状态 / 角色卡 / 伏笔）的词条卡。

| # | 菜单项 | 说明 | 禁用条件 |
|---|---|---|---|
| 1 | 跳转到出处 | 词条的自由文本出处（如 `设定/世界观.md §货币`）经 `resolveCanonSource` 解析为结构化引用后跳转定位；无法解析时置灰并在 title 中展示原始出处文本 | 出处格式无法解析 / 该视图未配置出处来源 |
| 2 | 修订此节… | 与分节头部的修订按钮调用同一个入口，行为完全一致，粒度精确到词条所在分节 | 该词条所在分节没有可修订的正典引用 |
| — | *分隔线* | | |
| 3 | 复制词条名 | | 无 |
| 4 | 复制整条 | 拼装词条名、状态、出处、首次出现等字段为一段文本 | 无 |
| 5 | 查看正文提及 | 仅角色卡词条提供，跳转到该角色的正文提及列表 | 无（其余三个视图不显示此项） |

### 3.6 关系图 · 列表视图行

只覆盖列表视图，不覆盖 3D/2D 画布（见 §1.2）。

**实体行：**

| # | 菜单项 | 说明 | 禁用条件 |
|---|---|---|---|
| 1 | 选中该实体 | | 已选中 |
| 2 | 打开出处 | | 该节点无出处 |
| — | *分隔线* | | |
| 3 | 复制实体名 | | 无 |

**关系行：**

| # | 菜单项 | 说明 | 禁用条件 |
|---|---|---|---|
| 1 | 复制关系 | 拼装为「源实体 关系名 目标实体」文本 | 无 |
| 2 | 打开出处 | | 该边无出处 |
| 3 | 选中源实体 | | 已选中 |
| 4 | 选中目标实体 | | 已选中 |

### 3.7 危险操作与回收站规则

| 危险级别 | 判定 | 交互 |
|---|---|---|
| 可逆、无痕 | 复制、跳转、选中 | 直接执行，无确认 |
| 可逆、有痕 | 重命名 | Modal 输入框，输入本身即确认 |
| 软删除（有回收站） | 删除草稿 | 确认框 + `danger` 样式 + 标签带省略号 + 文案写明找回路径 |
| 硬删除（无回收站） | 章节、消息 | 不提供菜单项；在有回收站语义之前，菜单里不出现任何无法找回的删除 |

`danger` 样式（红字 + 独立分组 + 上方强制分隔线）只用于软删除这一级。

---

## 4. 依赖选择

**结论：零新增依赖。** 不引入 `floating-ui` / `radix` / `headlessui`。

理由：

1. 定位需求是单点锚定 + 四向翻转 + 视口 clamp，没有 arrow、没有 flip 到相邻边、没有 auto-placement 链、没有虚拟滚动跟随，自实现约 25 行；专用定位库的体积价不划算。
2. ARIA menu 的键盘逻辑必须自己写——第三方组件库会连带引入自己的 portal/焦点/Slot 体系，与仓库既有的 Modal 焦点模式冲突，等于同时维护两套无障碍约定。
3. 仓库现有浮层（Modal、选区浮动条）全部手写定位，风格一致。

若未来出现「需要二级子菜单的智能翻转」「菜单需要跟随滚动元素而非关闭」「需要 RTL 布局」，可重新评估引入专用库；目前都不成立。

---

## 5. 已知限制

- **触屏长按未实现**：只预留 `{ rect }` 锚点扩展点，见 §2.7。
- **macOS 无原生右键快捷键**：`Shift+F10` 与 `ContextMenu` 键在 macOS 上不通用；键盘用户可 Tab 到列表项后用 Enter 打开对应对象。
- **编辑器正文区永远是浏览器原生菜单**：没有「对这段发起改写」的右键入口，只能通过划词浮动条完成，见 §2.9。
- **章节的删除/新建同级未实现**：正式章节没有回收站语义，在补齐之前不提供无法找回的删除操作。
- **图谱画布右键未实现**：见 §1.2，画布控制器占用了右键手势。
