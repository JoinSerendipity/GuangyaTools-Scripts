import type {
  FlattenConflict,
  FlattenDirectoryResult,
  GuangyaItem,
  ProgressInfo,
} from '../types';
import type { GuangyaApiLike, WalkResult } from './guangyaApi';
import { runMutationBatches } from '../utils/batch';

export type FlattenConflictMode = 'skip' | 'guangya-default' | 'trash-conflicts';

export interface FlattenPlan {
  topDirectories: GuangyaItem[];
  movableFiles: GuangyaItem[];
  conflicts: FlattenConflict[];
}

function nameKey(name: string): string {
  return name.normalize('NFC').toLocaleLowerCase();
}

function groupByParentId(items: readonly GuangyaItem[]): GuangyaItem[][] {
  const groups = new Map<string, GuangyaItem[]>();
  for (const item of items) {
    const key = item.parentId || '';
    const group = groups.get(key) || [];
    group.push(item);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function findItemById(walk: WalkResult, itemId: string): GuangyaItem | undefined {
  return walk.itemById?.get(itemId) || walk.items.find((item) => item.fileId === itemId);
}

function itemNameById(walk: WalkResult, itemId: string): string {
  return findItemById(walk, itemId)?.fileName || itemId || '未知目录';
}

function findTopDirectory(item: GuangyaItem, topDirectories: readonly GuangyaItem[], walk: WalkResult): GuangyaItem | undefined {
  const topById = new Map(topDirectories.map((top) => [top.fileId, top]));
  let currentId = item.resType === 2 ? item.fileId : item.parentId;
  const visited = new Set<string>();
  while (currentId && !visited.has(currentId)) {
    const top = topById.get(currentId);
    if (top) return top;
    visited.add(currentId);
    currentId = findItemById(walk, currentId)?.parentId || '';
  }
  return undefined;
}

function progressRatio(progress: ProgressInfo): number {
  if (progress.total <= 0) return 0;
  return Math.min(1, Math.max(0, progress.current / progress.total));
}

function executionPhaseOffset(phase: string): { offset: number; span: number; label: string } {
  if (phase === 'scan' || phase === 'scan-page') return { offset: 0, span: 0.20, label: '扫描' };
  if (phase === 'move') return { offset: 0.20, span: 0.35, label: '移动' };
  if (phase === 'trash-conflicts') return { offset: 0.55, span: 0.15, label: '回收重名文件' };
  if (phase === 'verify-conflict-parent') return { offset: 0.70, span: 0.10, label: '清理重名文件空父目录' };
  if (phase === 'verify') return { offset: 0.80, span: 0.12, label: '确认空目录' };
  if (phase === 'trash-empty-folders') return { offset: 0.92, span: 0.08, label: '回收空目录' };
  return { offset: 0, span: 1, label: phase };
}

function prefixDirectoryProgress(progress: ProgressInfo, directory: GuangyaItem, index: number, total: number): ProgressInfo {
  const phase = executionPhaseOffset(progress.phase);
  const local = phase.offset + progressRatio(progress) * phase.span;
  return {
    phase: progress.phase,
    message: `[${index + 1}/${total}] 「${directory.fileName}」${phase.label}：${progress.message}`,
    current: index + local,
    total,
  };
}

export function createFlattenPlan(
  directory: GuangyaItem,
  walk: WalkResult,
  options: { conflictMode?: FlattenConflictMode } = {},
): FlattenPlan {
  const directChildren = walk.items.filter((item) => item.parentId === directory.fileId);
  const topDirectories = directChildren.filter((item) => item.resType === 2);
  // 光鸭同一目录下的文件与目录共享名称空间，任何直接子项都参与冲突检查。
  const targetNames = new Set(directChildren.map((item) => nameKey(item.fileName)));
  const candidates = walk.files.filter((item) => item.parentId !== directory.fileId);

  const conflictMode = options.conflictMode || 'skip';
  const movableFiles: GuangyaItem[] = [];
  const conflicts: FlattenConflict[] = [];
  const movedNameKeys = new Set<string>();
  for (const item of candidates) {
    const key = nameKey(item.fileName);
    if (targetNames.has(key)) {
      if (conflictMode === 'guangya-default') movableFiles.push(item);
      else conflicts.push({ item, reason: 'target-name-exists' });
    } else if (movedNameKeys.has(key)) {
      // 安全/回收模式移动第 1 个并标记后续同名项；默认模式交给光鸭自动追加 (1)、(2) 等。
      if (conflictMode === 'guangya-default') movableFiles.push(item);
      else conflicts.push({ item, reason: 'duplicate-candidate-name' });
    } else {
      movableFiles.push(item);
      movedNameKeys.add(key);
    }
  }
  return { topDirectories, movableFiles, conflicts };
}

export async function flattenOneDirectory(
  api: GuangyaApiLike,
  directory: GuangyaItem,
  options: {
    signal?: AbortSignal;
    batchSize?: number;
    onProgress?: (progress: ProgressInfo) => void;
    conflictMode?: FlattenConflictMode;
  } = {},
): Promise<FlattenDirectoryResult> {
  const base: FlattenDirectoryResult = {
    directory,
    scannedFiles: 0,
    movedFiles: [],
    conflicts: [],
    trashedConflictFiles: [],
    trashedConflictDirectories: [],
    retainedTopDirectories: [],
    trashedTopDirectories: [],
    failures: [],
    canceled: false,
  };

  options.onProgress?.({ phase: 'scan', message: `正在扫描「${directory.fileName}」`, current: 0, total: 1 });
  const walk = await api.walkDescendants(directory.fileId, {
    signal: options.signal,
    onProgress: options.onProgress,
  });
  const plan = createFlattenPlan(directory, walk, { conflictMode: options.conflictMode });
  base.scannedFiles = walk.files.length;
  base.conflicts = plan.conflicts;

  // 光鸭 move_file 要求同一请求里的文件来自同一个原父目录，否则会返回“父目录不一致”。
  const sourceGroups = groupByParentId(plan.movableFiles);
  for (let groupIndex = 0; groupIndex < sourceGroups.length; groupIndex += 1) {
    if (options.signal?.aborted) {
      base.canceled = true;
      break;
    }
    const sourceGroup = sourceGroups[groupIndex];
    const sourceName = itemNameById(walk, sourceGroup[0]?.parentId || '');
    options.onProgress?.({
      phase: 'move',
      message: `正在移动来源子文件夹「${sourceName}」（${groupIndex + 1}/${sourceGroups.length}，${sourceGroup.length} 项）`,
      current: groupIndex,
      total: sourceGroups.length,
    });
    const moveSummary = await runMutationBatches(sourceGroup, {
      batchSize: options.batchSize || 50,
      delayMs: 500,
      signal: options.signal,
      phase: 'move',
      mutate: (batch) => api.moveItems(batch.map((item) => item.fileId), directory.fileId, { signal: options.signal }),
      waitTask: (taskId) => api.waitTask(taskId),
      onProgress: (progress) => options.onProgress?.({
        phase: 'move',
        message: `来源子文件夹「${sourceName}」：${progress.message}`,
        current: groupIndex + progressRatio(progress),
        total: sourceGroups.length,
      }),
    });
    base.movedFiles.push(...moveSummary.succeeded);
    base.failures.push(...moveSummary.failed);
    if (moveSummary.canceled) {
      base.canceled = true;
      break;
    }
  }
  if (base.canceled || options.signal?.aborted) {
    base.canceled = true;
    base.retainedTopDirectories = plan.topDirectories;
    return base;
  }

  const deletedDirectoryIds = new Set<string>();
  const blockedTopDirectoryIds = new Set<string>();
  if (options.conflictMode === 'trash-conflicts' && plan.conflicts.length > 0) {
    const conflictItems = plan.conflicts.map((conflict) => conflict.item);
    const conflictTrashSummary = await runMutationBatches(conflictItems, {
      batchSize: options.batchSize || 50,
      delayMs: 500,
      signal: options.signal,
      phase: 'trash-conflicts',
      mutate: (batch) => api.trashItems(batch.map((item) => item.fileId), { signal: options.signal }),
      waitTask: (taskId) => api.waitTask(taskId),
      onProgress: options.onProgress,
    });
    base.trashedConflictFiles.push(...conflictTrashSummary.succeeded);
    base.failures.push(...conflictTrashSummary.failed);
    if (conflictTrashSummary.canceled || options.signal?.aborted) {
      base.canceled = true;
      base.retainedTopDirectories = plan.topDirectories;
      return base;
    }

    const conflictParentsById = new Map<string, GuangyaItem>();
    for (const item of conflictTrashSummary.succeeded) {
      const parent = findItemById(walk, item.parentId);
      if (parent?.resType === 2 && parent.fileId !== directory.fileId) conflictParentsById.set(parent.fileId, parent);
    }
    const conflictParents = [...conflictParentsById.values()].sort((left, right) => right.depth - left.depth);
    for (let index = 0; index < conflictParents.length; index += 1) {
      const parent = conflictParents[index];
      options.onProgress?.({
        phase: 'verify-conflict-parent',
        message: `正在复扫重名文件原目录「${parent.fileName}」`,
        current: index,
        total: conflictParents.length,
      });
      try {
        const remaining = await api.walkDescendants(parent.fileId, { signal: options.signal });
        if (remaining.files.length > 0) continue;
        const parentTrashSummary = await runMutationBatches([parent], {
          batchSize: 1,
          delayMs: 0,
          signal: options.signal,
          phase: 'verify-conflict-parent',
          mutate: (batch) => api.trashItems(batch.map((item) => item.fileId), { signal: options.signal }),
          waitTask: (taskId) => api.waitTask(taskId),
          onProgress: (progress) => options.onProgress?.({
            phase: 'verify-conflict-parent',
            message: `正在回收空父目录「${parent.fileName}」：${progress.message}`,
            current: index + progressRatio(progress),
            total: conflictParents.length,
          }),
        });
        base.trashedConflictDirectories.push(...parentTrashSummary.succeeded);
        parentTrashSummary.succeeded.forEach((item) => deletedDirectoryIds.add(item.fileId));
        base.failures.push(...parentTrashSummary.failed);
        if (parentTrashSummary.failed.length > 0) {
          const top = findTopDirectory(parent, plan.topDirectories, walk);
          if (top) blockedTopDirectoryIds.add(top.fileId);
        }
        if (parentTrashSummary.canceled || options.signal?.aborted) {
          base.canceled = true;
          base.retainedTopDirectories = plan.topDirectories.filter((top) => !deletedDirectoryIds.has(top.fileId));
          return base;
        }
      } catch (error) {
        const top = findTopDirectory(parent, plan.topDirectories, walk);
        if (top) blockedTopDirectoryIds.add(top.fileId);
        base.failures.push({ items: [parent], error: error instanceof Error ? error.message : String(error) });
        if (options.signal?.aborted) {
          base.canceled = true;
          base.retainedTopDirectories = plan.topDirectories.filter((entry) => !deletedDirectoryIds.has(entry.fileId));
          return base;
        }
      }
    }
  }

  const emptyTopDirectories: GuangyaItem[] = [];
  for (let index = 0; index < plan.topDirectories.length; index += 1) {
    const top = plan.topDirectories[index];
    if (deletedDirectoryIds.has(top.fileId)) continue;
    if (blockedTopDirectoryIds.has(top.fileId)) {
      base.retainedTopDirectories.push(top);
      continue;
    }
    options.onProgress?.({
      phase: 'verify',
      message: `正在确认「${top.fileName}」是否已经无文件`,
      current: index,
      total: plan.topDirectories.length,
    });
    try {
      const remaining = await api.walkDescendants(top.fileId, { signal: options.signal });
      if (remaining.files.length === 0) emptyTopDirectories.push(top);
      else base.retainedTopDirectories.push(top);
    } catch (error) {
      base.retainedTopDirectories.push(top);
      base.failures.push({ items: [top], error: error instanceof Error ? error.message : String(error) });
    }
  }

  const trashSummary = await runMutationBatches(emptyTopDirectories, {
    batchSize: options.batchSize || 50,
    delayMs: 500,
    signal: options.signal,
    phase: 'trash-empty-folders',
    mutate: (batch) => api.trashItems(batch.map((item) => item.fileId), { signal: options.signal }),
    waitTask: (taskId) => api.waitTask(taskId),
    onProgress: options.onProgress,
  });
  base.trashedTopDirectories.push(...trashSummary.succeeded);
  base.failures.push(...trashSummary.failed);
  base.retainedTopDirectories.push(...trashSummary.failed.flatMap((failure) => failure.items));
  base.canceled = trashSummary.canceled;
  return base;
}

export async function flattenDirectories(
  api: GuangyaApiLike,
  directories: readonly GuangyaItem[],
  options: {
    signal?: AbortSignal;
    batchSize?: number;
    onProgress?: (progress: ProgressInfo) => void;
    conflictMode?: FlattenConflictMode;
  } = {},
): Promise<FlattenDirectoryResult[]> {
  const results: FlattenDirectoryResult[] = [];
  for (let index = 0; index < directories.length; index += 1) {
    if (options.signal?.aborted) break;
    const directory = directories[index];
    options.onProgress?.({
      phase: 'directory',
      message: `[${index + 1}/${directories.length}] 正在处理「${directory.fileName}」`,
      current: index,
      total: directories.length,
    });
    try {
      results.push(await flattenOneDirectory(api, directory, {
        ...options,
        onProgress: (progress) => options.onProgress?.(prefixDirectoryProgress(progress, directory, index, directories.length)),
      }));
      options.onProgress?.({
        phase: 'directory',
        message: `[${index + 1}/${directories.length}] 已完成「${directory.fileName}」`,
        current: index + 1,
        total: directories.length,
      });
    } catch (error) {
      results.push({
        directory,
        scannedFiles: 0,
        movedFiles: [],
        conflicts: [],
        trashedConflictFiles: [],
        trashedConflictDirectories: [],
        retainedTopDirectories: [],
        trashedTopDirectories: [],
        failures: [{ items: [directory], error: error instanceof Error ? error.message : String(error) }],
        canceled: options.signal?.aborted || false,
      });
    }
  }
  return results;
}
