import { describe, expect, it } from 'vitest';
import { FileType, type GuangyaItem } from '../types';
import type { GuangyaApiLike, WalkResult } from './guangyaApi';
import { createOperationRequestContext } from './requestContext';
import {
  createFlattenPlan,
  createFlattenPreviewSnapshot,
  flattenDirectories,
  flattenOneDirectory,
  groupDisjointDirectoryWaves,
  orderDirectoriesForExecution,
  verifyFlattenPreviewSnapshot,
} from './flattenSubfolders';

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
  it('detects name/parent/topology drift before any flatten mutation', async () => {
    const root = item('root', 'Root', '', 2);
    const original = item('file', 'old.txt', 'root', 1);
    const movedParent = item('other', 'Other', 'root', 2);
    const changed = item('file', 'new.txt', 'other', 1);
    const originalEvidence = (): WalkResult => ({
      ...walk([original]), complete: true,
      directoryListings: new Map([['root', { parentId: 'root', observedTotal: 1, orderedChildIds: ['file'], complete: true }]]),
    });
    const changedEvidence = (): WalkResult => ({
      ...walk([movedParent, changed]), complete: true,
      directoryListings: new Map([
        ['root', { parentId: 'root', observedTotal: 1, orderedChildIds: ['other'], complete: true }],
        ['other', { parentId: 'other', observedTotal: 1, orderedChildIds: ['file'], complete: true }],
      ]),
    });
    const snapshot = createFlattenPreviewSnapshot(root, originalEvidence(), 'skip', 'auto');
    let mutations = 0;
    const api = {
      walkDescendants: async () => changedEvidence(),
      listAllChildren: async () => [], renameItem: async () => undefined,
      moveItems: async () => { mutations += 1; return 'task'; },
      trashItems: async () => { mutations += 1; return 'task'; }, waitTask: async () => undefined,
    } satisfies GuangyaApiLike;
    const checked = await verifyFlattenPreviewSnapshot(api, root, snapshot, {});
    expect(checked.unchanged).toBe(false);
    expect(mutations).toBe(0);
  });

  it('groups duplicate and overlapping preview roots into safe sequential waves', () => {
    const parent = item('a', 'A', 'root', 2);
    parent.fullParentIds = 'root';
    const child = item('b', 'B', 'a', 2);
    child.fullParentIds = 'root/a';
    const sibling = item('c', 'C', 'root', 2);
    sibling.fullParentIds = 'root';
    const waves = groupDisjointDirectoryWaves([parent, child, sibling, parent]);
    expect(waves.map((waveEntries) => waveEntries.map((entry) => entry.fileId))).toEqual([['a', 'c'], ['b']]);
    expect(orderDirectoriesForExecution([parent, child, sibling, parent]).map((entry) => entry.fileId)).toEqual(['b', 'a', 'c']);

    parent.fullParentIds = '';
    child.fullParentIds = '';
    const unknownBranch = item('d', 'D', 'unknown-parent', 2);
    unknownBranch.fullParentIds = '';
    expect(groupDisjointDirectoryWaves([parent, child, unknownBranch]).map((entries) => entries.map((entry) => entry.fileId)))
      .toEqual([['a'], ['b'], ['d']]);
    expect(orderDirectoriesForExecution([parent, child]).map((entry) => entry.fileId)).toEqual(['b', 'a']);
    const indirectDescendant = item('e', 'E', 'missing-middle', 2);
    indirectDescendant.fullParentIds = '';
    expect(() => orderDirectoriesForExecution([parent, indirectDescendant])).toThrow('请分开执行');
  });

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
    const purposes: Array<string | undefined> = [];
    let walkCount = 0;
    const api: GuangyaApiLike = {
      listAllChildren: async () => [],
      renameItem: async () => undefined,
      walkDescendants: async (_parentId, options) => {
        purposes.push(options?.purpose);
        return ++walkCount === 1 ? walk([top, nested]) : walk([]);
      },
      moveItems: async (ids) => { moved.push(ids); return 'move-task'; },
      trashItems: async (ids) => { trashed.push(ids); return 'trash-task'; },
      waitTask: async () => undefined,
    };
    const result = await flattenOneDirectory(api, root, { batchSize: 10 });
    expect(moved).toEqual([['nested']]);
    expect(trashed).toEqual([['top']]);
    expect(result.movedFiles).toEqual([nested]);
    expect(result.trashedTopDirectories).toEqual([top]);
    expect(purposes.every((purpose) => purpose === 'verification')).toBe(true);
  });

  it('keeps the accepted-task window at one for platform-reserved name equivalence', async () => {
    const root = item('r', 'Root', '', 2);
    const sourceA = item('a', 'A', 'r', 2);
    const sourceB = item('b', 'B', 'r', 2);
    const reserved = item('fa', 'CON.txt', 'a', 1);
    const normal = item('fb', 'normal.txt', 'b', 1);
    let walkCount = 0;
    let activeTasks = 0;
    let peakTasks = 0;
    const api: GuangyaApiLike = {
      listAllChildren: async () => [], renameItem: async () => undefined,
      walkDescendants: async () => (++walkCount === 1 ? walk([sourceA, sourceB, reserved, normal]) : walk([])),
      moveItems: async (_ids, _parentId) => `move-${walkCount}-${activeTasks}`,
      trashItems: async () => 'trash',
      waitTask: async () => {
        activeTasks += 1;
        peakTasks = Math.max(peakTasks, activeTasks);
        await new Promise((resolve) => setTimeout(resolve, 2));
        activeTasks -= 1;
      },
    };
    const result = await flattenOneDirectory(api, root, { context: createOperationRequestContext('fast') });
    expect(result.movedFiles).toHaveLength(2);
    expect(peakTasks).toBe(1);
  });

  it('recomputes deletion candidates from final stable topology and retains a reparented top directory', async () => {
    const root = item('r', 'Root', '', 2);
    const top = item('top', 'Top', 'r', 2);
    const nested = item('nested', 'move.txt', 'top', 1);
    const other = item('other', 'Other', 'r', 2);
    const reparentedTop = { ...top, parentId: 'other', fullParentIds: 'r/other' };
    let stableCalls = 0;
    const trashed: string[][] = [];
    const api: GuangyaApiLike = {
      listAllChildren: async () => [], renameItem: async () => undefined,
      walkDescendants: async () => walk([]),
      walkDescendantsStable: async () => {
        stableCalls += 1;
        return stableCalls === 1
          ? { ...walk([top, nested]), complete: true, stable: true }
          : { ...walk([other, reparentedTop]), complete: true, stable: true };
      },
      moveItems: async () => 'move',
      trashItems: async (ids) => { trashed.push(ids); return 'trash'; },
      waitTask: async () => undefined,
    };
    const result = await flattenOneDirectory(api, root);
    expect(trashed).toEqual([]);
    expect(result.retainedTopDirectories.map((entry) => entry.fileId)).toContain('top');
  });

  it('does not trust a caller-forged validatedAt snapshot', async () => {
    const root = item('r', 'Root', '', 2);
    const top = item('top', 'Top', 'r', 2);
    const nested = item('nested', 'move.txt', 'top', 1);
    const evidence: WalkResult = {
      ...walk([top, nested]), complete: true,
      directoryListings: new Map([
        ['r', { parentId: 'r', observedTotal: 1, orderedChildIds: ['top'], complete: true }],
        ['top', { parentId: 'top', observedTotal: 1, orderedChildIds: ['nested'], complete: true }],
      ]),
    };
    const forged = createFlattenPreviewSnapshot(root, evidence, 'skip', 'auto');
    forged.validatedAt = Date.now();
    let stableCalls = 0;
    let moveCalls = 0;
    const api: GuangyaApiLike = {
      listAllChildren: async () => [], renameItem: async () => undefined,
      walkDescendants: async () => walk([]),
      walkDescendantsStable: async () => { stableCalls += 1; return { ...walk([]), complete: true, stable: true }; },
      moveItems: async () => { moveCalls += 1; return 'move'; },
      trashItems: async () => 'trash', waitTask: async () => undefined,
    };
    await expect(flattenOneDirectory(api, root, { snapshot: forged }))
      .rejects.toThrow('未经可信复核');
    expect(stableCalls).toBe(0);
    expect(moveCalls).toBe(0);
  });

  it('invalidates a genuinely attested snapshot when its walk is mutated afterward', async () => {
    const root = item('r', 'Root', '', 2);
    const top = item('top', 'Top', 'r', 2);
    const nested = item('nested', 'move.txt', 'top', 1);
    const completeWalk: WalkResult = {
      ...walk([top, nested]), complete: true,
      directoryListings: new Map([
        ['r', { parentId: 'r', observedTotal: 1, orderedChildIds: ['top'], complete: true }],
        ['top', { parentId: 'top', observedTotal: 1, orderedChildIds: ['nested'], complete: true }],
      ]),
    };
    const preview = createFlattenPreviewSnapshot(root, completeWalk, 'skip', 'auto');
    let mutations = 0;
    const api: GuangyaApiLike = {
      listAllChildren: async () => [], renameItem: async () => undefined,
      walkDescendants: async () => completeWalk,
      walkDescendantsStable: async () => ({ ...walk([]), complete: true, stable: true }),
      moveItems: async () => { mutations += 1; return 'move'; },
      trashItems: async () => { mutations += 1; return 'trash'; }, waitTask: async () => undefined,
    };
    const checked = await verifyFlattenPreviewSnapshot(api, root, preview, {});
    expect(checked.unchanged).toBe(true);
    checked.snapshot.walk.items[1].fileName = 'tampered.txt';
    await expect(flattenOneDirectory(api, root, { snapshot: checked.snapshot }))
      .rejects.toThrow('被修改');
    expect(mutations).toBe(0);
  });

  it('executes only the private canonical walk when public derived maps and arrays are mutated', async () => {
    const root = item('r', 'Root', '', 2);
    const top = item('top', 'Top', 'r', 2);
    const nested = item('nested', 'move.txt', 'top', 1);
    const completeWalk: WalkResult = {
      ...walk([top, nested]), complete: true,
      directoryListings: new Map([
        ['r', { parentId: 'r', observedTotal: 1, orderedChildIds: ['top'], complete: true }],
        ['top', { parentId: 'top', observedTotal: 1, orderedChildIds: ['nested'], complete: true }],
      ]),
    };
    const preview = createFlattenPreviewSnapshot(root, completeWalk, 'skip', 'auto');
    const moved: string[][] = [];
    const api: GuangyaApiLike = {
      listAllChildren: async () => [], renameItem: async () => undefined,
      walkDescendants: async () => completeWalk,
      walkDescendantsStable: async () => ({ ...walk([]), complete: true, stable: true }),
      moveItems: async (ids) => { moved.push(ids); return 'move'; },
      trashItems: async () => 'trash', waitTask: async () => undefined,
    };
    const checked = await verifyFlattenPreviewSnapshot(api, root, preview, {});
    checked.snapshot.walk.itemById?.set('nested', { ...nested, parentId: 'r' });
    checked.snapshot.walk.files.splice(0);
    checked.snapshot.walk.directories.splice(0);
    await flattenOneDirectory(api, root, { snapshot: checked.snapshot });
    expect(moved).toEqual([['nested']]);
  });

  it('fails closed and never mutates after an incomplete listing', async () => {
    const root = item('r', 'Root', '', 2);
    let mutationCalls = 0;
    const api: GuangyaApiLike = {
      listAllChildren: async () => [],
      renameItem: async () => undefined,
      walkDescendants: async () => ({ ...walk([]), complete: false, incompleteReason: 'cap exhausted' }),
      moveItems: async () => { mutationCalls += 1; return 'move-task'; },
      trashItems: async () => { mutationCalls += 1; return 'trash-task'; },
      waitTask: async () => undefined,
    };
    await expect(flattenOneDirectory(api, root)).rejects.toThrow('cap exhausted');
    expect(mutationCalls).toBe(0);
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
