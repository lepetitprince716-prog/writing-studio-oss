import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  formatValidateConfigResult,
  validateProjectConfig,
  type ValidateConfigResult,
} from '../src/cli/validate-config.js';
import { withoutRuntimeNoise } from './support/process-helpers.js';

function validConfig(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'validate-test',
    displayName: 'Validate Test',
    contentTree: {
      root: '正文',
      levels: [],
      leaf: {
        filePattern: 'chapter-{num}.md',
        numberStyle: 'arabic',
        titleTemplate: 'Chapter {num}: {title}',
        numberingScope: 'book',
        titleStripRegex: '^Chapter \\d+:\\s*',
      },
    },
    draftsDir: '草稿',
    sidebarSources: [],
    aiProfiles: {
      writer: {
        description: 'writer',
        readable: ['正文/**/*.md'],
        forbidden: ['.writing-studio/**'],
        allowVaultBrowsing: false,
      },
      planner: {
        description: 'planner',
        readable: ['**/*.md'],
        forbidden: ['.writing-studio/**'],
        allowVaultBrowsing: true,
      },
      defaultProfile: 'writer',
    },
    defaultAgentId: 'codex',
  };
}

function withVault(run: (vaultRoot: string, config: Record<string, unknown>) => void): void {
  const vaultRoot = mkdtempSync(join(tmpdir(), 'writing-studio-validate-'));
  const config = validConfig();
  try {
    mkdirSync(join(vaultRoot, '.writing-studio'), { recursive: true });
    run(vaultRoot, config);
  } finally {
    rmSync(vaultRoot, { recursive: true, force: true });
  }
}

function writeConfig(vaultRoot: string, config: Record<string, unknown>): void {
  writeFileSync(
    join(vaultRoot, '.writing-studio', 'project.json'),
    `${JSON.stringify(config, null, 2)}\n`,
  );
}

function warnings(result: ValidateConfigResult): string {
  return result.warnings.map((warning) => `${warning.location} ${warning.message}`).join('\n');
}

function configureEmptyTableSource(config: Record<string, unknown>): void {
  config['sidebarSources'] = [{
    id: 'index',
    label: 'Index',
    file: 'canon/index.md',
    parser: 'markdown-table',
    parserConfig: {
      sectionHeadingLevels: [2],
      columnAliases: {
        term: ['Wrong term'],
        source: ['Wrong source'],
        firstAppearance: ['Wrong first'],
        blankLink: ['Wrong blank'],
        status: ['Wrong status'],
        serial: ['Wrong serial'],
      },
    },
    order: 1,
  }];
}

function configureWritingStatusSource(config: Record<string, unknown>): void {
  config['localePreset'] = 'en';
  config['sidebarSources'] = [{
    id: 'status',
    label: 'Status',
    file: 'writing-status.md',
    parser: 'heading-sections',
    parserConfig: {
      kind: 'writingStatus',
      lastRefreshedRegex: 'Last refreshed: ([0-9-]+)',
      stopChapterRegex: 'Story stop: Chapter (\\d+)',
    },
    order: 1,
  }];
}

test('valid config exits cleanly with no warnings', () => {
  withVault((vaultRoot, config) => {
    writeConfig(vaultRoot, config);
    const result = validateProjectConfig(vaultRoot);
    assert.deepEqual(result, { valid: true, errors: [], warnings: [] });
    assert.match(formatValidateConfigResult(result), /配置有效。\n未发现告警。/);

    const cli = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli/validate-config.ts', vaultRoot, '--json'],
      { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' },
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(JSON.parse(cli.stdout), { valid: true, errors: [], warnings: [] });
  });
});

test('valid config accepts strict prompt overrides without warnings', () => {
  withVault((vaultRoot, config) => {
    config['prompts'] = {
      overrides: {
        plannerFactRule: 'Separate confirmed facts from inference.',
      },
    };
    writeConfig(vaultRoot, config);
    assert.deepEqual(
      validateProjectConfig(vaultRoot),
      { valid: true, errors: [], warnings: [] },
    );

    config['prompts'] = { overrides: { unknownPrompt: 'rejected' } };
    writeConfig(vaultRoot, config);
    const invalid = validateProjectConfig(vaultRoot);
    assert.equal(invalid.valid, false);
    assert.match(invalid.errors.map((error) => error.location).join('\n'), /prompts\.overrides/);
  });
});

test('lint config reports invalid patterns as errors and unknown disabled ids as warnings', () => {
  withVault((vaultRoot, config) => {
    config['lint'] = {
      disableBuiltinStyleRules: ['style.empty-preface', 'style.not-installed'],
    };
    writeConfig(vaultRoot, config);
    const warned = validateProjectConfig(vaultRoot);
    assert.equal(warned.valid, true);
    assert.deepEqual(warned.warnings, [{
      location: '.writing-studio/project.json:lint.disableBuiltinStyleRules.1',
      message: '未知内置 style ruleId：style.not-installed',
    }]);

    config['lint'] = {
      styleRules: [{
        ruleId: 'project.invalid',
        pattern: '(',
        message: '不会进入运行时。',
        severity: 'warning',
        category: 'style',
      }],
    };
    writeConfig(vaultRoot, config);
    const invalid = validateProjectConfig(vaultRoot);
    assert.equal(invalid.valid, false);
    assert.match(
      invalid.errors.map((error) => `${error.location} ${error.message}`).join('\n'),
      /lint\.styleRules\.0\.pattern.*compilable JavaScript regular expression/,
    );
    assert.deepEqual(invalid.warnings, []);
  });
});

test('lint config warns about a nested-quantifier pattern without rejecting the config', () => {
  withVault((vaultRoot, config) => {
    config['lint'] = {
      styleRules: [{
        ruleId: 'project.pathological',
        pattern: '([^。]+)+x',
        message: '需要人工收窄。',
        severity: 'warning',
        category: 'style',
      }],
    };
    writeConfig(vaultRoot, config);
    const result = validateProjectConfig(vaultRoot);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
    assert.equal(result.warnings.length, 1);
    assert.equal(
      result.warnings[0]?.location,
      '.writing-studio/project.json:lint.styleRules.0.pattern',
    );
    assert.match(result.warnings[0]?.message ?? '', /疑似含嵌套量词.*灾难性回溯并阻塞服务/);
  });
});

test('en locale warns when configured lint features have no built-in consumers', () => {
  withVault((vaultRoot, config) => {
    config['localePreset'] = 'en';
    config['lint'] = {
      disableBuiltinStyleRules: ['style.empty-preface'],
      idiomStackList: ['大惊失色', '惊慌失措'],
    };
    writeConfig(vaultRoot, config);
    assert.deepEqual(validateProjectConfig(vaultRoot).warnings, [
      {
        location: '.writing-studio/project.json:lint.disableBuiltinStyleRules',
        message: '当前 localePreset 的内置规则包为空，disableBuiltinStyleRules 配置不会生效',
      },
      {
        location: '.writing-studio/project.json:lint.idiomStackList',
        message: '当前 localePreset 没有成语堆叠检测，idiomStackList 配置不会生效',
      },
    ]);
  });
});

test('en locale without dead lint configuration receives no lint warnings', () => {
  withVault((vaultRoot, config) => {
    config['localePreset'] = 'en';
    config['lint'] = {};
    writeConfig(vaultRoot, config);
    assert.deepEqual(validateProjectConfig(vaultRoot).warnings, []);
  });
});

test('zh-CN locale keeps built-in lint configuration effective and warning-free', () => {
  withVault((vaultRoot, config) => {
    config['localePreset'] = 'zh-CN';
    config['lint'] = {
      disableBuiltinStyleRules: ['style.empty-preface'],
      idiomStackList: ['大惊失色', '惊慌失措'],
    };
    writeConfig(vaultRoot, config);
    assert.deepEqual(validateProjectConfig(vaultRoot).warnings, []);
  });
});

test('zh-CN locale warns when the idiom detector itself was disabled', () => {
  withVault((vaultRoot, config) => {
    config['localePreset'] = 'zh-CN';
    config['lint'] = {
      disableBuiltinStyleRules: ['style.idiom-stack'],
      idiomStackList: ['大惊失色', '惊慌失措'],
    };
    writeConfig(vaultRoot, config);
    assert.deepEqual(validateProjectConfig(vaultRoot).warnings, [
      {
        location: '.writing-studio/project.json:lint.idiomStackList',
        message: '成语堆叠检测已被 disableBuiltinStyleRules 关闭（style.idiom-stack），idiomStackList 配置不会生效',
      },
    ]);
  });
});

test('schema-invalid config has errors and CLI exits 1', () => {
  withVault((vaultRoot, config) => {
    config['schemaVersion'] = 2;
    writeConfig(vaultRoot, config);
    const result = validateProjectConfig(vaultRoot);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);

    const cli = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli/validate-config.ts', vaultRoot, '--json'],
      { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' },
    );
    assert.equal(cli.status, 1, cli.stderr);
    const json = JSON.parse(cli.stdout) as ValidateConfigResult;
    assert.equal(json.valid, false);
    assert.ok(json.errors.length > 0);
    assert.deepEqual(Object.keys(json), ['valid', 'errors', 'warnings']);
  });
});

test('schema union errors expand to field-level sidebar locations', () => {
  withVault((vaultRoot, config) => {
    config['sidebarSources'] = [{
      id: 'broken',
      label: '',
      file: 'status.md',
      parser: 'heading-sections',
      parserConfig: {
        kind: 'writingStatus',
        lastRefreshedRegex: '(',
        stopChapterRegex: '(',
      },
      order: 'first',
    }];
    writeConfig(vaultRoot, config);
    const result = validateProjectConfig(vaultRoot);
    const locations = result.errors.map((error) => error.location);
    assert.equal(result.valid, false);
    assert.ok(locations.includes('.writing-studio/project.json:sidebarSources.0.label'));
    assert.ok(locations.includes('.writing-studio/project.json:sidebarSources.0.order'));
    assert.ok(locations.includes(
      '.writing-studio/project.json:sidebarSources.0.parserConfig.lastRefreshedRegex',
    ));
    assert.equal(
      result.errors.length === 1 && result.errors[0]?.message === 'Invalid input',
      false,
    );
  });
});

test('missing sidebar and graph reference files produce located warnings', () => {
  withVault((vaultRoot, config) => {
    config['sidebarSources'] = [{
      id: 'status',
      label: 'Status',
      file: 'canon/missing.md',
      parser: 'heading-sections',
      parserConfig: {
        kind: 'writingStatus',
        lastRefreshedRegex: 'refreshed: (.+)',
        stopChapterRegex: 'stop: (\\d+)',
      },
      order: 1,
    }];
    config['graph'] = {
      schemaVersion: 1,
      relationsFile: 'canon/relations.md',
      stopSourceId: 'status',
    };
    writeConfig(vaultRoot, config);
    const output = warnings(validateProjectConfig(vaultRoot));
    assert.match(output, /sidebarSources\.0\.file \(canon\/missing\.md\).*引用文件不存在/);
    assert.match(output, /graph\.relationsFile \(canon\/relations\.md\).*引用文件不存在/);
  });
});

test('sidebar path that exists as a directory is reported as non-regular', () => {
  withVault((vaultRoot, config) => {
    config['sidebarSources'] = [{
      id: 'status',
      label: 'Status',
      file: 'canon/status.md',
      parser: 'heading-sections',
      parserConfig: {
        kind: 'writingStatus',
        lastRefreshedRegex: 'refreshed: (.+)',
        stopChapterRegex: 'stop: (\\d+)',
      },
      order: 1,
    }];
    mkdirSync(join(vaultRoot, 'canon/status.md'), { recursive: true });
    writeConfig(vaultRoot, config);
    assert.match(
      warnings(validateProjectConfig(vaultRoot)),
      /sidebarSources\.0\.file \(canon\/status\.md\).*引用路径不是普通文件/,
    );
  });
});

test('existing source with zero parser output produces a located warning', () => {
  withVault((vaultRoot, config) => {
    config['sidebarSources'] = [{
      id: 'index',
      label: 'Index',
      file: 'canon/index.md',
      parser: 'markdown-table',
      parserConfig: {
        sectionHeadingLevels: [2],
        columnAliases: {
          term: ['Term'],
          source: ['Source'],
          firstAppearance: ['First'],
          blankLink: ['Blank'],
          status: ['Status'],
          serial: ['Serial'],
        },
      },
      order: 1,
    }];
    mkdirSync(join(vaultRoot, 'canon'), { recursive: true });
    writeFileSync(join(vaultRoot, 'canon/index.md'), '# Empty\n');
    writeConfig(vaultRoot, config);
    assert.match(
      warnings(validateProjectConfig(vaultRoot)),
      /canon\/index\.md \(sidebarSources\.0\.file\).*按当前 parserConfig 解析不到内容/,
    );
  });
});

test('writing-status metadata without any content section produces a dedicated warning', () => {
  withVault((vaultRoot, config) => {
    configureWritingStatusSource(config);
    writeFileSync(join(vaultRoot, 'writing-status.md'), [
      '# Writing status',
      '> Last refreshed: 2026-07-25',
      '> Story stop: Chapter 12',
    ].join('\n'));
    writeConfig(vaultRoot, config);
    const output = warnings(validateProjectConfig(vaultRoot));
    assert.match(output, /writing-status\.md .*结构命中但内容段均为空/);
    assert.doesNotMatch(output, /按当前 parserConfig 解析不到内容/);
  });
});

test('writing-status pristine scaffold remains exempt from content warnings', () => {
  withVault((vaultRoot, config) => {
    configureWritingStatusSource(config);
    writeFileSync(join(vaultRoot, 'writing-status.md'), [
      '<!-- writing-studio:scaffold — delete this line after adding content -->',
      '# Writing status',
      '## Stop point',
      '## Storylines',
      '## Active foreshadow overview',
      '| ID | Content | Status |',
      '| --- | --- | --- |',
      '## Character one-line status',
      '## Writing red lines',
      '## Expression baseline',
    ].join('\n'));
    writeConfig(vaultRoot, config);
    assert.equal(warnings(validateProjectConfig(vaultRoot)), '');
  });
});

test('writing-status with normal content does not produce the empty-section warning', () => {
  withVault((vaultRoot, config) => {
    configureWritingStatusSource(config);
    writeFileSync(join(vaultRoot, 'writing-status.md'), [
      '> Last refreshed: 2026-07-25',
      '> Story stop: Chapter 12',
      '## Stop point',
      'The scene ends at the gate.',
    ].join('\n'));
    writeConfig(vaultRoot, config);
    assert.doesNotMatch(
      warnings(validateProjectConfig(vaultRoot)),
      /结构命中但内容段均为空/,
    );
  });
});

test('scaffold marker only exempts a pristine structural scaffold', () => {
  withVault((vaultRoot, config) => {
    config['sidebarSources'] = [{
      id: 'index',
      label: 'Index',
      file: 'canon/index.md',
      parser: 'markdown-table',
      parserConfig: {
        sectionHeadingLevels: [2],
        columnAliases: {
          term: ['Wrong term'],
          source: ['Wrong source'],
          firstAppearance: ['Wrong first'],
          blankLink: ['Wrong blank'],
          status: ['Wrong status'],
          serial: ['Wrong serial'],
        },
      },
      order: 1,
    }];
    mkdirSync(join(vaultRoot, 'canon'), { recursive: true });
    writeConfig(vaultRoot, config);
    const marker = '<!-- writing-studio:骨架 —— 填入内容后请删除本行 -->';
    const warningPattern = /canon\/index\.md .*按当前 parserConfig 解析不到内容/;

    writeFileSync(join(vaultRoot, 'canon/index.md'), [
      marker,
      '## 地点',
      '| 编号 | 术语 |',
      '| --- | --- |',
    ].join('\n'));
    assert.doesNotMatch(warnings(validateProjectConfig(vaultRoot)), warningPattern);

    writeFileSync(join(vaultRoot, 'canon/index.md'), [
      marker,
      '<!--',
      '结构示例（复制到注释外使用）：',
      '## 地点',
      '| 编号 | 术语 |',
      '| --- | --- |',
      '| S-01 | 术语A |',
      '-->',
    ].join('\n'));
    assert.doesNotMatch(warnings(validateProjectConfig(vaultRoot)), warningPattern);

    writeFileSync(join(vaultRoot, 'canon/index.md'), [
      marker,
      '<!--',
      '## 地点',
      '| 编号 | 术语 |',
      '| --- | --- |',
      '-->',
      '| S-01 | 术语A |',
    ].join('\n'));
    assert.match(warnings(validateProjectConfig(vaultRoot)), warningPattern);

    writeFileSync(join(vaultRoot, 'canon/index.md'), [
      marker,
      '## 地点',
      '| 编号 | 术语 |',
      '| --- | --- |',
      '| S-01 | 术语A |',
    ].join('\n'));
    assert.match(warnings(validateProjectConfig(vaultRoot)), warningPattern);

    writeFileSync(join(vaultRoot, 'canon/index.md'), [
      marker,
      '# 设定索引',
      '这里已经有正文。',
    ].join('\n'));
    assert.match(warnings(validateProjectConfig(vaultRoot)), warningPattern);

    writeFileSync(join(vaultRoot, 'canon/index.md'), [
      '# 设定索引',
      '正文提及 writing-studio:骨架 —— 填入内容后请删除本行。',
    ].join('\n'));
    assert.match(warnings(validateProjectConfig(vaultRoot)), warningPattern);

    // The marker must be the FIRST non-empty line: a purely structural file
    // with the marker buried after a heading is not a shipped scaffold.
    writeFileSync(join(vaultRoot, 'canon/index.md'), [
      '## 地点',
      marker,
      '| 编号 | 术语 |',
      '| --- | --- |',
    ].join('\n'));
    assert.match(warnings(validateProjectConfig(vaultRoot)), warningPattern);

    // An unclosed <!-- must cancel the exemption: it would otherwise swallow
    // author content (a lost --> is a reachable editing mistake) forever.
    writeFileSync(join(vaultRoot, 'canon/index.md'), [
      marker,
      '<!--',
      '## 地点',
      '| 编号 | 术语 |',
      '| --- | --- |',
      '| S-01 | 术语A |',
    ].join('\n'));
    assert.match(warnings(validateProjectConfig(vaultRoot)), warningPattern);
  });
});

test('a second table separator cannot make a filled data row look pristine', () => {
  withVault((vaultRoot, config) => {
    configureEmptyTableSource(config);
    mkdirSync(join(vaultRoot, 'canon'), { recursive: true });
    writeFileSync(join(vaultRoot, 'canon/index.md'), [
      '<!-- writing-studio:骨架 —— 填入内容后请删除本行 -->',
      '## 地点',
      '| 编号 | 术语 |',
      '| --- | --- |',
      '| S-01 | 术语A |',
      '| --- | --- |',
    ].join('\n'));
    writeConfig(vaultRoot, config);
    assert.match(
      warnings(validateProjectConfig(vaultRoot)),
      /canon\/index\.md .*按当前 parserConfig 解析不到内容/,
    );
  });
});

test('a scaffold table header followed by its first separator remains pristine', () => {
  withVault((vaultRoot, config) => {
    configureEmptyTableSource(config);
    mkdirSync(join(vaultRoot, 'canon'), { recursive: true });
    writeFileSync(join(vaultRoot, 'canon/index.md'), [
      '<!-- writing-studio:骨架 —— 填入内容后请删除本行 -->',
      '## 地点',
      '| 编号 | 术语 |',
      '| --- | --- |',
    ].join('\n'));
    writeConfig(vaultRoot, config);
    assert.equal(warnings(validateProjectConfig(vaultRoot)), '');
  });
});

test('content filled inside a scaffold comment produces a parsing hint', () => {
  withVault((vaultRoot, config) => {
    configureEmptyTableSource(config);
    mkdirSync(join(vaultRoot, 'canon'), { recursive: true });
    writeFileSync(join(vaultRoot, 'canon/index.md'), [
      '<!-- writing-studio:骨架 —— 填入内容后请删除本行 -->',
      '<!--',
      '作者把正式内容写在这里。',
      '-->',
    ].join('\n'));
    writeConfig(vaultRoot, config);
    const output = warnings(validateProjectConfig(vaultRoot));
    assert.match(output, /该文件仍是骨架（内容写在注释块内不会被解析）/);
    assert.doesNotMatch(output, /按当前 parserConfig 解析不到内容/);
  });
});

test('the built-in character scaffold comment does not produce a parsing hint', () => {
  withVault((vaultRoot, config) => {
    configureEmptyTableSource(config);
    mkdirSync(join(vaultRoot, 'canon'), { recursive: true });
    writeFileSync(join(vaultRoot, 'canon/index.md'), [
      '<!-- writing-studio:骨架 —— 填入内容后请删除本行 -->',
      '<!--',
      '结构示例（复制到注释外使用；每个角色一张 ## 卡片）：',
      '## 角色名',
      '### 角色定位',
      '一句话定位。',
      '-->',
    ].join('\n'));
    writeConfig(vaultRoot, config);
    assert.equal(warnings(validateProjectConfig(vaultRoot)), '');
  });
});

test('the built-in scaffold comment with CRLF line endings does not produce a parsing hint', () => {
  withVault((vaultRoot, config) => {
    configureEmptyTableSource(config);
    mkdirSync(join(vaultRoot, 'canon'), { recursive: true });
    writeFileSync(join(vaultRoot, 'canon/index.md'), [
      '<!-- writing-studio:骨架 —— 填入内容后请删除本行 -->',
      '<!--',
      '结构示例（复制到注释外使用；每个角色一张 ## 卡片）：',
      '## 角色名',
      '### 角色定位',
      '一句话定位。',
      '-->',
    ].join('\r\n'));
    writeConfig(vaultRoot, config);
    assert.equal(warnings(validateProjectConfig(vaultRoot)), '');
  });
});

test('the built-in scaffold comment indented by an editor does not produce a parsing hint', () => {
  withVault((vaultRoot, config) => {
    configureEmptyTableSource(config);
    mkdirSync(join(vaultRoot, 'canon'), { recursive: true });
    writeFileSync(join(vaultRoot, 'canon/index.md'), [
      '<!-- writing-studio:骨架 —— 填入内容后请删除本行 -->',
      '<!--',
      '  结构示例（复制到注释外使用；每个角色一张 ## 卡片）：',
      '  ## 角色名',
      '  ### 角色定位',
      '  一句话定位。',
      '-->',
    ].join('\n'));
    writeConfig(vaultRoot, config);
    assert.equal(warnings(validateProjectConfig(vaultRoot)), '');
  });
});

test('content filled outside a scaffold comment uses the existing empty-parser warning', () => {
  withVault((vaultRoot, config) => {
    configureEmptyTableSource(config);
    mkdirSync(join(vaultRoot, 'canon'), { recursive: true });
    writeFileSync(join(vaultRoot, 'canon/index.md'), [
      '<!-- writing-studio:骨架 —— 填入内容后请删除本行 -->',
      '<!--',
      '结构示例（复制到注释外使用；每个角色一张 ## 卡片）：',
      '## 角色名',
      '### 角色定位',
      '一句话定位。',
      '-->',
      '作者把正式内容写在注释外。',
    ].join('\n'));
    writeConfig(vaultRoot, config);
    const output = warnings(validateProjectConfig(vaultRoot));
    assert.match(output, /按当前 parserConfig 解析不到内容/);
    assert.doesNotMatch(output, /内容写在注释块内不会被解析/);
  });
});

test('en locale preset parses a full writing-status fixture without an empty warning', () => {
  withVault((vaultRoot, config) => {
    config['localePreset'] = 'en';
    config['sidebarSources'] = [{
      id: 'status',
      label: 'Status',
      file: 'writing-status.md',
      parser: 'heading-sections',
      parserConfig: {
        kind: 'writingStatus',
        lastRefreshedRegex: 'Last refreshed: ([0-9-]+)',
        stopChapterRegex: 'Story stop: Chapter (\\d+)',
      },
      order: 1,
    }];
    writeFileSync(join(vaultRoot, 'writing-status.md'), [
      '> Last refreshed: 2026-07-22',
      '> Story stop: Chapter 1',
      '## Stop point', 'The first line has been written.',
      '## Storylines', '- **Main**: Continue',
      '## Active foreshadow overview',
      '| ID | Content | Status |', '| - | - | - |', '| F1 | A clue | Open |',
      '## Character one-line status', '- **Character A**: Waiting',
      '## Writing red lines', '1. No spoilers.',
      '## Expression baseline', 'Be precise.',
    ].join('\n'));
    writeConfig(vaultRoot, config);
    const result = validateProjectConfig(vaultRoot);
    assert.equal(result.valid, true);
    assert.equal(result.warnings.length, 0);
  });
});

test('title template without title placeholder produces a warning', () => {
  withVault((vaultRoot, config) => {
    const leaf = (config['contentTree'] as { leaf: Record<string, unknown> }).leaf;
    leaf['titleTemplate'] = 'Chapter {num}';
    writeConfig(vaultRoot, config);
    assert.match(warnings(validateProjectConfig(vaultRoot)), /titleTemplate.*不含 \{title\}/);
  });
});

test('blank title template warns on the root cause and skips the strip cross-check', () => {
  withVault((vaultRoot, config) => {
    const leaf = (config['contentTree'] as { leaf: Record<string, unknown> }).leaf;
    leaf['titleTemplate'] = '   ';
    leaf['titleStripRegex'] = '^Never Matches';
    writeConfig(vaultRoot, config);
    const output = warnings(validateProjectConfig(vaultRoot));
    assert.match(output, /titleTemplate.*渲染样例为空或纯空白/);
    // Root-cause attribution: a template that cannot round-trip at all must not
    // additionally blame titleStripRegex.
    assert.doesNotMatch(output, /章标题显示将包含整条 H1/);
  });
});

test('strip mismatch is reported for round-trippable templates', () => {
  withVault((vaultRoot, config) => {
    const leaf = (config['contentTree'] as { leaf: Record<string, unknown> }).leaf;
    leaf['titleStripRegex'] = '^Never Matches';
    writeConfig(vaultRoot, config);
    assert.match(
      warnings(validateProjectConfig(vaultRoot)),
      /titleStripRegex.*章标题显示将包含整条 H1/,
    );
  });
});

test('title strip regex does not accidentally consume the private-use probe', () => {
  withVault((vaultRoot, config) => {
    const leaf = (config['contentTree'] as { leaf: Record<string, unknown> }).leaf;
    leaf['titleTemplate'] = '{title}';
    leaf['titleStripRegex'] = '_+$';
    writeConfig(vaultRoot, config);
    assert.equal(validateProjectConfig(vaultRoot).warnings.length, 0);
  });
});

test('a strip regex tuned only to chapter one fails the two-number probe', () => {
  withVault((vaultRoot, config) => {
    const leaf = (config['contentTree'] as { leaf: Record<string, unknown> }).leaf;
    delete leaf['titleTemplate'];
    leaf['titleStripRegex'] = '^第一章\\s*';
    writeConfig(vaultRoot, config);
    assert.match(
      warnings(validateProjectConfig(vaultRoot)),
      /titleStripRegex.*章标题显示将包含整条 H1/,
    );
  });
});

test('a multiline template warns that chapter creation will be rejected', () => {
  withVault((vaultRoot, config) => {
    const leaf = (config['contentTree'] as { leaf: Record<string, unknown> }).leaf;
    leaf['titleTemplate'] = 'Chapter {num}\n{title}';
    writeConfig(vaultRoot, config);
    assert.match(
      warnings(validateProjectConfig(vaultRoot)),
      /titleTemplate.*建章会被服务端拒绝/,
    );
  });
});

test('validation never mutates the vault', () => {
  withVault((vaultRoot, config) => {
    mkdirSync(join(vaultRoot, '正文'), { recursive: true });
    writeFileSync(join(vaultRoot, '正文/chapter-1.md'), '# Chapter 1: Start\n\n正文。\n');
    writeConfig(vaultRoot, config);
    const snapshot = (): string => JSON.stringify(
      ['正文/chapter-1.md', '.writing-studio/project.json'].map((file) => {
        const stat = statSync(join(vaultRoot, file));
        return [file, stat.size, stat.mtimeMs, stat.ino];
      }),
    );
    const before = snapshot();
    assert.equal(validateProjectConfig(vaultRoot).valid, true);
    assert.equal(snapshot(), before);
  });
});

test('CLI help documents the absolute-path pnpm form', () => {
  const cli = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli/validate-config.ts', '--help'],
    {
      cwd: resolve(import.meta.dirname, '..'),
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /pnpm --filter @writing-studio\/server validate-config/);
  assert.match(cli.stdout, /absolute-vault-root/);
  // Some sandboxes prepend certificate-trust noise to every spawned node's
  // stderr (same environment caveat as agent-runtime.test.ts); only the CLI's
  // own lines must be absent.
  assert.equal(withoutRuntimeNoise(cli.stderr), '');
});

test('JSON argument errors use stderr and exit 2', () => {
  const cli = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli/validate-config.ts', '--json'],
    {
      cwd: resolve(import.meta.dirname, '..'),
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    },
  );
  assert.equal(cli.status, 2);
  assert.equal(cli.stdout, '');
  const json = JSON.parse(withoutRuntimeNoise(cli.stderr)) as ValidateConfigResult;
  assert.equal(json.valid, false);
  assert.equal(json.errors[0]?.location, '<args>');
});
