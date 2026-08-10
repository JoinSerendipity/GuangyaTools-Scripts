import { beforeEach, describe, expect, it } from 'vitest';
import { FileType, type CleanupRule } from '../types';
import { __resetMonkeyStorage, GM_getValue, GM_setValue } from '../test/monkeyStub';
import {
  CLEANER_DEFAULTS_STORAGE_KEY,
  clearCleanerDefaults,
  createCleanupRule,
  loadCleanerDefaults,
  saveCleanerDefaults,
  serializeCleanerDefaultsPreset,
} from './cleanerDefaults';

function rule(overrides: Partial<CleanupRule> = {}): CleanupRule {
  return {
    ...createCleanupRule('suffix'),
    pattern: 'mkv',
    ...overrides,
  };
}

beforeEach(() => {
  __resetMonkeyStorage();
});

describe('cleaner default rules storage', () => {
  it('stores rules without runtime IDs and defaults recursive to false when omitted', () => {
    const source = rule({ id: 'runtime-id', maxSizeMb: 20 });
    saveCleanerDefaults([source], { includeRecursive: false, recursive: true });

    const stored = GM_getValue<Record<string, unknown>>(CLEANER_DEFAULTS_STORAGE_KEY);
    expect(stored).toMatchObject({ version: 1 });
    expect(stored).not.toHaveProperty('recursive');
    expect((stored.rules as Array<Record<string, unknown>>)[0]).not.toHaveProperty('id');

    const loaded = loadCleanerDefaults();
    expect(loaded.source).toBe('saved');
    expect(loaded.recursive).toBe(false);
    expect(loaded.includesRecursive).toBe(false);
    expect(loaded.rules[0]).toMatchObject({ pattern: 'mkv', maxSizeMb: 20 });
    expect(loaded.rules[0].id).not.toBe('runtime-id');
  });

  it('optionally persists either recursive value and removes an older recursive default when unchecked', () => {
    saveCleanerDefaults([rule()], { includeRecursive: true, recursive: true });
    expect(loadCleanerDefaults()).toMatchObject({ recursive: true, includesRecursive: true });

    saveCleanerDefaults([rule({ pattern: 'txt' })], { includeRecursive: true, recursive: false });
    expect(loadCleanerDefaults()).toMatchObject({ recursive: false, includesRecursive: true });

    saveCleanerDefaults([rule({ pattern: 'zip' })], { includeRecursive: false, recursive: true });
    expect(loadCleanerDefaults()).toMatchObject({ recursive: false, includesRecursive: false });
  });

  it('preserves all supported rule fields', () => {
    const rules = [
      rule({ kind: 'fileName', pattern: '^sample', matchMode: 'regex', caseSensitive: true, maxSizeMb: 1.5 }),
      rule({ kind: 'fileType', pattern: '', fileType: FileType.VIDEO, matchMode: 'equals' }),
      rule({ kind: 'dirName', pattern: '广告', matchMode: 'contains', enabled: false }),
    ];
    const preset = serializeCleanerDefaultsPreset(rules, { includeRecursive: true, recursive: false });
    expect(preset.rules).toEqual([
      { enabled: true, kind: 'fileName', pattern: '^sample', matchMode: 'regex', caseSensitive: true, maxSizeMb: 1.5 },
      { enabled: true, kind: 'fileType', pattern: '', fileType: FileType.VIDEO, matchMode: 'equals', caseSensitive: false },
      { enabled: false, kind: 'dirName', pattern: '广告', matchMode: 'contains', caseSensitive: false },
    ]);
    expect(preset.recursive).toBe(false);
  });

  it('rejects invalid enabled rules and a preset with no enabled rule without overwriting storage', () => {
    saveCleanerDefaults([rule({ pattern: 'old' })], { includeRecursive: false, recursive: false });
    expect(() => saveCleanerDefaults([
      rule({ kind: 'fileName', pattern: '[', matchMode: 'regex' }),
    ], { includeRecursive: false, recursive: false })).toThrow('无效');
    expect(() => saveCleanerDefaults([
      rule({ enabled: false }),
    ], { includeRecursive: false, recursive: false })).toThrow('至少启用');
    expect(loadCleanerDefaults().rules[0].pattern).toBe('old');
  });

  it('clears corrupt or unsupported stored data and safely falls back to the built-in txt rule', () => {
    GM_setValue(CLEANER_DEFAULTS_STORAGE_KEY, { version: 99, rules: [] });
    const loaded = loadCleanerDefaults();
    expect(loaded.source).toBe('fallback');
    expect(loaded.message).toContain('损坏或版本不兼容');
    expect(loaded.rules).toHaveLength(1);
    expect(loaded.rules[0]).toMatchObject({ kind: 'suffix', pattern: 'txt' });
    expect(GM_getValue(CLEANER_DEFAULTS_STORAGE_KEY, undefined)).toBeUndefined();
  });

  it('clears the saved preset and returns built-in defaults', () => {
    saveCleanerDefaults([rule()], { includeRecursive: true, recursive: true });
    const loaded = clearCleanerDefaults();
    expect(loaded).toMatchObject({ source: 'builtin', recursive: false, includesRecursive: false });
    expect(loaded.rules[0].pattern).toBe('txt');
    expect(GM_getValue(CLEANER_DEFAULTS_STORAGE_KEY, undefined)).toBeUndefined();
  });
});
