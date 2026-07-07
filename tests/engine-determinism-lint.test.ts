/**
 * 決定性機械化把關(取代 ESLint 自訂規則,零新依賴):
 * src/engine/ 內禁止任何非 IEEE-754 跨引擎保證的數學函數與時間/隨機源。
 * 只有 + − × ÷、Math.sqrt、Math.imul 是 byte 級決定性的。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENGINE_DIR = fileURLToPath(new URL('../src/engine', import.meta.url));

const BANNED = [
  /Math\.(sin|cos|tan|asin|acos|atan|atan2|hypot|pow|exp|expm1|log|log2|log10|log1p|cbrt|sinh|cosh|tanh|random)\b/,
  /\bDate\.now\b/,
  /\bnew Date\b/,
  /\bperformance\.now\b/,
  /[\w)\]]\s*\*\*\s*[\w(]/, // 指數運算子 = Math.pow(排除註解星號)
];

/** 粗略剝掉 block comment 與行註解,lint 只看真程式碼 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

describe('engine 決定性 lint', () => {
  const files = readdirSync(ENGINE_DIR).filter((f: string) => f.endsWith('.ts'));

  it('src/engine/ 內至少有引擎檔', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} 無被禁的數學/時間/隨機呼叫`, () => {
      const src = stripComments(readFileSync(`${ENGINE_DIR}/${file}`, 'utf8'));
      const lines = src.split('\n');
      const violations: string[] = [];
      lines.forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '');
        for (const pattern of BANNED) {
          if (pattern.test(code)) violations.push(`${file}:${i + 1} ${line.trim()}`);
        }
      });
      expect(violations).toEqual([]);
    });
  }
});
