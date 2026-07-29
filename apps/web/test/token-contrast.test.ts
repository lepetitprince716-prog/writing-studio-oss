import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const css = await readFile(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');

function block(pattern: RegExp): string {
  const match = css.match(pattern);
  assert.ok(match?.[1], `missing theme block: ${pattern}`);
  return match[1];
}

function color(source: string, variable: string): string {
  const match = source.match(new RegExp(`--${variable}:\\s*(#[0-9a-fA-F]{6})`));
  assert.ok(match?.[1], `missing --${variable}`);
  return match[1];
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const linear = channels.map((value) => (
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrast(first: string, second: string): number {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

function themeBlocks(): Array<{ name: string; source: string }> {
  return [
    {
      name: 'light',
      source: block(/:root,\s*:root\[data-theme='light'\]\s*\{([\s\S]*?)\n\}/),
    },
    {
      name: 'auto-dark',
      source: block(/:root:not\(\[data-theme='light'\]\):not\(\[data-theme='dark'\]\)\s*\{([\s\S]*?)\n\s*\}/),
    },
    {
      name: 'dark',
      source: block(/:root\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/),
    },
  ];
}

test('muted and warning text meet WCAG AA on every panel surface in light, auto-dark, and dark themes', () => {
  for (const { source: theme } of themeBlocks()) {
    const muted = color(theme, 'muted');
    const warning = color(theme, 'warning');
    for (const surface of ['bg', 'panel', 'panel-raised', 'accent-soft']) {
      assert.ok(
        contrast(muted, color(theme, surface)) >= 4.5,
        `${muted} fails AA against --${surface}`,
      );
      assert.ok(
        contrast(warning, color(theme, surface)) >= 4.5,
        `${warning} fails AA against --${surface}`,
      );
    }
    assert.ok(
      contrast(muted, color(theme, 'bg')) < contrast(color(theme, 'text-secondary'), color(theme, 'bg')),
      `${muted} no longer reads as quieter than --text-secondary`,
    );
  }
});

test('warning and danger indicators meet WCAG non-text contrast on the constant graph surface', () => {
  const themes = themeBlocks();
  const graphSurface = color(themes[0]!.source, 'graph-surface');
  assert.equal(graphSurface.toLowerCase(), '#17131f');
  const surfaces = [{ name: 'graph-surface', value: graphSurface, minimum: 3 }];

  for (const { name: themeName, source: theme } of themes) {
    for (const token of ['warning', 'danger']) {
      for (const surface of surfaces) {
        const ratio = contrast(color(theme, token), surface.value);
        assert.ok(
          ratio >= surface.minimum,
          `${themeName} --${token} has ${ratio.toFixed(2)}:1 against --${surface.name}`,
        );
      }
    }
  }
});
