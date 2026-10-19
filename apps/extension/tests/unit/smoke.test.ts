import { describe, it, expect } from 'vitest';

describe('test environment', () => {
  it('runs under jsdom with DOM APIs available', () => {
    const el = document.createElement('textarea');
    el.value = 'hello';
    document.body.appendChild(el);
    expect(el.value).toBe('hello');
    expect(typeof Range).toBe('function');
  });
});
