import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectConfigSchema, type ProjectConfig } from '@writing-studio/contract';
import { z } from 'zod';
import { registrySchema, resolveRegistryLocation } from '../config.js';
import {
  SCAFFOLD_COMMENT_BODY_LINES,
  SCAFFOLD_MARKER_LINES,
  errorMessage,
  formatValidateConfigResult,
  validateProjectConfig,
  type ValidateConfigResult,
} from './validate-config.js';
import { isCliEntrypoint } from './entrypoint.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const BASIC_VAULT_ROOT = join(REPO_ROOT, 'examples', 'basic-vault');
const CONFIG_RELATIVE_PATH = '.writing-studio/project.json';
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

export const ZH_CN_TEMPLATE_REPLACEMENTS = {
  contentRoot: '正文',
  levelDirPattern: '第{num}部_{name}',
  levelNumberStyle: 'cnLower',
  initialLevelDir: '第一部_开端',
  // 目录编号（部/卷）用中文数字（cnLower），贴近中文长篇的分部惯例；
  // 章节文件名编号保留 arabic，章节数量大时更短，也更便于排序与解析。
  leafFilePattern: '第{num}章.md',
  draftsDir: '草稿',
  titleStripRegex: '^第[0-9一二三四五六七八九十百]+章[\\s:：]*',
  sidebarSources: {
    setting_index: {
      label: '设定索引',
      file: '设定索引.md',
      columnAliases: {
        term: ['术语'],
        source: ['定义出处'],
        firstAppearance: ['首次正文出现'],
        blankLink: ['关联留白'],
        status: ['状态'],
        serial: ['编号'],
      },
    },
    characters: {
      label: '角色',
      file: '角色.md',
      authorOnlyMarkers: ['作者侧'],
    },
    writing_status: {
      label: '写作状态',
      file: '写作状态.md',
      lastRefreshedRegex: '最后刷新：([0-9-]+)',
      stopChapterRegex: '对应停点第(\\d+)章',
    },
  },
  relationsFile: '关系网.md',
  graphSectionTypeIds: {
    地点: 'place',
  },
  aiProfileDescriptions: {
    writer: '仅可读取公开正文与公开参考卡片。',
    planner: '作者规划视图。',
  },
  writingStatusHeadings: {
    'Stop point': '停点',
    Storylines: '故事线',
    'Active foreshadow overview': '活跃伏笔速览',
    'Character one-line status': '角色一句话状态',
    'Writing red lines': '写作红线',
    'Expression baseline': '表达基线',
  },
} as const;

const EN_INITIAL_LEVEL_DIR = 'Part-1_Beginning';
const SCAFFOLD_MARKERS = SCAFFOLD_MARKER_LINES;
const ZH_GRAPH_PREAMBLE =
  '本文件是语义关系的唯一来源；vault 中其它 wikilink 只是证据链接，不会自动生成边。';
const EN_GRAPH_PREAMBLE =
  'This file is the only source of semantic relations; other wikilinks in the vault are evidence links and never create edges.';
const UNSET_STOP_NOTICE =
  '尚无停点：在写作状态的停点段填入章节引用后，writer 投影才可用。';
const USAGE = [
  '用法：node --import tsx src/cli/create-project.ts --id <id> --name <displayName> --vault <target-dir> [--locale zh-CN|en] [--data-dir <dir>] [--json]',
  '仓库根目录：',
  '  pnpm --filter @writing-studio/server create-project -- --id <id> --name <displayName> --vault <target-dir> [--locale zh-CN|en] [--data-dir <dir>] [--json]',
].join('\n');

export type CreateProjectLocale = 'zh-CN' | 'en';

export interface CreateProjectOptions {
  id: string;
  displayName: string;
  vaultRoot: string;
  locale?: CreateProjectLocale;
  dataDir?: string;
}

export interface CreateProjectResult {
  created: true;
  vaultRoot: string;
  registryPath: string;
  validate: ValidateConfigResult;
}

export class CreateProjectError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CreateProjectError';
  }
}

function readRegistry(registryPath: string): z.infer<typeof registrySchema> {
  if (!existsSync(registryPath)) return { projects: [] };
  try {
    return registrySchema.parse(JSON.parse(readFileSync(registryPath, 'utf8')));
  } catch (error) {
    throw new CreateProjectError(`registry 无效：${errorMessage(error)}`, { cause: error });
  }
}

function writeRegistryAtomically(
  registryPath: string,
  registry: z.infer<typeof registrySchema>,
): void {
  mkdirSync(dirname(registryPath), { recursive: true });
  const tempPath = join(
    dirname(registryPath),
    `.${basename(registryPath)}.tmp-${process.pid}-${Date.now()}`,
  );
  try {
    writeFileSync(tempPath, `${JSON.stringify(registry, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    renameSync(tempPath, registryPath);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function loadTemplateConfig(): ProjectConfig {
  return projectConfigSchema.parse(
    JSON.parse(readFileSync(join(BASIC_VAULT_ROOT, CONFIG_RELATIVE_PATH), 'utf8')),
  );
}

function zhConfigFrom(template: ProjectConfig): ProjectConfig {
  const config = structuredClone(template);
  delete config.localePreset;
  config.contentTree.root = ZH_CN_TEMPLATE_REPLACEMENTS.contentRoot;
  const firstLevel = config.contentTree.levels[0];
  if (firstLevel) {
    firstLevel.dirPattern = ZH_CN_TEMPLATE_REPLACEMENTS.levelDirPattern;
    firstLevel.numberStyle = ZH_CN_TEMPLATE_REPLACEMENTS.levelNumberStyle;
  }
  config.contentTree.leaf.filePattern = ZH_CN_TEMPLATE_REPLACEMENTS.leafFilePattern;
  delete config.contentTree.leaf.titleTemplate;
  config.contentTree.leaf.titleStripRegex = ZH_CN_TEMPLATE_REPLACEMENTS.titleStripRegex;
  config.draftsDir = ZH_CN_TEMPLATE_REPLACEMENTS.draftsDir;
  const sourcePaths = new Map<string, string>();
  for (const source of config.sidebarSources) {
    const replacement = ZH_CN_TEMPLATE_REPLACEMENTS.sidebarSources[
      source.id as keyof typeof ZH_CN_TEMPLATE_REPLACEMENTS.sidebarSources
    ];
    if (!replacement) continue;
    sourcePaths.set(source.file, replacement.file);
    source.label = replacement.label;
    source.file = replacement.file;
    if (source.id === 'setting_index' && source.parser === 'markdown-table') {
      const aliases = ZH_CN_TEMPLATE_REPLACEMENTS.sidebarSources.setting_index.columnAliases;
      source.parserConfig.columnAliases = {
        term: [...aliases.term],
        source: [...aliases.source],
        firstAppearance: [...aliases.firstAppearance],
        blankLink: [...aliases.blankLink],
        status: [...aliases.status],
        serial: [...aliases.serial],
      };
    } else if (source.id === 'characters' && source.parser === 'heading-sections'
      && source.parserConfig.kind === 'characters') {
      source.parserConfig.authorOnlyMarkers = [
        ...ZH_CN_TEMPLATE_REPLACEMENTS.sidebarSources.characters.authorOnlyMarkers,
      ];
    } else if (source.id === 'writing_status' && source.parser === 'heading-sections'
      && source.parserConfig.kind === 'writingStatus') {
      source.parserConfig.lastRefreshedRegex =
        ZH_CN_TEMPLATE_REPLACEMENTS.sidebarSources.writing_status.lastRefreshedRegex;
      source.parserConfig.stopChapterRegex =
        ZH_CN_TEMPLATE_REPLACEMENTS.sidebarSources.writing_status.stopChapterRegex;
    }
  }
  if (config.graph) {
    sourcePaths.set(config.graph.relationsFile, ZH_CN_TEMPLATE_REPLACEMENTS.relationsFile);
    config.graph.relationsFile = ZH_CN_TEMPLATE_REPLACEMENTS.relationsFile;
    for (const typeSource of config.graph.typeSources ?? []) {
      if (typeSource.sourceId === 'setting_index') {
        typeSource.sectionTypeIds = structuredClone(
          ZH_CN_TEMPLATE_REPLACEMENTS.graphSectionTypeIds,
        );
      }
    }
  }
  config.aiProfiles.writer.description =
    ZH_CN_TEMPLATE_REPLACEMENTS.aiProfileDescriptions.writer;
  config.aiProfiles.planner.description =
    ZH_CN_TEMPLATE_REPLACEMENTS.aiProfileDescriptions.planner;
  for (const profile of [config.aiProfiles.writer, config.aiProfiles.planner]) {
    profile.readable = profile.readable.map((path) =>
      path === 'manuscript/**'
        ? `${ZH_CN_TEMPLATE_REPLACEMENTS.contentRoot}/**`
        : (sourcePaths.get(path) ?? path)
    );
  }
  return config;
}

function projectConfig(options: CreateProjectOptions): ProjectConfig {
  const locale = options.locale ?? 'zh-CN';
  const template = loadTemplateConfig();
  const config = locale === 'en' ? structuredClone(template) : zhConfigFrom(template);
  config.id = options.id;
  config.displayName = options.displayName;
  if (locale === 'en') config.localePreset = 'en';
  for (const source of config.sidebarSources) {
    if (source.parser === 'markdown-table') {
      delete source.parserConfig.writerHiddenFields;
    }
  }
  return projectConfigSchema.parse(config);
}

const ZH_HEADING_REPLACEMENTS: Record<string, string> = {
  Places: '地点',
  Characters: '角色',
  Role: '角色定位',
  'Writing status': '写作状态',
  'Relationship Graph': '关系网',
  'Node Types': '节点类型',
  'Relation Types': '关系类型',
  Nodes: '节点',
  Relations: '关系',
  ...ZH_CN_TEMPLATE_REPLACEMENTS.writingStatusHeadings,
};

const ZH_TABLE_REPLACEMENTS: Record<string, Record<string, string>> = {
  setting_index: {
    ID: '编号',
    Term: '术语',
    Source: '定义出处',
    'First seen': '首次正文出现',
    Relation: '关联留白',
    Status: '状态',
  },
  writing_status: {
    ID: '编号',
    Content: '内容',
    Status: '状态',
  },
  graph: {
    ID: '标识',
    Name: '名称',
    'Visual family': '视觉族',
    Directed: '有向',
    'Reverse name': '反向名称',
    Aliases: '别名',
    Type: '类型',
    'Active from': '生效章',
    'Revealed at': '揭示章',
    'Inactive from': '失效章',
    Visibility: '可见性',
    Confidence: '置信',
    Sources: '出处',
    Source: '源',
    Relation: '关系',
    Target: '目标',
  },
};

function localizedHeading(line: string, locale: CreateProjectLocale): string {
  if (locale === 'en') return line;
  const match = /^(#{1,6})\s+(.+)$/.exec(line);
  if (!match) return line;
  return `${match[1]} ${ZH_HEADING_REPLACEMENTS[match[2]!] ?? match[2]}`;
}

function localizedTableLine(
  line: string,
  locale: CreateProjectLocale,
  sourceKind: string,
): string {
  if (locale === 'en' || /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*$/u.test(line)) return line;
  const replacements = ZH_TABLE_REPLACEMENTS[sourceKind] ?? {};
  const cells = line.split('|');
  return cells.map((cell) => {
    const trimmed = cell.trim();
    return trimmed in replacements
      ? cell.replace(trimmed, replacements[trimmed]!)
      : cell;
  }).join('|');
}

function writingStatusPlaceholder(
  heading: string,
  locale: CreateProjectLocale,
): string[] {
  const zh = locale === 'zh-CN';
  const localizedHeadings = ZH_CN_TEMPLATE_REPLACEMENTS.writingStatusHeadings;
  const stopPoint = zh ? localizedHeadings['Stop point'] : 'Stop point';
  const storylines = zh ? localizedHeadings.Storylines : 'Storylines';
  const activeForeshadow = zh
    ? localizedHeadings['Active foreshadow overview']
    : 'Active foreshadow overview';
  const characterOneLiners = zh
    ? localizedHeadings['Character one-line status']
    : 'Character one-line status';
  const redLines = zh ? localizedHeadings['Writing red lines'] : 'Writing red lines';
  const expressionBaseline = zh
    ? localizedHeadings['Expression baseline']
    : 'Expression baseline';
  if (heading === stopPoint) return [];
  if (heading === storylines) {
    return [`- **${zh ? '主线' : 'Main'}**${zh ? '：' : ': '}${zh ? '待填写' : 'To be completed'}`];
  }
  if (heading === characterOneLiners) {
    return [`- **${zh ? '角色' : 'Character'}**${zh ? '：' : ': '}${zh ? '待填写' : 'To be completed'}`];
  }
  if (heading === redLines) return [`1. ${zh ? '待填写' : 'To be completed'}`];
  if (heading === expressionBaseline) return [zh ? '待填写' : 'To be completed'];
  if (heading === activeForeshadow) return [];
  return [];
}

function skeletonizeMarkdown(
  markdown: string,
  locale: CreateProjectLocale,
  sourceKind: string,
): string {
  if (sourceKind === 'characters') {
    return [
      SCAFFOLD_MARKERS[locale],
      '<!--',
      ...SCAFFOLD_COMMENT_BODY_LINES[locale],
      '-->',
      '',
    ].join('\n');
  }

  const output = sourceKind === 'setting_index' ? [SCAFFOLD_MARKERS[locale], ''] : [];
  let tableLineIndex = 0;
  let activeHeading = '';
  let encounteredTable = false;
  let wroteZhGraphPreamble = false;
  for (const rawLine of markdown.split(/\r?\n/u)) {
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(rawLine);
    if (headingMatch) {
      const line = localizedHeading(rawLine, locale);
      activeHeading = line.replace(/^#{1,6}\s+/, '');
      if (output.length > 0 && output.at(-1) !== '') output.push('');
      output.push(line, '');
      tableLineIndex = 0;
      output.push(...writingStatusPlaceholder(activeHeading, locale), '');
      continue;
    }
    if (/^\s*\|.*\|\s*$/u.test(rawLine)) {
      encounteredTable = true;
      tableLineIndex += 1;
      if (tableLineIndex <= 2) {
        output.push(localizedTableLine(rawLine, locale, sourceKind));
      }
      continue;
    }
    if (
      sourceKind === 'graph'
      && !encounteredTable
      && rawLine.trim().length > 0
    ) {
      // Both locales get a locale-appropriate contract sentence instead of the
      // example vault's prose, which calls the file "the example vault".
      if (!wroteZhGraphPreamble) {
        output.push(locale === 'zh-CN' ? ZH_GRAPH_PREAMBLE : EN_GRAPH_PREAMBLE);
        wroteZhGraphPreamble = true;
      }
      continue;
    }
    tableLineIndex = 0;
  }
  return `${output.join('\n').replace(/\n{3,}/gu, '\n\n').trimEnd()}\n`;
}

interface ScaffoldFile {
  sourcePath: string;
  targetPath: string;
  sourceKind: string;
}

function scaffoldFiles(template: ProjectConfig, config: ProjectConfig): ScaffoldFile[] {
  const targetSources = new Map(config.sidebarSources.map((source) => [source.id, source]));
  const files = template.sidebarSources.map((source) => {
    const target = targetSources.get(source.id);
    if (!target) {
      throw new CreateProjectError(`模板侧栏源在目标配置中缺失：${source.id}`);
    }
    return {
      sourcePath: source.file,
      targetPath: target.file,
      sourceKind: source.id,
    };
  });
  if (template.graph?.relationsFile && config.graph?.relationsFile) {
    files.push({
      sourcePath: template.graph.relationsFile,
      targetPath: config.graph.relationsFile,
      sourceKind: 'graph',
    });
  }
  return files;
}

function scaffoldVault(
  vaultRoot: string,
  template: ProjectConfig,
  config: ProjectConfig,
  locale: CreateProjectLocale,
): void {
  mkdirSync(join(vaultRoot, '.writing-studio'), { recursive: true });
  writeFileSync(
    join(vaultRoot, CONFIG_RELATIVE_PATH),
    `${JSON.stringify(config, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx' },
  );

  for (const file of scaffoldFiles(template, config)) {
    const sourcePath = join(BASIC_VAULT_ROOT, file.sourcePath);
    const targetPath = join(vaultRoot, file.targetPath);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(
      targetPath,
      skeletonizeMarkdown(readFileSync(sourcePath, 'utf8'), locale, file.sourceKind),
      { encoding: 'utf8', flag: 'wx' },
    );
  }

  const initialLevelDir = locale === 'en'
    ? EN_INITIAL_LEVEL_DIR
    : ZH_CN_TEMPLATE_REPLACEMENTS.initialLevelDir;
  mkdirSync(join(vaultRoot, config.contentTree.root, initialLevelDir), { recursive: true });
  mkdirSync(join(vaultRoot, config.draftsDir), { recursive: true });
}

/**
 * Create and register one project. This reusable core performs no console I/O.
 */
export function createProject(options: CreateProjectOptions): CreateProjectResult {
  if (!PROJECT_ID_PATTERN.test(options.id)) {
    throw new CreateProjectError('id 必须匹配 ^[a-z0-9][a-z0-9-]{1,63}$');
  }
  if (options.displayName.trim().length === 0) {
    throw new CreateProjectError('displayName 不得为空');
  }
  const locale = options.locale ?? 'zh-CN';
  if (locale !== 'zh-CN' && locale !== 'en') {
    throw new CreateProjectError('locale 只接受 zh-CN 或 en');
  }
  const vaultRoot = resolve(options.vaultRoot);
  const { dataDir, registryPath } = resolveRegistryLocation(
    options.dataDir === undefined ? undefined : { dataDir: options.dataDir },
  );
  const registry = readRegistry(registryPath);
  if (registry.projects.some((entry) => entry.id === options.id)) {
    throw new CreateProjectError(`registry 中已存在项目 id：${options.id}`);
  }

  let vaultExisted: boolean;
  try {
    vaultExisted = existsSync(vaultRoot);
    if (vaultExisted) {
      if (!statSync(vaultRoot).isDirectory() || readdirSync(vaultRoot).length > 0) {
        throw new CreateProjectError(`目标路径已存在且不是空目录：${vaultRoot}`);
      }
    }
    if (!vaultExisted) mkdirSync(vaultRoot, { recursive: true });
  } catch (error) {
    if (error instanceof CreateProjectError) throw error;
    throw new CreateProjectError(`无法准备目标路径：${errorMessage(error)}`, { cause: error });
  }

  let scaffoldStarted = false;
  try {
    const template = loadTemplateConfig();
    const config = projectConfig({ ...options, locale });
    scaffoldStarted = true;
    scaffoldVault(vaultRoot, template, config, locale);
    const validate = validateProjectConfig(vaultRoot);
    if (!validate.valid) {
      throw new CreateProjectError(
        `脚手架生成了非法配置（这是 create-project bug）：${formatValidateConfigResult(validate)}`,
      );
    }
    writeRegistryAtomically(registryPath, {
      projects: [
        ...registry.projects,
        { id: options.id, vaultRoot, enabled: true },
      ],
    });
    return { created: true, vaultRoot, registryPath, validate };
  } catch (error) {
    if (scaffoldStarted || !vaultExisted) {
      if (vaultExisted) {
        for (const entry of readdirSync(vaultRoot)) {
          rmSync(join(vaultRoot, entry), { recursive: true, force: true });
        }
      } else {
        rmSync(vaultRoot, { recursive: true, force: true });
      }
    }
    if (error instanceof CreateProjectError) throw error;
    throw new CreateProjectError(`创建项目失败：${errorMessage(error)}`, { cause: error });
  }
}

interface ParsedArgs {
  id: string;
  displayName: string;
  vaultRoot: string;
  locale: CreateProjectLocale;
  dataDir?: string;
  json: boolean;
}

function parseArgs(args: string[]): { help: true } | { help: false; value?: ParsedArgs; error?: string; json: boolean } {
  // Help wins over all other arguments and is always plain text.
  if (args.includes('--help')) return { help: true };
  // Scan output mode before validation so --json applies regardless of where
  // an earlier malformed or unknown argument appears.
  const json = args.includes('--json');
  const values = new Map<string, string>();
  const valueFlags = new Set(['--id', '--name', '--vault', '--locale', '--data-dir']);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--') continue;
    if (argument === '--json') {
      continue;
    }
    if (!valueFlags.has(argument)) {
      return { help: false, error: `未知参数：${argument}`, json };
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      return { help: false, error: `参数缺少值：${argument}`, json };
    }
    if (values.has(argument)) {
      return { help: false, error: `参数重复：${argument}`, json };
    }
    values.set(argument, value);
    index += 1;
  }
  for (const flag of ['--id', '--name', '--vault']) {
    if (!values.has(flag)) return { help: false, error: `缺少必需参数：${flag}`, json };
  }
  const id = values.get('--id')!;
  const displayName = values.get('--name')!;
  const locale = values.get('--locale') ?? 'zh-CN';
  if (!PROJECT_ID_PATTERN.test(id)) {
    return { help: false, error: '参数 --id 必须匹配 ^[a-z0-9][a-z0-9-]{1,63}$', json };
  }
  if (displayName.trim().length === 0) {
    return { help: false, error: '参数 --name 不得为空', json };
  }
  if (locale !== 'zh-CN' && locale !== 'en') {
    return { help: false, error: '参数 --locale 只接受 zh-CN 或 en', json };
  }
  return {
    help: false,
    json,
    value: {
      id,
      displayName,
      vaultRoot: values.get('--vault')!,
      locale,
      ...(values.has('--data-dir') ? { dataDir: values.get('--data-dir')! } : {}),
      json,
    },
  };
}

function writeArgumentError(message: string, json: boolean): void {
  if (json) {
    console.error(JSON.stringify({ created: false, error: message }));
  } else {
    console.error(message);
    console.error(USAGE);
  }
}

export function runCreateProjectCli(args: string[]): number {
  const parsed = parseArgs(args);
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }
  if (!parsed.value) {
    writeArgumentError(parsed.error ?? '参数无效', parsed.json);
    return 2;
  }
  try {
    const result = createProject(parsed.value);
    if (parsed.value.json) {
      console.log(JSON.stringify(result));
    } else {
      console.log(`项目已创建：${result.vaultRoot}`);
      console.log(`Registry：${result.registryPath}`);
      console.log(formatValidateConfigResult(result.validate));
      console.log(UNSET_STOP_NOTICE);
    }
    return 0;
  } catch (error) {
    const message = errorMessage(error);
    if (parsed.value.json) {
      console.error(JSON.stringify({ created: false, error: message }));
    } else {
      console.error(message);
    }
    return 1;
  }
}

if (isCliEntrypoint(import.meta.url)) {
  process.exitCode = runCreateProjectCli(process.argv.slice(2));
}
