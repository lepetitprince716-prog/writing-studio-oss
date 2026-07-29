import type { ProjectConfig, PromptBundle } from '@writing-studio/contract';
import { promptBundleForLocale } from './locales/index.js';

export function resolvePromptBundle(
  config: Pick<ProjectConfig, 'localePreset' | 'prompts'>,
): PromptBundle {
  const resolved = { ...promptBundleForLocale(config.localePreset) };
  for (const [key, value] of Object.entries(config.prompts?.overrides ?? {})) {
    if (value !== undefined) {
      resolved[key as keyof PromptBundle] = value;
    }
  }
  return resolved;
}
