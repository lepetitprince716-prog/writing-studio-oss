import type { LintFinding } from '@writing-studio/contract';

interface StyleRuleBase {
  ruleId: string;
  message: string;
  severity: LintFinding['severity'];
  category: 'style';
}

interface AdjustedRegexMatch {
  offsetDelta: number;
  text: string;
}

export interface RegexStyleRule extends StyleRuleBase {
  kind: 'regex';
  pattern: RegExp;
  adjustMatch?: ((matched: string) => AdjustedRegexMatch) | undefined;
}

export interface IdiomStackStyleRule extends StyleRuleBase {
  kind: 'idiom-stack';
}

export type StyleRule = RegexStyleRule | IdiomStackStyleRule;

export interface LintRulePack {
  styleRules: readonly StyleRule[];
  idiomStackList: readonly string[];
}
