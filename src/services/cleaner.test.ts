import { describe, expect, it } from 'vitest';
import { FileType, type CleanupRule, type GuangyaItem } from '../types';
import { filterCleanupMatches, matchesCleanupRule, validateCleanupRule } from './cleaner';

const file = (overrides: Partial<GuangyaItem> = {}): GuangyaItem => ({
  fileId: '1', fileName: 'Advertisement.TXT', fileSize: 2 * 1024 * 1024,
  parentId: 'root', parentName: '', depth: 1, dirType: 0, resType: 1,
  fileType: FileType.DOCUMENT, ext: 'TXT', fullParentIds: 'root', ctime: 0, utime: 0,
  ...overrides,
});
const rule = (overrides: Partial<CleanupRule> = {}): CleanupRule => ({
  id: 'r1', enabled: true, kind: 'fileName', pattern: 'advertisement',
  matchMode: 'contains', caseSensitive: false, ...overrides,
});

describe('cleanup rules', () => {
  it('matches suffix case-insensitively and applies the size ceiling', () => {
    expect(matchesCleanupRule(file(), rule({ kind: 'suffix', pattern: 'txt', maxSizeMb: 2 }))).toBe(true);
    expect(matchesCleanupRule(file(), rule({ kind: 'suffix', pattern: 'txt', maxSizeMb: 1.99 }))).toBe(false);
  });

  it('matches file type', () => {
    expect(matchesCleanupRule(file(), rule({ kind: 'fileType', pattern: '', fileType: FileType.DOCUMENT }))).toBe(true);
    expect(matchesCleanupRule(file(), rule({ kind: 'fileType', pattern: '', fileType: FileType.VIDEO }))).toBe(false);
  });

  it('supports contains, exact, case-sensitive and regexp matching', () => {
    expect(matchesCleanupRule(file(), rule())).toBe(true);
    expect(matchesCleanupRule(file(), rule({ pattern: 'advertisement.txt', matchMode: 'equals' }))).toBe(true);
    expect(matchesCleanupRule(file(), rule({ pattern: 'advertisement.txt', matchMode: 'equals', caseSensitive: true }))).toBe(false);
    expect(matchesCleanupRule(file(), rule({ pattern: '^Advertisement\\.[A-Z]+$', matchMode: 'regex', caseSensitive: true }))).toBe(true);
  });

  it('only applies directory-name rules to directories', () => {
    const directory = file({ resType: 2, fileName: '广告目录', fileSize: 0 });
    expect(matchesCleanupRule(directory, rule({ kind: 'dirName', pattern: '广告' }))).toBe(true);
    expect(matchesCleanupRule(file(), rule({ kind: 'dirName', pattern: 'Advertisement' }))).toBe(false);
  });

  it('reports invalid regexp and de-duplicates union matches', () => {
    expect(validateCleanupRule(rule({ matchMode: 'regex', pattern: '[' }))).toContain('正则表达式无效');
    const matches = filterCleanupMatches([file()], [rule(), rule({ id: 'r2', pattern: 'TXT' })]);
    expect(matches).toHaveLength(1);
    expect(matches[0].ruleIds).toEqual(['r1', 'r2']);
  });
});
