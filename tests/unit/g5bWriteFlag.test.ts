import { describe, it, expect, afterEach } from 'vitest';
import { __setG5BGenericWriteFlagForTests, isG5BGenericWriteEnabled } from '@/lib/services/g5bWriteFlag';

describe('g5bWriteFlag', () => {
  afterEach(() => {
    __setG5BGenericWriteFlagForTests(undefined);
    delete process.env.G5B_GENERIC_WRITE_ENABLED;
  });

  it('defaults to off when the env var is unset', () => {
    delete process.env.G5B_GENERIC_WRITE_ENABLED;
    expect(isG5BGenericWriteEnabled()).toBe(false);
  });

  it('is off for any value other than the exact string "true" (fail closed on misconfiguration)', () => {
    process.env.G5B_GENERIC_WRITE_ENABLED = 'TRUE';
    expect(isG5BGenericWriteEnabled()).toBe(false);
    process.env.G5B_GENERIC_WRITE_ENABLED = '1';
    expect(isG5BGenericWriteEnabled()).toBe(false);
    process.env.G5B_GENERIC_WRITE_ENABLED = '';
    expect(isG5BGenericWriteEnabled()).toBe(false);
  });

  it('is on for the exact string "true"', () => {
    process.env.G5B_GENERIC_WRITE_ENABLED = 'true';
    expect(isG5BGenericWriteEnabled()).toBe(true);
  });

  it('the deterministic test override takes precedence over the env var, in both directions', () => {
    process.env.G5B_GENERIC_WRITE_ENABLED = 'true';
    __setG5BGenericWriteFlagForTests(false);
    expect(isG5BGenericWriteEnabled()).toBe(false);

    delete process.env.G5B_GENERIC_WRITE_ENABLED;
    __setG5BGenericWriteFlagForTests(true);
    expect(isG5BGenericWriteEnabled()).toBe(true);
  });

  it('resetting the override to undefined falls back to consulting the env var again', () => {
    __setG5BGenericWriteFlagForTests(true);
    expect(isG5BGenericWriteEnabled()).toBe(true);
    __setG5BGenericWriteFlagForTests(undefined);
    delete process.env.G5B_GENERIC_WRITE_ENABLED;
    expect(isG5BGenericWriteEnabled()).toBe(false);
  });
});
