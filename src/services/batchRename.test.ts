import { describe, expect, it } from 'vitest';
import { FileType, type BatchRenamePlan, type BatchRenameRules, type GuangyaItem, type RenamePlanEntry } from '../types';
import {
  DEFAULT_BATCH_RENAME_RULES,
  applyRenameRules,
  createBatchRenamePlan,
  executeBatchRename,
  splitFileName,
  validateGuangyaName,
} from './batchRename';

const item = (fileId: string, fileName: string, resType: 1 | 2 = 1): GuangyaItem => ({
  fileId,
  fileName,
  fileSize: 0,
  parentId: 'root',
  parentName: '',
  depth: 1,
  dirType: 0,
  resType,
  fileType: FileType.UNKNOWN,
  ext: resType === 1 ? splitFileName(fileName).extension.replace(/^\./, '') : '',
  fullParentIds: 'root',
  ctime: 0,
  utime: 0,
});

const rules = (overrides: Partial<BatchRenameRules> = {}): BatchRenameRules => ({
  ...DEFAULT_BATCH_RENAME_RULES,
  ...overrides,
});

const planFrom = (entries: Array<[GuangyaItem, string]>): BatchRenamePlan => {
  const ready: RenamePlanEntry[] = entries.map(([entry, finalName]) => ({
    item: entry,
    originalName: entry.fileName,
    requestedName: finalName,
    finalName,
    status: 'ready',
    manual: true,
  }));
  return { entries: ready, ready };
};

describe('batch rename rules', () => {
  it('splits only the last extension and preserves it by default', () => {
    expect(splitFileName('archive.tar.gz')).toEqual({ stem: 'archive.tar', extension: '.gz' });
    expect(splitFileName('README')).toEqual({ stem: 'README', extension: '' });
    expect(applyRenameRules(item('1', 'movie.mkv'), rules({ prefix: '前缀-', suffix: '-后缀' }), 0)).toBe('前缀-movie-后缀.mkv');
    expect(applyRenameRules(item('2', 'folder.name', 2), rules({ prefix: 'X-' }), 0)).toBe('X-folder.name');
  });

  it('supports ordinary and regular-expression replacement plus sequence formatting', () => {
    expect(applyRenameRules(item('1', 'Episode ABC.mp4'), rules({ search: 'episode', replacement: 'EP' }), 0)).toBe('EP ABC.mp4');
    expect(applyRenameRules(item('1', 'S01E02.mkv'), rules({ search: '^S(\\d+)E(\\d+)$', replacement: '$1-$2', useRegex: true }), 0)).toBe('01-02.mkv');
    expect(applyRenameRules(item('1', 'name.txt'), rules({
      sequenceEnabled: true,
      sequenceStart: 8,
      sequenceStep: 2,
      sequencePadding: 3,
      sequencePosition: 'prefix',
      sequenceSeparator: '-',
    }), 2)).toBe('012-name.txt');
  });

  it('uses manual overrides as the final requested name', () => {
    const source = item('1', 'old.txt');
    const plan = createBatchRenamePlan([source], [source], rules({ prefix: 'auto-' }), 'skip', new Map([['1', 'manual.txt']]));
    expect(plan.entries[0]).toMatchObject({ requestedName: 'manual.txt', finalName: 'manual.txt', manual: true, status: 'ready' });
  });
});

describe('Guangya filename validation', () => {
  it('mirrors native invalid-name checks', () => {
    expect(validateGuangyaName('')).toContain('不能为空');
    expect(validateGuangyaName('.hidden')).toContain('以 . 开头');
    expect(validateGuangyaName('bad?.txt')).toContain('特殊字符');
    expect(validateGuangyaName('bad\u0001.txt')).toContain('控制字符');
    expect(validateGuangyaName('CON.txt')).toContain('Windows 保留名称');
    expect(validateGuangyaName('a..txt')).toContain('连续的点');
    expect(validateGuangyaName(`${'a'.repeat(256)}`)).toContain('255');
    expect(validateGuangyaName('有效名称.txt')).toBeNull();
  });
});

describe('batch rename conflict planning', () => {
  it('skips conflicts while allowing selected names to be swapped', () => {
    const a = item('a', 'A.txt');
    const b = item('b', 'B.txt');
    const taken = item('taken', 'Taken.txt');
    const swap = createBatchRenamePlan([a, b], [a, b, taken], rules(), 'skip', { a: 'B.txt', b: 'A.txt' });
    expect(swap.ready.map((entry) => entry.item.fileId)).toEqual(['a', 'b']);

    const conflict = createBatchRenamePlan([a, b], [a, b, taken], rules(), 'skip', { a: 'Taken.txt', b: 'taken.TXT' });
    expect(conflict.entries.map((entry) => entry.status)).toEqual(['conflict', 'conflict']);
  });

  it('propagates conflicts when a skipped item keeps occupying its original name', () => {
    const a = item('a', 'A.txt');
    const b = item('b', 'B.txt');
    const taken = item('taken', 'Taken.txt');
    const plan = createBatchRenamePlan([a, b], [a, b, taken], rules(), 'skip', { a: 'B.txt', b: 'Taken.txt' });
    expect(plan.entries.map((entry) => entry.status)).toEqual(['conflict', 'conflict']);
  });

  it('reserves the original name of invalid selected entries during auto-suffix planning', () => {
    const a = item('a', 'A.txt');
    const b = item('b', 'B.txt');
    const plan = createBatchRenamePlan([a, b], [a, b], rules(), 'auto-suffix', { a: 'bad?.txt', b: 'A.txt' });
    expect(plan.entries[0].status).toBe('invalid');
    expect(plan.entries[1].finalName).toBe('A (1).txt');
  });

  it('auto-appends suffixes before file extensions', () => {
    const a = item('a', 'A.txt');
    const b = item('b', 'B.txt');
    const taken = item('taken', 'Taken.txt');
    const plan = createBatchRenamePlan([a, b], [a, b, taken], rules(), 'auto-suffix', { a: 'Taken.txt', b: 'taken.txt' });
    expect(plan.ready.map((entry) => entry.finalName)).toEqual(['Taken (1).txt', 'taken (2).txt']);
  });
});

describe('batch rename dependency execution', () => {
  it('orders acyclic renames by current name occupancy', async () => {
    const a = item('a', 'A.txt');
    const b = item('b', 'B.txt');
    const calls: string[] = [];
    const result = await executeBatchRename(
      { renameItem: async (fileId, newName) => { calls.push(`${fileId}:${newName}`); } },
      planFrom([[b, 'A.txt'], [a, 'C.txt']]),
      [a, b],
    );
    expect(calls).toEqual(['a:C.txt', 'b:A.txt']);
    expect(result.succeeded).toHaveLength(2);
  });

  it('uses a temporary name to swap two occupied names', async () => {
    const a = item('a', 'A.txt');
    const b = item('b', 'B.txt');
    const calls: string[] = [];
    const result = await executeBatchRename(
      { renameItem: async (fileId, newName) => { calls.push(`${fileId}:${newName}`); } },
      planFrom([[a, 'B.txt'], [b, 'A.txt']]),
      [a, b],
      { temporaryNameFactory: () => 'TMP.txt' },
    );
    expect(calls).toEqual(['a:TMP.txt', 'b:A.txt', 'a:B.txt']);
    expect(result.succeeded.map((entry) => entry.item.fileId).sort()).toEqual(['a', 'b']);
    expect(result.failures).toEqual([]);
  });

  it('supports a three-item rename cycle', async () => {
    const a = item('a', 'A.txt');
    const b = item('b', 'B.txt');
    const c = item('c', 'C.txt');
    const calls: string[] = [];
    const result = await executeBatchRename(
      { renameItem: async (fileId, newName) => { calls.push(`${fileId}:${newName}`); } },
      planFrom([[a, 'B.txt'], [b, 'C.txt'], [c, 'A.txt']]),
      [a, b, c],
      { temporaryNameFactory: () => 'TMP.txt' },
    );
    expect(calls).toEqual(['a:TMP.txt', 'c:A.txt', 'b:C.txt', 'a:B.txt']);
    expect(result.succeeded).toHaveLength(3);
  });

  it('stops before submitting work when already canceled', async () => {
    const a = item('a', 'A.txt');
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const result = await executeBatchRename(
      { renameItem: async () => { calls += 1; } },
      planFrom([[a, 'B.txt']]),
      [a],
      { signal: controller.signal },
    );
    expect(calls).toBe(0);
    expect(result.canceled).toBe(true);
    expect(result.skipped.map((entry) => entry.item.fileId)).toEqual(['a']);
  });

  it('finishes an already-submitted rename and cancels later entries', async () => {
    const a = item('a', 'A.txt');
    const b = item('b', 'B.txt');
    const controller = new AbortController();
    const calls: string[] = [];
    const result = await executeBatchRename(
      {
        renameItem: async (fileId, newName) => {
          calls.push(`${fileId}:${newName}`);
          controller.abort();
        },
      },
      planFrom([[a, 'C.txt'], [b, 'D.txt']]),
      [a, b],
      { signal: controller.signal },
    );
    expect(calls).toEqual(['a:C.txt']);
    expect(result.succeeded.map((entry) => entry.item.fileId)).toEqual(['a']);
    expect(result.skipped.map((entry) => entry.item.fileId)).toEqual(['b']);
    expect(result.canceled).toBe(true);
  });

  it('stops all later renames when a write outcome is unknown', async () => {
    const a = item('a', 'A.txt');
    const b = item('b', 'B.txt');
    const calls: string[] = [];
    const unknown = Object.assign(new Error('response lost'), { outcome: 'outcome-unknown' });
    const result = await executeBatchRename(
      {
        renameItem: async (fileId, newName) => {
          calls.push(`${fileId}:${newName}`);
          throw unknown;
        },
      },
      planFrom([[a, 'C.txt'], [b, 'D.txt']]),
      [a, b],
    );
    expect(calls).toEqual(['a:C.txt']);
    expect(result.outcomeUnknown).toBe(true);
    expect(result.skipped.map((entry) => entry.item.fileId)).toEqual(['b']);
    expect(result.residualRisks.join(' ')).toContain('刷新确认');
  });

  it('does not attempt automatic rollback after an unknown cycle write', async () => {
    const a = item('a', 'A.txt');
    const b = item('b', 'B.txt');
    const calls: string[] = [];
    const unknown = Object.assign(new Error('response lost'), { outcome: 'outcome-unknown' });
    const result = await executeBatchRename(
      {
        renameItem: async (fileId, newName) => {
          calls.push(`${fileId}:${newName}`);
          if (fileId === 'b') throw unknown;
        },
      },
      planFrom([[a, 'B.txt'], [b, 'A.txt']]),
      [a, b],
      { temporaryNameFactory: () => 'TMP.txt' },
    );
    expect(calls).toEqual(['a:TMP.txt', 'b:A.txt']);
    expect(result.outcomeUnknown).toBe(true);
    expect(result.residualRisks.join(' ')).toContain('未继续提交或自动回滚');
  });

  it('rolls a cycle back when a rename inside the cycle fails', async () => {
    const a = item('a', 'A.txt');
    const b = item('b', 'B.txt');
    const calls: string[] = [];
    const result = await executeBatchRename(
      {
        renameItem: async (fileId, newName) => {
          calls.push(`${fileId}:${newName}`);
          if (fileId === 'b' && newName === 'A.txt') throw new Error('server failed');
        },
      },
      planFrom([[a, 'B.txt'], [b, 'A.txt']]),
      [a, b],
      { temporaryNameFactory: () => 'TMP.txt' },
    );
    expect(calls).toEqual(['a:TMP.txt', 'b:A.txt', 'a:A.txt']);
    expect(result.succeeded).toEqual([]);
    expect(result.failures.some((failure) => failure.error === 'server failed')).toBe(true);
    expect(result.residualRisks).toEqual([]);
  });
});
