import { describe, expect, it } from 'vitest';
import { defaultProfile, PROFILE_SCHEMA_VERSION } from '@jammarly/shared/profile';

describe('web workspace', () => {
  it('imports the shared package', () => {
    expect(defaultProfile().schemaVersion).toBe(PROFILE_SCHEMA_VERSION);
  });
});
