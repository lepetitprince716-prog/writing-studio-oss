import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  projectConfigSchema,
  type ProjectConfig,
  type SidebarPayload,
  type WritingStatusDto,
} from '@writing-studio/contract';
import { renderTitleTemplate, renderTitleTemplateExample } from '../content-pattern.js';
import { findNestedQuantifierRisk } from '../lint/redos-heuristic.js';
import { builtinStyleRuleIds, lintRulePackForLocale } from '../lint/packs/index.js';
import { SidebarService } from '../sidebar/index.js';
import { extractTitle, resolveDocPath } from '../vault.js';
import { isCliEntrypoint } from './entrypoint.js';

const CONFIG_FILE = '.writing-studio/project.json';
const TITLE_PROBE = '\uE000';
// Single source of truth for the scaffold marker lines; create-project
// imports these so the writer and the exemption can never drift apart.
export const SCAFFOLD_MARKER_LINES = {
  'zh-CN': '<!-- writing-studio:骨架 —— 填入内容后请删除本行 -->',
  en: '<!-- writing-studio:scaffold — delete this line after adding content -->',
} as const;
const SCAFFOLD_MARKERS = new Set<string>(Object.values(SCAFFOLD_MARKER_LINES));
const USAGE = [
  '用法：node --import tsx src/cli/validate-config.ts <vault-root> [--json]',
  '仓库根目录（此形式请传绝对路径）：',
  '  pnpm --filter @writing-studio/server validate-config -- <absolute-vault-root> [--json]',
].join('\n');

export interface ConfigDiagnostic {
  location: string;
  message: string;
}

export interface ValidateConfigResult {
  valid: boolean;
  errors: ConfigDiagnostic[];
  warnings: ConfigDiagnostic[];
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function payloadIsEmpty(payload: SidebarPayload): boolean {
  if (payload.parser === 'markdown-table') return payload.entries.length === 0;
  if (payload.parser === 'plain') return payload.markdown.trim().length === 0;
  if (payload.kind === 'characters' || payload.kind === 'foreshadowing') {
    return payload.data.length === 0;
  }
  const data = payload.data;
  return data.lastRefreshed === null
    && data.stopChapter === null
    && writingStatusContentFieldsAreEmpty(data);
}

function writingStatusContentFieldsAreEmpty(data: WritingStatusDto): boolean {
  return data.stopPoint.trim().length === 0
    && data.storylines.length === 0
    && data.activeForeshadow.length === 0
    && data.characterOneLiners.length === 0
    && data.redLines.length === 0
    && data.expressionBaseline.trim().length === 0;
}

function writingStatusContentIsEmpty(payload: SidebarPayload): boolean {
  if (payload.parser !== 'heading-sections' || payload.kind !== 'writingStatus') return false;
  return writingStatusContentFieldsAreEmpty(payload.data);
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?(?:\s*:?-+:?\s*\|)+(?:\s*:?-+:?\s*)?$/u.test(line);
}

interface ScaffoldInspection {
  pristine: boolean;
  hasCommentContent: boolean;
}

export const SCAFFOLD_COMMENT_BODY_LINES = {
  'zh-CN': [
    '结构示例（复制到注释外使用；每个角色一张 ## 卡片）：',
    '## 角色名',
    '### 角色定位',
    '一句话定位。',
  ],
  en: [
    'Structure example (copy outside this comment; use one ## card per character):',
    '## Character name',
    '### Role',
    'One-sentence role.',
  ],
} as const;
const BUILTIN_SCAFFOLD_COMMENT_BODIES = new Set(
  Object.values(SCAFFOLD_COMMENT_BODY_LINES).map((lines) => lines.join('\n')),
);

// CRLF or editor indentation must not make a shipped comment body read as
// author content: the sets above are exact LF strings, so compare normalized.
function normalizeCommentBody(body: string): string {
  return body
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

function commentHasAuthorContent(markdown: string): boolean {
  const bodies = [...markdown.matchAll(/<!--([\s\S]*?)-->/gu)]
    .map((match) => normalizeCommentBody(match[1]!))
    .filter((body) => body.length > 0);
  return bodies.some((body) =>
    !SCAFFOLD_MARKERS.has(`<!-- ${body} -->`)
    && !BUILTIN_SCAFFOLD_COMMENT_BODIES.has(body)
  );
}

/**
 * The pristine exemption is an intentional file-level mute switch: pristine
 * scaffold files skip content warnings until the author starts filling them.
 */
function isPristineScaffold(markdown: string): ScaffoldInspection {
  const lines = markdown.split(/\r?\n/u);
  const firstNonEmpty = lines.findIndex((line) => line.trim().length > 0);
  if (firstNonEmpty < 0 || !SCAFFOLD_MARKERS.has(lines[firstNonEmpty]!.trim())) {
    return { pristine: false, hasCommentContent: false };
  }

  let inHtmlComment = false;
  let tableHasSeparator = false;
  const pristine = lines.every((line, index) => {
    let visible = '';
    let cursor = 0;
    while (cursor < line.length) {
      if (inHtmlComment) {
        const close = line.indexOf('-->', cursor);
        if (close < 0) {
          cursor = line.length;
        } else {
          inHtmlComment = false;
          cursor = close + 3;
        }
      } else {
        const open = line.indexOf('<!--', cursor);
        if (open < 0) {
          visible += line.slice(cursor);
          cursor = line.length;
        } else {
          visible += line.slice(cursor, open);
          inHtmlComment = true;
          cursor = open + 4;
        }
      }
    }
    const trimmed = visible.trim();
    if (trimmed.length === 0) {
      tableHasSeparator = false;
      return true;
    }
    if (index === firstNonEmpty) return true;
    if (/^#{1,6}\s+\S/u.test(trimmed)) {
      tableHasSeparator = false;
      return true;
    }
    if (isTableSeparator(trimmed)) {
      tableHasSeparator = true;
      return true;
    }
    if (
      /^\|.*\|$/u.test(trimmed)
      && !tableHasSeparator
      && isTableSeparator(lines[index + 1]?.trim() ?? '')
    ) {
      return true;
    }
    tableHasSeparator = false;
    return false;
  });
  // An unclosed <!-- would swallow author content forever; shipped scaffolds
  // always close their comments, so this is a pure tightening.
  return {
    pristine: pristine && !inHtmlComment,
    hasCommentContent: commentHasAuthorContent(markdown),
  };
}

interface SchemaIssue {
  code?: string;
  path: Array<string | number>;
  message: string;
  unionErrors?: Array<{ issues: SchemaIssue[] }>;
}

function schemaErrors(error: { issues: SchemaIssue[] }): ConfigDiagnostic[] {
  const expand = (issue: SchemaIssue): SchemaIssue[] =>
    issue.code === 'invalid_union' && issue.unionErrors
      ? issue.unionErrors.flatMap((unionError) => unionError.issues.flatMap(expand))
      : [issue];
  const diagnostics = error.issues.flatMap(expand).map((issue) => ({
    location: issue.path.length > 0
      ? `${CONFIG_FILE}:${issue.path.map(String).join('.')}`
      : CONFIG_FILE,
    message: issue.message,
  }));
  return diagnostics.filter((diagnostic, index) =>
    diagnostics.findIndex((candidate) =>
      candidate.location === diagnostic.location && candidate.message === diagnostic.message,
    ) === index,
  );
}

function checkReferencedFiles(
  vaultRoot: string,
  config: ProjectConfig,
  warnings: ConfigDiagnostic[],
): void {
  const sidebars = new SidebarService();
  for (const [index, source] of config.sidebarSources.entries()) {
    const field = `sidebarSources.${index}.file`;
    let path: string;
    try {
      path = resolveDocPath(vaultRoot, source.file);
    } catch (error) {
      warnings.push({
        location: `${CONFIG_FILE}:${field} (${source.file})`,
        message: `无法检查引用文件：${errorMessage(error)}`,
      });
      continue;
    }
    if (!existsSync(path)) {
      warnings.push({
        location: `${CONFIG_FILE}:${field} (${source.file})`,
        message: '引用文件不存在',
      });
      continue;
    }
    if (!statSync(path).isFile()) {
      warnings.push({
        location: `${CONFIG_FILE}:${field} (${source.file})`,
        message: '引用路径不是普通文件',
      });
      continue;
    }
    try {
      const payload = sidebars.getSource({ vaultRoot, config }, source.id, 'planner');
      if (payload && (payloadIsEmpty(payload) || writingStatusContentIsEmpty(payload))) {
        const markdown = readFileSync(path, 'utf8');
        const scaffold = isPristineScaffold(markdown);
        if (scaffold.pristine) {
          if (scaffold.hasCommentContent) {
            warnings.push({
              location: `${source.file} (${field})`,
              message: '该文件仍是骨架（内容写在注释块内不会被解析）',
            });
          }
        } else if (payloadIsEmpty(payload)) {
          warnings.push({
            location: `${source.file} (${field})`,
            message: '文件存在但按当前 parserConfig 解析不到内容',
          });
        } else {
          warnings.push({
            location: `${source.file} (${field})`,
            message: '文件结构命中但内容段均为空',
          });
        }
      }
    } catch (error) {
      warnings.push({
        location: `${source.file} (${field})`,
        message: `文件存在但读取或解析失败：${errorMessage(error)}`,
      });
    }
  }

  const relationsFile = config.graph?.relationsFile;
  if (relationsFile) {
    try {
      const path = resolveDocPath(vaultRoot, relationsFile);
      if (!existsSync(path)) {
        warnings.push({
          location: `${CONFIG_FILE}:graph.relationsFile (${relationsFile})`,
          message: '引用文件不存在',
        });
      } else if (!statSync(path).isFile()) {
        warnings.push({
          location: `${CONFIG_FILE}:graph.relationsFile (${relationsFile})`,
          message: '引用路径不是普通文件',
        });
      }
    } catch (error) {
      warnings.push({
        location: `${CONFIG_FILE}:graph.relationsFile (${relationsFile})`,
        message: `无法检查引用文件：${errorMessage(error)}`,
      });
    }
  }
}

function checkTitleContract(config: ProjectConfig, warnings: ConfigDiagnostic[]): void {
  const leaf = config.contentTree.leaf;
  const template = leaf.titleTemplate;
  const location = `${CONFIG_FILE}:contentTree.leaf.titleTemplate`;
  const missingTitle = template !== null && template !== undefined && !template.includes('{title}');
  if (missingTitle) {
    warnings.push({ location, message: '模板不含 {title}，用户输入的章标题将被丢弃' });
  }
  if (renderTitleTemplateExample(template).trim().length === 0) {
    warnings.push({ location, message: '模板渲染样例为空或纯空白' });
  }
  const multiline = /[\r\n\u2028\u2029]/u.test(renderTitleTemplateExample(template));
  if (multiline) {
    warnings.push({ location, message: '模板渲染结果含换行，建章会被服务端拒绝' });
  }

  // The cross-check only makes sense for templates that can round-trip at all.
  if (leaf.titleStripRegex === null || missingTitle || multiline) return;
  // Probe two chapter numbers: a regex tuned to chapter one (第一章 / Chapter 1)
  // can pass a single-number probe and still fail every later chapter.
  const mismatch = [1, 12].some((chapterNo) => {
    const rendered = renderTitleTemplate(template, chapterNo, TITLE_PROBE, leaf.numberStyle);
    // Same extraction the server applies when displaying titles.
    return extractTitle(`# ${rendered}`, leaf.titleStripRegex) !== TITLE_PROBE;
  });
  if (mismatch) {
    warnings.push({
      location: `${CONFIG_FILE}:contentTree.leaf.titleStripRegex`,
      message: 'titleTemplate 与 titleStripRegex 不匹配，章标题显示将包含整条 H1',
    });
  }
}

function checkLintConfig(config: ProjectConfig, warnings: ConfigDiagnostic[]): void {
  if (!config.lint) return;
  const pack = lintRulePackForLocale(config.localePreset);
  const disabledRuleIds = config.lint.disableBuiltinStyleRules ?? [];

  if (pack.styleRules.length === 0) {
    if (disabledRuleIds.length > 0) {
      warnings.push({
        location: `${CONFIG_FILE}:lint.disableBuiltinStyleRules`,
        message: '当前 localePreset 的内置规则包为空，disableBuiltinStyleRules 配置不会生效',
      });
    }
  } else {
    for (const [index, ruleId] of disabledRuleIds.entries()) {
      if (builtinStyleRuleIds.has(ruleId)) continue;
      warnings.push({
        location: `${CONFIG_FILE}:lint.disableBuiltinStyleRules.${index}`,
        message: `未知内置 style ruleId：${ruleId}`,
      });
    }
  }

  // Judge against the rules that survive disableBuiltinStyleRules, not the raw
  // pack: disabling the detector kills idiomStackList just as thoroughly as a
  // locale that never shipped one.
  // An empty idiomStackList still warrants the warning — replacing the
  // vocabulary with nothing is a deliberate "turn it off" act, so being ignored
  // is worth reporting. An empty disableBuiltinStyleRules is a no-op in every
  // locale and stays silent above.
  const idiomStackRule = pack.styleRules.find((rule) => rule.kind === 'idiom-stack');
  const idiomStackDisabled = idiomStackRule !== undefined
    && disabledRuleIds.includes(idiomStackRule.ruleId);
  if ((idiomStackRule === undefined || idiomStackDisabled) && config.lint.idiomStackList !== undefined) {
    warnings.push({
      location: `${CONFIG_FILE}:lint.idiomStackList`,
      message: idiomStackDisabled
        ? `成语堆叠检测已被 disableBuiltinStyleRules 关闭（${idiomStackRule.ruleId}），idiomStackList 配置不会生效`
        : '当前 localePreset 没有成语堆叠检测，idiomStackList 配置不会生效',
    });
  }

  for (const [index, rule] of (config.lint.styleRules ?? []).entries()) {
    const hit = findNestedQuantifierRisk(rule.pattern);
    if (!hit) continue;
    warnings.push({
      location: `${CONFIG_FILE}:lint.styleRules.${index}.pattern`,
      message: `正则疑似含嵌套量词（位置 ${hit.index}，${hit.reason}）；命中时可能引发灾难性回溯并阻塞服务，未告警也不代表正则安全`,
    });
  }
}

/**
 * Read and validate one vault without mutating it.
 * This is the reusable seam for the CLI and a future setup panel.
 */
export function validateProjectConfig(vaultRoot: string): ValidateConfigResult {
  const resolvedVaultRoot = resolve(vaultRoot);
  const configPath = join(resolvedVaultRoot, CONFIG_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    return {
      valid: false,
      errors: [{ location: configPath, message: `无法读取或解析配置：${errorMessage(error)}` }],
      warnings: [],
    };
  }

  const parsed = projectConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return { valid: false, errors: schemaErrors(parsed.error), warnings: [] };
  }

  const warnings: ConfigDiagnostic[] = [];
  checkReferencedFiles(resolvedVaultRoot, parsed.data, warnings);
  checkTitleContract(parsed.data, warnings);
  checkLintConfig(parsed.data, warnings);
  return { valid: true, errors: [], warnings };
}

function formatDiagnostic(kind: '错误' | '告警', diagnostic: ConfigDiagnostic): string {
  return `${kind} [${diagnostic.location}] ${diagnostic.message}`;
}

export function formatValidateConfigResult(result: ValidateConfigResult): string {
  const lines = result.valid ? ['配置有效。'] : ['配置无效。'];
  lines.push(...result.errors.map((error) => formatDiagnostic('错误', error)));
  lines.push(...result.warnings.map((warning) => formatDiagnostic('告警', warning)));
  if (result.valid && result.warnings.length === 0) lines.push('未发现告警。');
  return lines.join('\n');
}

export function runValidateConfigCli(args: string[]): number {
  let json = false;
  let help = false;
  const positional: string[] = [];
  const unknownOptions: string[] = [];
  for (const argument of args) {
    // pnpm's documented invocation forwards a literal `--`; treat it as a
    // plain separator everywhere instead of switching parsing modes, so
    // `validate-config -- <vault> --json` keeps working.
    if (argument === '--') {
      continue;
    } else if (argument === '--json') {
      json = true;
    } else if (argument === '--help') {
      help = true;
    } else if (argument.startsWith('-')) {
      unknownOptions.push(argument);
    } else {
      positional.push(argument);
    }
  }
  // Help wins over everything else, and is always plain text (even with
  // --json): it documents the command, it is not a validation result.
  if (help) {
    console.log(USAGE);
    return 0;
  }
  if (unknownOptions.length > 0 || positional.length !== 1) {
    const detail = unknownOptions.length > 0
      ? `未知参数：${unknownOptions.join(', ')}`
      : USAGE;
    if (json) {
      console.error(JSON.stringify({
        valid: false,
        errors: [{ location: '<args>', message: detail }],
        warnings: [],
      } satisfies ValidateConfigResult));
    } else {
      console.error(detail);
      if (unknownOptions.length > 0) console.error(USAGE);
    }
    return 2;
  }
  const result = validateProjectConfig(positional[0]!);
  console.log(json ? JSON.stringify(result) : formatValidateConfigResult(result));
  return result.valid ? 0 : 1;
}

if (isCliEntrypoint(import.meta.url)) {
  process.exitCode = runValidateConfigCli(process.argv.slice(2));
}
