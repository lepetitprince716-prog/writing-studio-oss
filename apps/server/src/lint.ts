import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  LintFinding,
  LintStyleRuleConfig,
  ProjectConfig,
} from '@writing-studio/contract';
import { lintRulePackForLocale } from './lint/packs/index.js';
import type {
  IdiomStackStyleRule,
  RegexStyleRule,
  StyleRule,
} from './lint/types.js';

export const DEFAULT_SLOW_RULE_BUDGET_MS = 250;

export interface LintTimingOptions {
  /** Rules reaching or exceeding this budget fire onSlowRule. */
  slowRuleBudgetMs?: number | undefined;
  onSlowRule?: ((info: { ruleId: string; elapsedMs: number }) => void) | undefined;
}

function configuredStyleRule(rule: LintStyleRuleConfig): RegexStyleRule {
  return {
    kind: 'regex',
    ruleId: rule.ruleId,
    category: rule.category,
    message: rule.message,
    severity: rule.severity,
    pattern: new RegExp(rule.pattern, 'gu'),
  };
}

function resolveStyleRules(
  config: Pick<ProjectConfig, 'localePreset' | 'lint'> | undefined,
): { rules: StyleRule[]; idiomStackList: readonly string[] } {
  const pack = lintRulePackForLocale(config?.localePreset);
  const disabled = new Set(config?.lint?.disableBuiltinStyleRules ?? []);
  const configured = new Map(
    (config?.lint?.styleRules ?? []).map((rule) => [rule.ruleId, configuredStyleRule(rule)]),
  );
  const rules: StyleRule[] = [];

  for (const builtin of pack.styleRules) {
    if (disabled.has(builtin.ruleId)) continue;
    rules.push(configured.get(builtin.ruleId) ?? builtin);
    configured.delete(builtin.ruleId);
  }
  rules.push(...configured.values());

  return {
    rules,
    idiomStackList: config?.lint?.idiomStackList ?? pack.idiomStackList,
  };
}

function addRegexFindings(
  text: string,
  rule: RegexStyleRule,
  findings: LintFinding[],
): void {
  for (const match of text.matchAll(rule.pattern)) {
    if (match.index === undefined || match[0].length === 0) continue;
    const adjusted = rule.adjustMatch?.(match[0]) ?? { offsetDelta: 0, text: match[0] };
    if (adjusted.text.length === 0) continue;
    findings.push({
      ruleId: rule.ruleId,
      category: rule.category,
      message: rule.message,
      offset: match.index + adjusted.offsetDelta,
      length: adjusted.text.length,
      severity: rule.severity,
    });
  }
}

function addIdiomFindings(
  text: string,
  rule: IdiomStackStyleRule,
  idiomStackList: readonly string[],
  findings: LintFinding[],
): void {
  const sentences = /[^。！？\n]+[。！？]?/gu;
  for (const sentence of text.matchAll(sentences)) {
    if (sentence.index === undefined) continue;
    const matches = idiomStackList
      .map((idiom) => ({ idiom, index: sentence[0].indexOf(idiom) }))
      .filter((match) => match.index >= 0)
      .sort((left, right) => left.index - right.index);
    if (matches.length < 2) continue;
    const first = matches[0]!;
    const last = matches.at(-1)!;
    findings.push({
      ruleId: rule.ruleId,
      category: rule.category,
      message: rule.message,
      offset: sentence.index + first.index,
      length: last.index + last.idiom.length - first.index,
      severity: rule.severity,
    });
  }
}

/** Parse the author-maintained vault word list. Empty lines and # comments are ignored. */
export function parseSensitiveWords(source: string): string[] {
  return [...new Set(
    source
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#')),
  )].sort((left, right) => right.length - left.length || left.localeCompare(right, 'zh-CN'));
}

/** Missing word list is an intentional "sensitive lint disabled" state. */
export function loadSensitiveWords(vaultRoot: string): string[] {
  const path = join(vaultRoot, '.writing-studio', 'sensitive-words.txt');
  if (!existsSync(path)) return [];
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) return [];
  return parseSensitiveWords(readFileSync(path, 'utf8'));
}

/**
 * Pure deterministic rule engine. It never rewrites text and performs no I/O;
 * callers provide the optional author-maintained sensitive-word list and may
 * observe slow rules through a timing callback.
 */
export function lintText(
  text: string,
  sensitiveWords: readonly string[] = [],
  config?: Pick<ProjectConfig, 'localePreset' | 'lint'>,
  timingOptions?: LintTimingOptions,
): LintFinding[] {
  const findings: LintFinding[] = [];
  const { rules, idiomStackList } = resolveStyleRules(config);
  const onSlowRule = timingOptions?.onSlowRule;
  const slowRuleBudgetMs = timingOptions?.slowRuleBudgetMs ?? DEFAULT_SLOW_RULE_BUDGET_MS;
  for (const rule of rules) {
    if (!onSlowRule) {
      if (rule.kind === 'regex') addRegexFindings(text, rule, findings);
      else addIdiomFindings(text, rule, idiomStackList, findings);
      continue;
    }

    const startedAt = performance.now();
    if (rule.kind === 'regex') addRegexFindings(text, rule, findings);
    else addIdiomFindings(text, rule, idiomStackList, findings);
    const elapsedMs = performance.now() - startedAt;
    if (elapsedMs >= slowRuleBudgetMs) onSlowRule({ ruleId: rule.ruleId, elapsedMs });
  }

  for (const word of sensitiveWords) {
    if (!word) continue;
    let offset = text.indexOf(word);
    while (offset >= 0) {
      findings.push({
        ruleId: 'sensitive.word',
        category: 'sensitive',
        message: `命中作者维护的敏感词「${word}」；请按发布平台和语境人工复核。`,
        offset,
        length: word.length,
        severity: 'error',
      });
      offset = text.indexOf(word, offset + Math.max(1, word.length));
    }
  }

  return findings.sort((left, right) =>
    left.offset - right.offset
    || right.length - left.length
    || left.ruleId.localeCompare(right.ruleId));
}
