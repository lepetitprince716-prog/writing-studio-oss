import type { ProjectConfig } from '@writing-studio/contract';
import type { LintRulePack } from '../types.js';
import { zhCnLintRulePack } from './zh-CN.js';

const emptyLintRulePack: LintRulePack = {
  styleRules: [],
  idiomStackList: [],
};

export const builtinStyleRuleIds = new Set(
  zhCnLintRulePack.styleRules.map((rule) => rule.ruleId),
);

/** English projects intentionally receive no Chinese built-in style rules. */
export function lintRulePackForLocale(
  localePreset: ProjectConfig['localePreset'],
): LintRulePack {
  return localePreset === 'en' ? emptyLintRulePack : zhCnLintRulePack;
}
