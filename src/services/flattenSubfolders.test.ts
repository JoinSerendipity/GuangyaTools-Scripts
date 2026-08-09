import { describe, expect, it } from 'vitest';
import { FileType, type GuangyaItem } from '../types';
import type { GuangyaApiLike, WalkResult } from './guangyaApi';
import { createFlattenPlan, flattenDirectories, flattenOneDirectory } from './flattenSubfolders';

const item = (id: string, name: string, parentId: string, resType: 1 | 2): GuangyaItem => ({
  fileId: id, fileName: name, fileSize: resType === 1 ? 10 : 0,
  parentId, parentName: '', depth: 1, dirType: 0, resType,
  fileType: resType === 1 ? FileType.DOCUMENT : FileType.UNKNOWN,
  ext: resType === 1 ? 'txt' : '', fullParentIds: parentId, ctime: 0, utime: 0,
});
const walk = (items: GuangyaItem[]): WalkResult => ({
  items,
  directories: items.filter((entry) => entry.resType === 2),
  files: items.filter((entry) => entry.resType === 1),
  itemById: new Map(items.map((entry) => [entry.fileId, entry])),
});

describe('flatten subfolders', () => {
  it('skips target-name conflicts but moves the first duplicate candidate name', () => {
    const root = item('r', 'Root', '', 2);
    const entries = [
      item('top', 'Top', 'r', 2), item('existing', 'same.txt', 'r', 1),
      item('a', 'Same.TXT', 'top', 1), item('b', 'dup.txt', 'top', 1),
      item('c', 'DUP.txt', 'top', 1), item('d', 'ok.txt', 'top', 1),
      item('e', 'top', 'top', 1),
    ];
    const plan = createFlattenPlan(root, walk(entries));
    expect(plan.movableFiles.map((entry) => entry.fileId)).toEqual(['b', 'd']);
    expect(plan.conflicts.map(({ item, reason }) => [item.fileId, reason])).toEqual([
      ['a', 'target-name-exists'],
      ['c', 'duplicate-candidate-name'],
      ['e', 'target-name-exists'],
    ]);
  });

  it('submits target-name and candidate-name conflicts in Guangya default mode', async () => {
    const root = item('r', 'Root', '', 2);
    const sourceA = item('source-a', 'A', 'r', 2);
    const sourceB = item('source-b', 'B', 'r', 2);
    const existing = item('existing', 'same.txt', 'r', 1);
    const targetConflict = item('same', 'SAME.txt', 'source-a', 1);
    const duplicateA = item('dup-a', 'dup.txt', 'source-a', 1);
    const duplicateB = item('dup-b', 'DUP.txt', 'source-b', 1);
    const moved: string[][] = [];
    let walkCount = 0;
    const api: GuangyaApiLike = {
      listAllChildren: async () => [],
      renameItem: async () => undefined,
      walkDescendants: async () => (++walkCount === 1
        ? walk([sourceA, sourceB, existing, targetConflict, duplicateA, duplicateB])
        : walk([])),
      moveItems: async (ids) => { moved.push(ids); return `move-${moved.length}`; },
      trashItems: async () => 'trash-task',
      waitTask: async () => undefined,
    };
    const result = await flattenOneDirectory(api, root, { conflictMode: 'guangya-default' });
    expect(moved).toEqual([['same', 'dup-a'], ['dup-b']]);
    expect(result.movedFiles.map((entry) => entry.fileId)).toEqual(['same', 'dup-a', 'dup-b']);
    expect(result.conflicts).toEqual([]);
  });

  it('trashes only the candidate conflict and then its verified empty parent directory', async () => {
    const root = item('r', 'Root', '', 2);
    const top = item('top', 'Top', 'r', 2);
    const existing = item('existing', 'same.txt', 'r', 1);
    const conflict = item('conflict', 'SAME.txt', 'top', 1);
    const trashed: string[][] = [];
    let walkCount = 0;
    const api: GuangyaApiLike = {
      listAllChildren: async () => [],
      renameItem: async () => undefined,
      walkDescendants: async () => (++walkCount === 1 ? walk([top, existing, conflict]) : walk([])),
      moveItems: async () => { throw new Error('must not move a conflict'); },
      trashItems: async (ids) => { trashed.push(ids); return `trash-${trashed.length}`; },
      waitTask: async () => undefined,
    };
    const result = await flattenOneDirectory(api, root, { conflictMode: 'trash-conflicts' });
    expect(trashed).toEqual([['conflict'], ['top']]);
    expect(trashed.flat()).not.toContain('existing');
    expect(result.trashedConflictFiles).toEqual([conflict]);
    expect(result.trashedConflictDirectories).toEqual([top]);
    expect(result.trashedTopDirectories).toEqual([]);
  });

  it('retains the conflict parent directory when another file remains', async () => {
    const root = item('r', 'Root', '', 2);
    const top = item('top', 'Top', 'r', 2);
    const existing = item('existing', 'same.txt', 'r', 1);
    const conflict = item('conflict', 'SAME.txt', 'top', 1);
    const remaining = item('remaining', 'other.txt', 'top', 1);
    const trashed: string[][] = [];
    let walkCount = 0;
    const api: GuangyaApiLike = {
      listAllChildren: async () => [],
      renameItem: async () => undefined,
      walkDescendants: async () => (++walkCount === 1 ? walk([top, existing, conflict, remaining]) : walk([remaining])),
      moveItems: async () => { throw new Error('move failed'); },
      trashItems: async (ids) => { trashed.push(ids); return `trash-${trashed.length}`; },
      waitTask: async () => undefined,
    };
    const result = await flattenOneDirectory(api, root, { conflictMode: 'trash-conflicts' });
    expect(trashed).toEqual([['conflict']]);
    expect(result.trashedConflictDirectories).toEqual([]);
    expect(result.retainedTopDirectories).toEqual([top]);
  });

  it('moves files from different source parent directories in separate move requests', async () => {
    const root = item('r', 'Root', '', 2);
    const dirA = item('a-dir', 'A', 'r', 2);
    const dirB = item('b-dir', 'B', 'r', 2);
    const fileA = item('a-file', 'a.txt', 'a-dir', 1);
    const fileB = item('b-file', 'b.txt', 'b-dir', 1);
    const moved: string[][] = [];
    let walkCount = 0;
    const api: GuangyaApiLike = {
      listAllChildren: async () => [],
      renameItem: async () => undefined,
      walkDescendants: async () => (++walkCount === 1 ? walk([dirA, dirB, fileA, fileB]) : walk([])),
      moveItems: async (ids) => { moved.push(ids); return `move-${moved.length}`; },
      trashItems: async () => 'trash-task',
      waitTask: async () => undefined,
    };
    const result = await flattenOneDirectory(api, root, { batchSize: 50 });
    expect(moved).toEqual([['a-file'], ['b-file']]);
    expect(result.movedFiles.map((entry) => entry.fileId)).toEqual(['a-file', 'b-file']);
  });

  it('reports execution progress with the selected directory and source subfolder names', async () => {
    const root = item('r', 'Root', '', 2);
    const source = item('source', '来源子文件夹', 'r', 2);
    const nested = item('nested', 'move.txt', 'source', 1);
    const messages: string[] = [];
    let walkCount = 0;
    const api: GuangyaApiLike = {
      listAllChildren: async () => [],
      renameItem: async () => undefined,
      walkDescendants: async () => (++walkCount === 1 ? walk([source, nested]) : walk([])),
      moveItems: async () => 'move-task',
      trashItems: async () => 'trash-task',
      waitTask: async () => undefined,
    };
    await flattenDirectories(api, [root], { batchSize: 50, onProgress: (progress) => messages.push(progress.message) });
    expect(messages.some((message) => message.includes('「Root」'))).toBe(true);
    expect(messages.some((message) => message.includes('来源子文件夹「来源子文件夹」'))).toBe(true);
  });

  it('moves files and only then trashes a verified empty top directory', async () => {
    const root = item('r', 'Root', '', 2);
    const top = item('top', 'Top', 'r', 2);
    const nested = item('nested', 'move.txt', 'top', 1);
    const moved: string[][] = [];
    const trashed: string[][] = [];
    let walkCount = 0;
    const api: GuangyaApiLike = {
      listAllChildren: async () => [],
      renameItem: async () => undefined,
      walkDescendants: async () => (++walkCount === 1 ? walk([top, nested]) : walk([])),
      moveItems: async (ids) => { moved.push(ids); return 'move-task'; },
      trashItems: async (ids) => { trashed.push(ids); return 'trash-task'; },
      waitTask: async () => undefined,
    };
    const result = await flattenOneDirectory(api, root, { batchSize: 10 });
    expect(moved).toEqual([['nested']]);
    expect(trashed).toEqual([['top']]);
    expect(result.movedFiles).toEqual([nested]);
    expect(result.trashedTopDirectories).toEqual([top]);
  });

  it('retains a top directory when a conflict file remains', async () => {
    const root = item('r', 'Root', '', 2);
    const top = item('top', 'Top', 'r', 2);
    const existing = item('existing', 'same.txt', 'r', 1);
    const conflict = item('nested', 'SAME.txt', 'top', 1);
    let walkCount = 0;
    const api: GuangyaApiLike = {
      listAllChildren: async () => [],
      renameItem: async () => undefined,
      walkDescendants: async () => (++walkCount === 1 ? walk([top, existing, conflict]) : walk([conflict])),
      moveItems: async () => { throw new Error('must not move'); },
      trashItems: async () => { throw new Error('must not trash'); },
      waitTask: async () => undefined,
    };
    const result = await flattenOneDirectory(api, root);
    expect(result.conflicts).toHaveLength(1);
    expect(result.retainedTopDirectories).toEqual([top]);
    expect(result.trashedTopDirectories).toEqual([]);
  });
});
