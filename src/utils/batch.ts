import type { FailedBatch, MutationSummary, ProgressInfo } from '../types';
import { clampMutationBatchSize, REQUEST_SAFETY_LIMITS } from '../services/requestSafetyLimits';

export function chunkItems<T>(items: readonly T[], size: number): T[][] {
  const boundedSize = clampMutationBatchSize(size);
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += boundedSize) result.push(items.slice(index, index + boundedSize));
  return result;
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = (): void => { cleanup(); reject(signal?.reason instanceof Error ? signal.reason : new DOMException('操作已取消', 'AbortError')); };
    const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function classifyError(error: unknown, signal?: AbortSignal): { unknown: boolean; rateLimited: boolean; aborted: boolean; message: string } {
  const outcome = error && typeof error === 'object' && 'outcome' in error ? String((error as { outcome?: unknown }).outcome || '') : '';
  const unknown = outcome === 'outcome-unknown' || outcome === 'task-unknown';
  const rateLimited = Boolean(error && typeof error === 'object' && 'rateLimited' in error && (error as { rateLimited?: unknown }).rateLimited);
  const aborted = !unknown && (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError'));
  return { unknown, rateLimited, aborted, message: error instanceof Error ? error.message : String(error) };
}

export async function runMutationBatches<T>(
  items: readonly T[],
  options: {
    batchSize?: number;
    delayMs?: number;
    signal?: AbortSignal;
    mutate: (batch: T[]) => Promise<string>;
    waitTask: (taskId: string) => Promise<void>;
    onProgress?: (progress: ProgressInfo) => void;
    phase?: string;
  },
): Promise<MutationSummary<T>> {
  const batches = chunkItems(items, clampMutationBatchSize(options.batchSize));
  const succeeded: T[] = [];
  const failed: FailedBatch<T>[] = [];
  let canceled = false;
  let outcomeUnknown = false;
  let stoppedAt = batches.length;

  for (let index = 0; index < batches.length; index += 1) {
    if (options.signal?.aborted) { canceled = true; stoppedAt = index; break; }
    const batch = batches[index];
    options.onProgress?.({ phase: options.phase || 'mutate', message: `正在处理第 ${index + 1}/${batches.length} 批（${batch.length} 项）`, current: index, total: batches.length });
    try {
      const taskId = await options.mutate(batch);
      await options.waitTask(taskId);
      succeeded.push(...batch);
    } catch (error) {
      const classification = classifyError(error, options.signal);
      failed.push({
        items: [...batch],
        error: classification.unknown ? `${classification.message}；已停止后续批次，请刷新确认` : classification.aborted ? '操作已取消，本批未完成' : classification.message,
      });
      if (classification.unknown || classification.rateLimited || classification.aborted) {
        outcomeUnknown = classification.unknown;
        canceled = classification.aborted;
        stoppedAt = index + 1;
        break;
      }
    }
    options.onProgress?.({ phase: options.phase || 'mutate', message: `已完成第 ${index + 1}/${batches.length} 批`, current: index + 1, total: batches.length });
    if (options.signal?.aborted) { canceled = true; stoppedAt = index + 1; break; }
    if (index < batches.length - 1 && (options.delayMs ?? 0) > 0) {
      try { await abortableDelay(options.delayMs || 0, options.signal); }
      catch { canceled = true; stoppedAt = index + 1; break; }
    }
  }
  return { succeeded, failed, canceled, outcomeUnknown, unsubmitted: stoppedAt < batches.length ? batches.slice(stoppedAt).flat() : [] };
}

interface AcceptedTask<T> {
  index: number;
  batch: T[];
  key: string;
  settled: Promise<{ index: number; error?: unknown }>;
}

export async function runIndependentMutationPipeline<T>(
  batchesInput: readonly (readonly T[])[],
  options: {
    signal?: AbortSignal;
    window: number | (() => number);
    independenceKey?: (batch: readonly T[]) => string;
    mutate: (batch: T[]) => Promise<string>;
    waitTask: (taskId: string) => Promise<void>;
    onProgress?: (progress: ProgressInfo) => void;
    phase?: string;
  },
): Promise<MutationSummary<T>> {
  const batches = batchesInput.flatMap((batch) => chunkItems(batch, REQUEST_SAFETY_LIMITS.maxMutationBatch));
  const succeeded: T[] = [];
  const failed: FailedBatch<T>[] = [];
  const accepted = new Map<number, AcceptedTask<T>>();
  let nextIndex = 0;
  let admissionClosed = false;
  let canceled = false;
  let outcomeUnknown = false;

  const closeAdmission = (classification?: ReturnType<typeof classifyError>) => {
    admissionClosed = true;
    canceled ||= Boolean(classification?.aborted);
    outcomeUnknown ||= Boolean(classification?.unknown);
  };
  const configuredWindow = () => Math.max(1, Math.min(REQUEST_SAFETY_LIMITS.maxAcceptedMoveTasks,
    typeof options.window === 'function' ? options.window() : options.window));
  const activeKeys = () => new Set([...accepted.values()].map((entry) => entry.key).filter(Boolean));
  const report = (message: string) => options.onProgress?.({
    phase: options.phase || 'mutate-pipeline', message, current: succeeded.length + failed.reduce((sum, entry) => sum + entry.items.length, 0),
    total: batches.reduce((sum, batch) => sum + batch.length, 0), inFlight: accepted.size, queued: batches.length - nextIndex,
  });

  while (nextIndex < batches.length || accepted.size > 0) {
    if (admissionClosed && accepted.size === 0) break;
    if (options.signal?.aborted) closeAdmission({ unknown: false, rateLimited: false, aborted: true, message: '操作已取消' });
    let admitted = false;
    while (!admissionClosed && nextIndex < batches.length && accepted.size < configuredWindow()) {
      const batch = [...batches[nextIndex]];
      const key = options.independenceKey?.(batch) || '';
      if (key && activeKeys().has(key)) break;
      const index = nextIndex++;
      report(`正在提交独立任务 ${index + 1}/${batches.length}；已接受 ${accepted.size}`);
      try {
        const taskId = await options.mutate(batch);
        const settled = Promise.resolve().then(() => options.waitTask(taskId)).then(
          () => ({ index }),
          (error) => {
            const classification = classifyError(error, options.signal);
            if (classification.unknown || classification.rateLimited || classification.aborted) closeAdmission(classification);
            return { index, error };
          },
        );
        accepted.set(index, { index, batch, key, settled });
        admitted = true;
        if (options.signal?.aborted) closeAdmission({ unknown: false, rateLimited: false, aborted: true, message: '操作已取消' });
      } catch (error) {
        const classification = classifyError(error, options.signal);
        failed.push({ items: batch, error: classification.unknown ? `${classification.message}；已关闭新任务提交，请刷新确认` : classification.message });
        if (classification.unknown || classification.rateLimited || classification.aborted) closeAdmission(classification);
      }
    }

    if (accepted.size > 0 && (admissionClosed || nextIndex >= batches.length || accepted.size >= configuredWindow() || !admitted)) {
      const result = await Promise.race([...accepted.values()].map((entry) => entry.settled));
      const task = accepted.get(result.index);
      if (!task) continue;
      accepted.delete(result.index);
      if (result.error === undefined) succeeded.push(...task.batch);
      else {
        const classification = classifyError(result.error, options.signal);
        failed.push({ items: task.batch, error: classification.unknown ? `${classification.message}；已关闭新任务提交，请刷新确认` : classification.message });
        if (classification.unknown || classification.rateLimited || classification.aborted) closeAdmission(classification);
      }
      report(admissionClosed ? `已停止新提交，正在排空 ${accepted.size} 个已接受任务` : `任务已完成，仍有 ${accepted.size} 个等待终态`);
    } else if (!admitted && accepted.size === 0 && nextIndex < batches.length) {
      // The only blocker can be a dynamic window/key; no accepted task means the next item is safe to admit.
      continue;
    }
  }

  return { succeeded, failed, canceled, outcomeUnknown, unsubmitted: admissionClosed ? batches.slice(nextIndex).flat() : [] };
}
