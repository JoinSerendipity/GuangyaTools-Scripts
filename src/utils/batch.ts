import type { FailedBatch, MutationSummary, ProgressInfo } from '../types';

export function chunkItems<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) throw new Error('批次大小必须是正整数');
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      cleanup();
      reject(signal?.reason instanceof Error ? signal.reason : new DOMException('操作已取消', 'AbortError'));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
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
  const batches = chunkItems(items, options.batchSize || 50);
  const succeeded: T[] = [];
  const failed: FailedBatch<T>[] = [];
  let canceled = false;

  for (let index = 0; index < batches.length; index += 1) {
    if (options.signal?.aborted) {
      canceled = true;
      break;
    }
    const batch = batches[index];
    options.onProgress?.({
      phase: options.phase || 'mutate',
      message: `正在处理第 ${index + 1}/${batches.length} 批（${batch.length} 项）`,
      current: index,
      total: batches.length,
    });
    try {
      const taskId = await options.mutate(batch);
      // 服务端任务已创建后必须等待终态；取消只阻止后续批次。
      await options.waitTask(taskId);
      succeeded.push(...batch);
    } catch (error) {
      const aborted = options.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError');
      failed.push({
        items: [...batch],
        error: aborted ? '操作已取消，本批结果需刷新后确认' : (error instanceof Error ? error.message : String(error)),
      });
      if (aborted) {
        canceled = true;
        break;
      }
    }
    options.onProgress?.({
      phase: options.phase || 'mutate',
      message: `已完成第 ${index + 1}/${batches.length} 批`,
      current: index + 1,
      total: batches.length,
    });
    if (options.signal?.aborted) {
      canceled = true;
      break;
    }
    if (index < batches.length - 1) {
      try {
        await abortableDelay(options.delayMs ?? 400, options.signal);
      } catch {
        canceled = true;
        break;
      }
    }
  }

  return { succeeded, failed, canceled };
}
