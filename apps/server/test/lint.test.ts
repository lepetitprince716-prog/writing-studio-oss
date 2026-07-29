import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DEFAULT_SLOW_RULE_BUDGET_MS,
  lintText,
  loadSensitiveWords,
  parseSensitiveWords,
} from '../src/lint.js';

const CASES = [
  {
    ruleId: 'style.for-regarding',
    bad: '对于守城的老兵而言，今夜比往常更冷。',
    good: '守城的老兵觉得今夜比往常更冷。',
  },
  {
    ruleId: 'style.vague-degree',
    bad: '在某种程度上，她已经原谅了父亲。',
    good: '她不再恨父亲，却还不肯回家。',
  },
  {
    ruleId: 'style.empty-preface',
    bad: '值得注意的是，这份清单还没有核对完。',
    good: '这份清单还没有核对完。',
  },
  {
    ruleId: 'style.empty-summary',
    bad: '总而言之，他们这趟没有白来。',
    good: '他们带回了失踪商队的账册。',
  },
  {
    ruleId: 'style.paired-conjunction',
    bad: '她不仅记得那张脸，而且记得袖口缺了一颗扣子。',
    good: '她记得那张脸，也记得袖口缺了一颗扣子。',
  },
  {
    ruleId: 'style.neutral-passive',
    bad: '那封信被保存进了城主的铁匣。',
    good: '管家把那封信收进城主的铁匣。',
  },
  {
    ruleId: 'style.nominalized-verb',
    bad: '巡夜人对脚印进行了详细分析。',
    good: '巡夜人仔细看过脚印。',
  },
  {
    ruleId: 'style.idiom-stack',
    bad: '警报一响，他大惊失色，继而惊慌失措地摔了手机。',
    good: '警报一响，他愣了一下，随后冷静下来。',
  },
  {
    ruleId: 'style.de-chain',
    bad: '她望着窗外的结冰的沉默的河。',
    good: '她望着窗外。河面结了冰，一片沉默。',
  },
  {
    ruleId: 'style.dangling-opener',
    bad: '随着计时器归零，面板上的指示灯依次熄灭。',
    good: '计时器归零后，面板上的指示灯依次熄灭。',
  },
] as const;

for (const example of CASES) {
  test(`${example.ruleId} has a realistic hit and non-hit example`, () => {
    assert.equal(
      lintText(example.bad).some((finding) => finding.ruleId === example.ruleId),
      true,
      example.bad,
    );
    assert.equal(
      lintText(example.good).some((finding) => finding.ruleId === example.ruleId),
      false,
      example.good,
    );
  });
}

test('style offsets use UTF-16 positions and sensitive words find every literal occurrence', () => {
  const text = '月亮🌙升起。值得注意的是，禁词藏在这里；禁词又出现了。';
  const findings = lintText(text, ['禁词']);
  const style = findings.find((finding) => finding.ruleId === 'style.empty-preface');
  assert.equal(style?.offset, text.indexOf('值得注意的是'));
  assert.deepEqual(
    findings.filter((finding) => finding.category === 'sensitive').map((finding) => finding.offset),
    [text.indexOf('禁词'), text.lastIndexOf('禁词')],
  );
});

test('dangling-opener pack predicate excludes its sentence-boundary delimiter', () => {
  const text = '前句结束。随着计时器归零，指示灯熄灭。';
  const finding = lintText(text)
    .find((candidate) => candidate.ruleId === 'style.dangling-opener');
  assert.equal(finding?.offset, text.indexOf('随着'));
  assert.equal(finding?.length, '随着计时器归零，'.length);
});

test('sensitive list supports comments, blanks, deduplication, and missing-file disablement', () => {
  assert.deepEqual(
    parseSensitiveWords('# 作者备注\n禁词\n\n另一个词\n禁词\n'),
    ['另一个词', '禁词'],
  );
  const root = mkdtempSync(join(tmpdir(), 'writing-studio-lint-'));
  try {
    assert.deepEqual(loadSensitiveWords(root), []);
    mkdirSync(join(root, '.writing-studio'));
    writeFileSync(join(root, '.writing-studio', 'sensitive-words.txt'), '# note\n甲\n乙\n');
    assert.deepEqual(loadSensitiveWords(root), ['甲', '乙']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('neutral-passive heuristic does not flag adverse passive voice', () => {
  assert.equal(
    lintText('他在渡口被雨淋湿，包袱也被人抢走。')
      .some((finding) => finding.ruleId === 'style.neutral-passive'),
    false,
  );
});

test('project style rules append and override built-ins by ruleId', () => {
  const custom = lintText('灯塔再次照亮灯塔。', [], {
    lint: {
      styleRules: [{
        ruleId: 'project.repetition',
        pattern: '灯塔',
        message: '项目自定义重复提示。',
        severity: 'info',
        category: 'style',
      }],
    },
  });
  assert.deepEqual(
    custom.map((finding) => ({
      ruleId: finding.ruleId,
      message: finding.message,
      severity: finding.severity,
      offset: finding.offset,
    })),
    [
      {
        ruleId: 'project.repetition',
        message: '项目自定义重复提示。',
        severity: 'info',
        offset: 0,
      },
      {
        ruleId: 'project.repetition',
        message: '项目自定义重复提示。',
        severity: 'info',
        offset: 6,
      },
    ],
  );

  const overridden = lintText('值得注意的是，门开了。', [], {
    lint: {
      styleRules: [{
        ruleId: 'style.empty-preface',
        pattern: '门开了',
        message: '覆盖后的项目规则。',
        severity: 'error',
        category: 'style',
      }],
    },
  });
  assert.deepEqual(overridden.map((finding) => finding.message), ['覆盖后的项目规则。']);
  assert.equal(overridden[0]?.severity, 'error');
});

test('built-in rules can be disabled without disabling a same-id custom rule', () => {
  const disabled = lintText('值得注意的是，门开了。', [], {
    lint: { disableBuiltinStyleRules: ['style.empty-preface'] },
  });
  assert.equal(disabled.some((finding) => finding.ruleId === 'style.empty-preface'), false);

  const custom = lintText('值得注意的是，门开了。', [], {
    lint: {
      disableBuiltinStyleRules: ['style.empty-preface'],
      styleRules: [{
        ruleId: 'style.empty-preface',
        pattern: '门开了',
        message: '同 id 自定义规则仍生效。',
        severity: 'info',
        category: 'style',
      }],
    },
  });
  assert.deepEqual(custom.map((finding) => finding.message), ['同 id 自定义规则仍生效。']);
});

test('en locale selects an empty built-in pack while retaining custom rules', () => {
  const text = '值得注意的是，门开了。';
  assert.deepEqual(lintText(text, [], { localePreset: 'en' }), []);
  const findings = lintText(text, [], {
    localePreset: 'en',
    lint: {
      styleRules: [{
        ruleId: 'project.door',
        pattern: '门开了',
        message: 'The door opens.',
        severity: 'warning',
        category: 'style',
      }],
    },
  });
  assert.deepEqual(findings.map((finding) => finding.ruleId), ['project.door']);
});

test('zero slow-rule budget reports every executed rule without wall-clock assumptions', () => {
  const ruleIds: string[] = [];
  lintText('alpha beta', [], {
    localePreset: 'en',
    lint: {
      styleRules: [
        {
          ruleId: 'project.alpha',
          pattern: 'alpha',
          message: 'Alpha.',
          severity: 'info',
          category: 'style',
        },
        {
          ruleId: 'project.beta',
          pattern: 'beta',
          message: 'Beta.',
          severity: 'warning',
          category: 'style',
        },
      ],
    },
  }, {
    slowRuleBudgetMs: 0,
    onSlowRule: ({ ruleId }) => ruleIds.push(ruleId),
  });
  assert.deepEqual(ruleIds.sort(), ['project.alpha', 'project.beta']);
});

test('large slow-rule budget does not report fast rules', () => {
  const ruleIds: string[] = [];
  lintText('alpha', [], {
    localePreset: 'en',
    lint: {
      styleRules: [{
        ruleId: 'project.alpha',
        pattern: 'alpha',
        message: 'Alpha.',
        severity: 'info',
        category: 'style',
      }],
    },
  }, {
    slowRuleBudgetMs: 10_000,
    onSlowRule: ({ ruleId }) => ruleIds.push(ruleId),
  });
  assert.deepEqual(ruleIds, []);
});

// The four timestamps below pair up only because `localePreset: 'en'` selects
// the empty built-in pack, leaving exactly one rule and therefore exactly two
// performance.now() calls per lintText. Giving the en pack built-in rules would
// surface here as a confusing `notEqual(timestamp, undefined)` failure.
test('the built-in budget applies exactly when no explicit budget is given', (context) => {
  assert.equal(DEFAULT_SLOW_RULE_BUDGET_MS, 250);
  const timestamps = [
    1_000,
    1_000 + DEFAULT_SLOW_RULE_BUDGET_MS - 1,
    2_000,
    2_000 + DEFAULT_SLOW_RULE_BUDGET_MS,
  ];
  context.mock.method(performance, 'now', () => {
    const timestamp = timestamps.shift();
    assert.notEqual(timestamp, undefined);
    return timestamp;
  });

  const ruleIds: string[] = [];
  const config: NonNullable<Parameters<typeof lintText>[2]> = {
    localePreset: 'en',
    lint: {
      styleRules: [{
        ruleId: 'project.alpha',
        pattern: 'alpha',
        message: 'Alpha.',
        severity: 'info',
        category: 'style',
      }],
    },
  };
  const timingOptions: NonNullable<Parameters<typeof lintText>[3]> = {
    onSlowRule: ({ ruleId }) => ruleIds.push(ruleId),
  };

  lintText('alpha', [], config, timingOptions);
  lintText('alpha', [], config, timingOptions);

  assert.deepEqual(ruleIds, ['project.alpha']);
  assert.deepEqual(timestamps, []);
});

test('omitting timing options preserves finding bytes', () => {
  assert.deepEqual(
    lintText('alpha beta alpha', [], {
      localePreset: 'en',
      lint: {
        styleRules: [{
          ruleId: 'project.alpha',
          pattern: 'alpha',
          message: 'Alpha.',
          severity: 'info',
          category: 'style',
        }],
      },
    }),
    [
      {
        ruleId: 'project.alpha',
        category: 'style',
        message: 'Alpha.',
        offset: 0,
        length: 5,
        severity: 'info',
      },
      {
        ruleId: 'project.alpha',
        category: 'style',
        message: 'Alpha.',
        offset: 11,
        length: 5,
        severity: 'info',
      },
    ],
  );
});

test('project idiomStackList replaces the built-in idiom vocabulary', () => {
  const text = '他大惊失色，随后惊慌失措。';
  assert.equal(lintText(text).some((finding) => finding.ruleId === 'style.idiom-stack'), true);
  assert.equal(
    lintText(text, [], { lint: { idiomStackList: ['大惊失色'] } })
      .some((finding) => finding.ruleId === 'style.idiom-stack'),
    false,
  );
});

test('en locale ignores a configured idiomStackList because its pack has no detector', () => {
  assert.deepEqual(
    lintText('他大惊失色，随后惊慌失措。', [], {
      localePreset: 'en',
      lint: { idiomStackList: ['大惊失色', '惊慌失措'] },
    }),
    [],
  );
});

test('sensitive list fails closed on a symlink instead of following it outside the vault', () => {
  const root = mkdtempSync(join(tmpdir(), 'writing-studio-lint-link-'));
  const outside = join(root, 'outside.txt');
  try {
    mkdirSync(join(root, 'vault', '.writing-studio'), { recursive: true });
    writeFileSync(outside, '外部秘密\n');
    symlinkSync(outside, join(root, 'vault', '.writing-studio', 'sensitive-words.txt'));
    assert.deepEqual(loadSensitiveWords(join(root, 'vault')), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
