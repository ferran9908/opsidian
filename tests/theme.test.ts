import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cssVariable, themes, type ThemeName, type ThemeToken } from '../packages/theme/src/index';

const tokens = readFileSync('packages/theme/src/tokens.css', 'utf8');
const tailwind = readFileSync('packages/theme/src/theme.css', 'utf8');
function block(selector: string): Record<string, string> {
  const body = new RegExp(`${selector} \\{([^}]*)\\}`).exec(tokens)![1]!;
  return Object.fromEntries(
    [...body.matchAll(/(--[a-z-]+): ([^;]+);/g)].map((match) => [match[1]!, match[2]!]),
  );
}

describe('theme stylesheet', () => {
  it.each([
    ['light', ':root'],
    ['dark', '\\.dark'],
  ] as [ThemeName, string][])('%s CSS tokens match the TypeScript values', (name, selector) => {
    const css = block(selector);
    for (const [token, value] of Object.entries(themes[name]))
      expect(css[cssVariable(token as ThemeToken)], token).toBe(value);
  });
  it('exposes every colour token to Tailwind', () => {
    for (const token of Object.keys(themes.light) as ThemeToken[]) {
      const name = cssVariable(token);
      expect(tailwind).toContain(`--color-${name.slice(2)}: var(${name});`);
    }
  });
});
