import type {
  FlattenConflict,
  FlattenDirectoryResult,
  GuangyaItem,
  ProgressInfo,
} from '../types';
import { walkEvidenceFingerprint, type GuangyaApiLike, type WalkResult } from './guangyaApi';
import type { RequestContext } from './requestContext';
import { chunkItems, runIndependentMutationPipeline, runMutationBatches } from '../utils/batch';
import { requestScheduler } from './requestScheduler';
import type { RequestSpeedMode } from './requestSpeedSettings';

export type FlattenConflictMode = 'skip' | 'guangya-default' | 'trash-conflicts';

function ancestorIds(directory: GuangyaItem): Set<string> {
  const ids = directory.fullParentIds.split(/[,/|>\s]+/).filter(Boolean);
  if (directory.parentId) ids.push(directory.parentId);
  return new Set(ids);
}

function hasAncestor(directory: GuangyaItem, ancestorId: string): boolean {
  return ancestorIds(directory).has(ancestorId);
}

function canProveDisjoint(left: GuangyaItem, right: GuangyaItem): boolean {
  if (hasAncestor(left, right.fileId) || hasAncestor(right, left.fileId)) return false;
  if (left.parentId && left.parentId === right.parentId) return true;
  const leftPathKnown = Boolean(left.fullParentIds.trim());
  const rightPathKnown = Boolean(right.fullParentIds.trim());
  return leftPathKnown && rightPathKnown;
}

export function groupDisjointDirectoryWaves(directories: readonly GuangyaItem[]): GuangyaItem[][] {
  const unique = [...new Map(directories.map((directory) => [directory.fileId, directory])).values()];
  const waves: GuangyaItem[][] = [];
  for (const directory of unique) {
    const wave = waves.find((entries) => entries.every((other) => canProveDisjoint(directory, other)));
    if (wave) wave.push(directory);
    else waves.push([directory]);
  }
  return waves;
}

export function orderDirectoriesForExecution(directories: readonly GuangyaItem[]): GuangyaItem[] {
  const unique = [...new Map(directories.map((directory) => [directory.fileId, directory])).values()];
  for (let leftIndex = 0; leftIndex < unique.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < unique.length; rightIndex += 1) {
      const left = unique[leftIndex];
      const right = unique[rightIndex];
      const related = hasAncestor(left, right.fileId) || hasAncestor(right, left.fileId);
      if (!related && !canProveDisjoint(left, right)) {
        throw new Error(`无法确认目录「${left.fileName}」与「${right.fileName}」是否重叠，请分开执行`);
      }
    }
  }
  return unique.sort((left, right) => {
    if (hasAncestor(left, right.fileId)) return -1;
    if (hasAncestor(right, left.fileId)) return 1;
    return 0;
  });
}

export interface FlattenPlan {
  topDirectories: GuangyaItem[];
  movableFiles: GuangyaItem[];
  conflicts: FlattenConflict[];
}

export interface FlattenPreviewSnapshot {
  rootId: string;
  conflictMode: FlattenConflictMode;
  speedMode: RequestSpeedMode;
  plannerVersion: 1;
  createdAt: number;
  fingerprint: string;
  walk: WalkResult;
  validatedAt?: number;
}

const VALIDATED_SNAPSHOT_MAX_AGE_MS = 30_000;
interface SnapshotAttestation {
  rootId: string;
  conflictMode: FlattenConflictMode;
  speedMode: RequestSpeedMode;
  plannerVersion: 1;
  fingerprint: string;
  publicWalk: WalkResult;
  canonicalWalk: WalkResult;
  validatedAt: number;
}
const validatedSnapshotAttestations = new WeakMap<object, Readonly<SnapshotAttestation>>();

function cloneCanonicalWalk(walk: WalkResult): WalkResult {
  const items = walk.items.map((item) => structuredClone(item));
  const itemById = new Map(items.map((item) => [item.fileId, item]));
  const directoryListings = walk.directoryListings
    ? new Map([...walk.directoryListings.entries()].map(([id, evidence]) => [id, {
      ...evidence,
      orderedChildIds: [...evidence.orderedChildIds],
    }]))
    : undefined;
  return {
    items,
    directories: items.filter((item) => item.resType === 2),
    files: items.filter((item) => item.resType === 1),
    itemById,
    directoryListings,
    complete: walk.complete,
    incompleteReason: walk.incompleteReason,
    stable: walk.stable,
  };
}

export function createFlattenPreviewSnapshot(
  directory: GuangyaItem,
  walk: WalkResult,
  conflictMode: FlattenConflictMode,
  speedMode: RequestSpeedMode,
): FlattenPreviewSnapshot {
  const fingerprint = walkEvidenceFingerprint(walk);
  const evidence = walk.directoryListings;
  const requiredDirectories = [directory.fileId, ...walk.directories.map((item) => item.fileId)];
  const uniqueRequiredDirectories = new Set(requiredDirectories);
  const evidenceComplete = Boolean(evidence)
    && evidence!.size === uniqueRequiredDirectories.size
    && [...uniqueRequiredDirectories].every((id) => {
      const listing = evidence!.get(id);
      return Boolean(listing?.complete)
        && listing!.observedTotal === listing!.orderedChildIds.length
        && new Set(listing!.orderedChildIds).size === listing!.orderedChildIds.length;
    })
    && walk.items.every((item) => evidence!.get(item.parentId)?.orderedChildIds.includes(item.fileId));
  if (walk.complete === false || !fingerprint || !evidenceComplete) throw new Error('预检查缺少完整顺序分页/拓扑证据，不能用于执行');
  return { rootId: directory.fileId, conflictMode, speedMode, plannerVersion: 1, createdAt: Date.now(), fingerprint, walk };
}

export async function verifyFlattenPreviewSnapshot(
  api: GuangyaApiLike,
  directory: GuangyaItem,
  snapshot: FlattenPreviewSnapshot,
  options: {
    context?: RequestContext;
    signal?: AbortSignal;
    onProgress?: (progress: ProgressInfo) => void;
    conflictMode?: FlattenConflictMode;
    speedMode?: RequestSpeedMode;
  },
): Promise<{ snapshot: FlattenPreviewSnapshot; unchanged: boolean }> {
  const conflictMode = options.conflictMode ?? snapshot.conflictMode;
  const speedMode = options.speedMode ?? options.context?.mode ?? snapshot.speedMode;
  const walk = await api.walkDescendants(directory.fileId, { ...options, purpose: 'consistency' });
  const fresh = createFlattenPreviewSnapshot(directory, walk, conflictMode, speedMode);
  const unchanged = snapshot.rootId === directory.fileId
    && snapshot.plannerVersion === 1
    && snapshot.conflictMode === conflictMode
    && snapshot.speedMode === speedMode
    && snapshot.fingerprint === fresh.fingerprint;
  if (unchanged) {
    fresh.validatedAt = Date.now();
    validatedSnapshotAttestations.set(fresh, Object.freeze({
      rootId: fresh.rootId,
      conflictMode: fresh.conflictMode,
      speedMode: fresh.speedMode,
      plannerVersion: fresh.plannerVersion,
      fingerprint: fresh.fingerprint,
      publicWalk: fresh.walk,
      canonicalWalk: cloneCanonicalWalk(fresh.walk),
      validatedAt: fresh.validatedAt,
    }));
  }
  return { snapshot: fresh, unchanged };
}

function nameKey(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/[ .]+$/g, '');
}

function independentPipelineNameKey(name: string): string | null {
  const key = nameKey(name);
  if (!key || /[\u0000-\u001f<>:"/\\|?*]/.test(key)) return null;
  const stem = key.split('.')[0];
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(stem)) return null;
  return key;
}

function getUsableValidatedWalk(
  snapshot: FlattenPreviewSnapshot | undefined,
  directory: GuangyaItem,
  conflictMode: FlattenConflictMode,
  speedMode: RequestSpeedMode,
): WalkResult | undefined {
  if (!snapshot) return undefined;
  const attestation = validatedSnapshotAttestations.get(snapshot as object);
  const valid = Boolean(attestation)
    && Date.now() - attestation!.validatedAt <= VALIDATED_SNAPSHOT_MAX_AGE_MS
    && snapshot.validatedAt === attestation!.validatedAt
    && snapshot.rootId === attestation!.rootId
    && snapshot.rootId === directory.fileId
    && snapshot.plannerVersion === attestation!.plannerVersion
    && snapshot.conflictMode === attestation!.conflictMode
    && snapshot.conflictMode === conflictMode
    && snapshot.speedMode === attestation!.speedMode
    && snapshot.speedMode === speedMode
    && snapshot.walk === attestation!.publicWalk
    && snapshot.fingerprint === attestation!.fingerprint
    && walkEvidenceFingerprint(snapshot.walk) === attestation!.fingerprint;
  return valid ? attestation!.canonicalWalk : undefined;
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

function isDescendantOf(item: GuangyaItem, ancestorId: string, walk: WalkResult): boolean {
  let currentId = item.parentId;
  const visited = new Set<string>();
  while (currentId && !visited.has(currentId)) {
    if (currentId === ancestorId) return true;
    visited.add(currentId);
    currentId = findItemById(walk, currentId)?.parentId || '';
  }
  return false;
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
    context?: RequestContext;
    snapshot?: FlattenPreviewSnapshot;
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
  const conflictMode = options.conflictMode || 'skip';
  const mode = options.context?.mode || 'auto';
  let walk: WalkResult;
  const attestedWalk = getUsableValidatedWalk(options.snapshot, directory, conflictMode, mode);
  if (attestedWalk) {
    walk = attestedWalk;
    options.onProgress?.({ phase: 'snapshot-reuse', message: '执行前快照一致，复用新鲜扫描结果', current: 1, total: 1 });
  } else if (options.snapshot) {
    throw new Error('执行快照已过期、被修改或未经可信复核，请重新预检查');
  } else if (api.walkDescendantsStable) {
    walk = await api.walkDescendantsStable(directory.fileId, { signal: options.signal, context: options.context, onProgress: options.onProgress });
  } else {
    // Compatibility path for API-like test doubles. The production API always provides stable tree verification.
    walk = await api.walkDescendants(directory.fileId, { signal: options.signal, context: options.context, purpose: 'verification', onProgress: options.onProgress });
  }
  if (walk.complete === false) throw new Error(walk.incompleteReason || '目录扫描不完整，已停止解散');
  const plan = createFlattenPlan(directory, walk, { conflictMode });
  base.scannedFiles = walk.files.length;
  base.conflicts = plan.conflicts;

  const sourceGroups = groupByParentId(plan.movableFiles);
  const moveBatches = sourceGroups.flatMap((group) => chunkItems(group, options.batchSize || 50));
  const strictNameKeys = new Set<string>();
  let namesProvenIndependent = true;
  for (const item of walk.items.filter((entry) => entry.parentId === directory.fileId)) {
    const key = independentPipelineNameKey(item.fileName);
    if (!key || strictNameKeys.has(key)) namesProvenIndependent = false;
    else strictNameKeys.add(key);
  }
  for (const item of plan.movableFiles) {
    const key = independentPipelineNameKey(item.fileName);
    if (!key || strictNameKeys.has(key)) namesProvenIndependent = false;
    else strictNameKeys.add(key);
  }
  const pipelineWindow = conflictMode === 'guangya-default' || !namesProvenIndependent
    ? 1
    : () => requestScheduler.getAcceptedTaskWindow(mode);
  if (sourceGroups.length > 0) {
    const firstSource = itemNameById(walk, sourceGroups[0][0]?.parentId || '');
    options.onProgress?.({ phase: 'move', message: `开始移动来源子文件夹「${firstSource}」等 ${sourceGroups.length} 组`, current: 0, total: sourceGroups.length });
  }
  const moveSummary = await runIndependentMutationPipeline(moveBatches, {
    signal: options.signal,
    window: pipelineWindow,
    independenceKey: (batch) => batch[0]?.parentId || '',
    phase: 'move',
    mutate: (batch) => api.moveItems(batch.map((item) => item.fileId), directory.fileId, { signal: options.signal, context: options.context }),
    waitTask: (taskId) => api.waitTask(taskId, { timeoutMs: 5 * 60_000, context: options.context }),
    onProgress: options.onProgress,
  });
  base.movedFiles.push(...moveSummary.succeeded);
  base.failures.push(...moveSummary.failed);
  if (moveSummary.canceled || moveSummary.outcomeUnknown || moveSummary.unsubmitted?.length || options.signal?.aborted) {
    base.canceled = moveSummary.canceled || Boolean(moveSummary.unsubmitted?.length) || Boolean(options.signal?.aborted);
    base.outcomeUnknown = moveSummary.outcomeUnknown;
    base.retainedTopDirectories = plan.topDirectories;
    return base;
  }

  const conflictParents = new Map<string, GuangyaItem>();
  if (conflictMode === 'trash-conflicts' && plan.conflicts.length > 0) {
    const conflictItems = plan.conflicts.map((entry) => entry.item);
    const conflictSummary = await runMutationBatches(conflictItems, {
      batchSize: options.batchSize || 50,
      signal: options.signal,
      phase: 'trash-conflicts',
      mutate: (batch) => api.trashItems(batch.map((item) => item.fileId), { signal: options.signal, context: options.context }),
      waitTask: (taskId) => api.waitTask(taskId, { context: options.context }),
      onProgress: options.onProgress,
    });
    base.trashedConflictFiles.push(...conflictSummary.succeeded);
    base.failures.push(...conflictSummary.failed);
    for (const item of conflictSummary.succeeded) {
      const parent = findItemById(walk, item.parentId);
      if (parent?.resType === 2 && parent.fileId !== directory.fileId) conflictParents.set(parent.fileId, parent);
    }
    if (conflictSummary.canceled || conflictSummary.outcomeUnknown || conflictSummary.unsubmitted?.length || options.signal?.aborted) {
      base.canceled = conflictSummary.canceled || Boolean(conflictSummary.unsubmitted?.length) || Boolean(options.signal?.aborted);
      base.outcomeUnknown = conflictSummary.outcomeUnknown;
      base.retainedTopDirectories = plan.topDirectories;
      return base;
    }
  }

  options.onProgress?.({ phase: 'verify', message: '正在进行最终双 Pass 稳定根验证', current: 0, total: 1 });
  let stableWalk: WalkResult;
  try {
    stableWalk = api.walkDescendantsStable
      ? await api.walkDescendantsStable(directory.fileId, { signal: options.signal, context: options.context, onProgress: options.onProgress })
      : await api.walkDescendants(directory.fileId, { signal: options.signal, context: options.context, purpose: 'verification' });
    if (stableWalk.complete === false) throw new Error(stableWalk.incompleteReason || '最终目录验证不完整');
  } catch (error) {
    base.retainedTopDirectories = plan.topDirectories;
    base.failures.push({ items: [...plan.topDirectories], error: error instanceof Error ? error.message : String(error) });
    return base;
  }

  if (api.walkDescendantsStable && stableWalk.stable !== true) {
    base.retainedTopDirectories = plan.topDirectories;
    base.failures.push({ items: [...plan.topDirectories], error: '最终 tree pass 未提供稳定证据，已保留目录' });
    return base;
  }
  const finalById = stableWalk.itemById || new Map(stableWalk.items.map((item) => [item.fileId, item]));
  const subtreeHasFile = (directoryId: string): boolean => stableWalk.files.some((file) => {
    let currentId = file.parentId;
    const visited = new Set<string>();
    while (currentId && !visited.has(currentId)) {
      if (currentId === directoryId) return true;
      visited.add(currentId);
      currentId = finalById.get(currentId)?.parentId || '';
    }
    return false;
  });

  const strictStableRoot = Boolean(api.walkDescendantsStable);
  const emptyTop: GuangyaItem[] = [];
  for (const originalTop of plan.topDirectories) {
    const finalTop = finalById.get(originalTop.fileId);
    if (!strictStableRoot && !finalTop && !subtreeHasFile(originalTop.fileId)) {
      emptyTop.push(originalTop);
      continue;
    }
    if (finalTop?.resType === 2
      && finalTop.parentId === directory.fileId
      && finalTop.fileName === originalTop.fileName
      && !subtreeHasFile(finalTop.fileId)) emptyTop.push(finalTop);
  }
  const emptyTopIds = new Set(emptyTop.map((item) => item.fileId));
  base.retainedTopDirectories.push(...plan.topDirectories.filter((top) => !emptyTopIds.has(top.fileId)));

  const emptyConflictParents: GuangyaItem[] = [];
  const possibleConflictParents = [...conflictParents.values()]
    .map((originalParent) => ({ originalParent, finalParent: finalById.get(originalParent.fileId) }))
    .filter(({ originalParent, finalParent }) => !strictStableRoot || Boolean(finalParent)
      && finalParent!.resType === 2
      && finalParent!.parentId === originalParent.parentId
      && finalParent!.fileName === originalParent.fileName)
    .map(({ originalParent, finalParent }) => finalParent || originalParent)
    .filter((parent) => !subtreeHasFile(parent.fileId))
    .filter((parent) => !emptyTop.some((top) => parent.fileId === top.fileId || isDescendantOf(parent, top.fileId, stableWalk)))
    .sort((left, right) => left.depth - right.depth);
  for (const parent of possibleConflictParents) {
    if (!emptyConflictParents.some((candidate) => isDescendantOf(parent, candidate.fileId, stableWalk) || candidate.fileId === parent.fileId)) {
      emptyConflictParents.push(parent);
    }
  }

  if (emptyConflictParents.length > 0) {
    const summary = await runMutationBatches(emptyConflictParents, {
      batchSize: options.batchSize || 50,
      signal: options.signal,
      phase: 'trash-empty-conflict-parents',
      mutate: (batch) => api.trashItems(batch.map((item) => item.fileId), { signal: options.signal, context: options.context }),
      waitTask: (taskId) => api.waitTask(taskId, { context: options.context }),
      onProgress: options.onProgress,
    });
    base.trashedConflictDirectories.push(...summary.succeeded);
    base.failures.push(...summary.failed);
    if (summary.canceled || summary.outcomeUnknown || summary.unsubmitted?.length) {
      base.canceled = summary.canceled;
      base.outcomeUnknown = summary.outcomeUnknown;
      base.retainedTopDirectories.push(...emptyTop);
      return base;
    }
  }

  const trashSummary = await runMutationBatches(emptyTop, {
    batchSize: options.batchSize || 50,
    signal: options.signal,
    phase: 'trash-empty-folders',
    mutate: (batch) => api.trashItems(batch.map((item) => item.fileId), { signal: options.signal, context: options.context }),
    waitTask: (taskId) => api.waitTask(taskId, { context: options.context }),
    onProgress: options.onProgress,
  });
  for (const item of trashSummary.succeeded) {
    if (conflictParents.has(item.fileId)) base.trashedConflictDirectories.push(item);
    else base.trashedTopDirectories.push(item);
  }
  base.failures.push(...trashSummary.failed);
  base.retainedTopDirectories.push(...trashSummary.failed.flatMap((failure) => failure.items), ...(trashSummary.unsubmitted || []));
  base.canceled = trashSummary.canceled;
  base.outcomeUnknown = trashSummary.outcomeUnknown;
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
    context?: RequestContext;
    snapshots?: ReadonlyMap<string, FlattenPreviewSnapshot>;
  } = {},
): Promise<FlattenDirectoryResult[]> {
  const orderedDirectories = orderDirectoriesForExecution(directories);
  const results: FlattenDirectoryResult[] = [];
  for (let index = 0; index < orderedDirectories.length; index += 1) {
    if (options.signal?.aborted) break;
    const directory = orderedDirectories[index];
    let executionSnapshot = options.snapshots?.get(directory.fileId);
    const conflictMode = options.conflictMode || 'skip';
    const speedMode = options.context?.mode || 'auto';
    const overlapsPrior = index > 0 && orderedDirectories.slice(0, index)
      .some((prior) => hasAncestor(directory, prior.fileId) || hasAncestor(prior, directory.fileId));
    if (executionSnapshot && (overlapsPrior || !getUsableValidatedWalk(executionSnapshot, directory, conflictMode, speedMode))) {
      const checked = await verifyFlattenPreviewSnapshot(api, directory, executionSnapshot, {
        signal: options.signal,
        context: options.context,
        onProgress: options.onProgress,
        conflictMode,
        speedMode,
      });
      if (!checked.unchanged) {
        results.push({
          directory, scannedFiles: checked.snapshot.walk.files.length, movedFiles: [], conflicts: [], trashedConflictFiles: [], trashedConflictDirectories: [],
          retainedTopDirectories: createFlattenPlan(directory, checked.snapshot.walk, { conflictMode }).topDirectories,
          trashedTopDirectories: [], failures: [{ items: [directory], error: '执行前快照已变化，请重新预检查后重试' }], canceled: true,
        });
        break;
      }
      executionSnapshot = checked.snapshot;
    }
    options.onProgress?.({ phase: 'directory', message: `[${index + 1}/${orderedDirectories.length}] 正在处理「${directory.fileName}」`, current: index, total: orderedDirectories.length });
    try {
      const result = await flattenOneDirectory(api, directory, {
        ...options,
        snapshot: executionSnapshot,
        onProgress: (progress) => options.onProgress?.(prefixDirectoryProgress(progress, directory, index, orderedDirectories.length)),
      });
      results.push(result);
      options.onProgress?.({ phase: 'directory', message: `[${index + 1}/${orderedDirectories.length}] 已完成「${directory.fileName}」`, current: index + 1, total: orderedDirectories.length });
      if (result.outcomeUnknown || result.canceled) break;
    } catch (error) {
      results.push({
        directory, scannedFiles: 0, movedFiles: [], conflicts: [], trashedConflictFiles: [], trashedConflictDirectories: [],
        retainedTopDirectories: [], trashedTopDirectories: [], failures: [{ items: [directory], error: error instanceof Error ? error.message : String(error) }],
        canceled: options.signal?.aborted || false,
      });
    }
  }
  return results;
}
