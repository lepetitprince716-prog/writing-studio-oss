import type { ProjectConfig, PromptBundle } from '@writing-studio/contract';
import { ZH_CN_PROMPT_BUNDLE } from './zh-CN.js';

export function promptBundleForLocale(
  localePreset: ProjectConfig['localePreset'],
): PromptBundle {
  // The en pack lands in T3. Until then, every preset intentionally preserves
  // the current zh-CN model-facing bytes.
  return ZH_CN_PROMPT_BUNDLE;
}
