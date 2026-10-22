import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.resolve(here, '..', '..', '..', 'src', 'content', 'ui');

describe('overlay UI never uses HTML-string sinks (Trusted Types)', () => {
  const files = readdirSync(uiDir).filter((f) => f.endsWith('.ts'));

  it('finds the ui sources', () => {
    expect(files.length).toBeGreaterThanOrEqual(9);
    expect(files).toContain('overlay.ts');
    expect(files).toContain('dom.ts');
  });

  for (const file of files) {
    it(`${file} has no innerHTML/outerHTML/insertAdjacentHTML/document.write`, () => {
      const src = readFileSync(path.join(uiDir, file), 'utf8');
      const hits = src.match(/innerHTML|outerHTML|insertAdjacentHTML|document\s*\.\s*write/g) ?? [];
      expect(hits, `${file}: ${hits.join(', ')}`).toEqual([]);
    });
  }

  it('does not read chrome.storage from content UI code', () => {
    for (const file of files) {
      const src = readFileSync(path.join(uiDir, file), 'utf8');
      expect(src.includes('chrome.storage'), file).toBe(false);
    }
  });
});
