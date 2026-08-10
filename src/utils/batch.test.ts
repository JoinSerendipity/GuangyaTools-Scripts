import { describe, expect, it } from 'vitest';
import { chunkItems, runIndependentMutationPipeline, runMutationBatches } from './batch';

describe('batch utilities', () => {
  it('splits items without dropping the tail', () => {
    expect(chunkItems([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(() => chunkItems([1], 0)).toThrow();
    expect(chunkItems(Array.from({ length: 101 }, (_, index) => index), 999).map((batch) => batch.length)).toEqual([50, 50, 1]);
  });

  it('continues after a failed batch and reports partial success', async () => {
    const calls: number[][] = [];
    const summary = await runMutationBatches([1, 2, 3, 4, 5], {
      batchSize: 2,
      delayMs: 0,
      mutate: async (batch) => {
        calls.push(batch);
        if (batch.includes(3)) throw new Error('failed');
        return `task-${batch[0]}`;
      },
      waitTask: async () => undefined,
    });
    expect(calls).toEqual([[1, 2], [3, 4], [5]]);
    expect(summary.succeeded).toEqual([1, 2, 5]);
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0].items).toEqual([3, 4]);
  });

  it('stops dependent batches when a submitted mutation outcome is unknown', async () => {
    const calls: number[] = [];
    const unknown = Object.assign(new Error('network lost'), { outcome: 'outcome-unknown' });
    const summary = await runMutationBatches([1, 2, 3], {
      batchSize: 1,
      delayMs: 0,
      mutate: async (batch) => {
        calls.push(batch[0]);
        if (batch[0] === 2) throw unknown;
        return `task-${batch[0]}`;
      },
      waitTask: async () => undefined,
    });
    expect(calls).toEqual([1, 2]);
    expect(summary.outcomeUnknown).toBe(true);
    expect(summary.unsubmitted).toEqual([3]);
    expect(summary.failed[0].error).toContain('刷新确认');
  });

  it('stops after a rate-limit rejection instead of submitting later batches', async () => {
    const calls: number[] = [];
    const rateLimit = Object.assign(new Error('请求频繁'), { outcome: 'definite-rejection', rateLimited: true });
    const summary = await runMutationBatches([1, 2], {
      batchSize: 1,
      mutate: async (batch) => { calls.push(batch[0]); throw rateLimit; },
      waitTask: async () => undefined,
    });
    expect(calls).toEqual([1]);
    expect(summary.unsubmitted).toEqual([2]);
  });

  it('closes admission on unknown and drains every already accepted task', async () => {
    const submitted: number[] = [];
    const drained: number[] = [];
    const unknown = Object.assign(new Error('unknown task'), { outcome: 'task-unknown' });
    const summary = await runIndependentMutationPipeline([[1], [2], [3], [4]], {
      window: 2,
      mutate: async (batch) => { submitted.push(batch[0]); return `task-${batch[0]}`; },
      waitTask: async (taskId) => {
        const id = Number(taskId.split('-')[1]);
        await Promise.resolve();
        drained.push(id);
        if (id === 2) throw unknown;
      },
    });
    expect(submitted).toEqual([1, 2]);
    expect(drained.sort()).toEqual([1, 2]);
    expect(summary.outcomeUnknown).toBe(true);
    expect(summary.unsubmitted).toEqual([3, 4]);
  });

  it('never exceeds the configured accepted-task window while pipelining independent work', async () => {
    let active = 0;
    let peak = 0;
    const summary = await runIndependentMutationPipeline([[1], [2], [3], [4], [5]], {
      window: 3,
      mutate: async (batch) => `task-${batch[0]}`,
      waitTask: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
      },
    });
    expect(peak).toBe(3);
    expect(summary.succeeded).toEqual([1, 2, 3, 4, 5]);
  });

  it('pauses admission when a dynamic window falls below outstanding tasks', async () => {
    let window = 3;
    const submitted: number[] = [];
    const releases = new Map<number, () => void>();
    const run = runIndependentMutationPipeline([[1], [2], [3], [4]], {
      window: () => window,
      mutate: async ([id]) => { submitted.push(id); return `task-${id}`; },
      waitTask: async (taskId) => {
        const id = Number(taskId.split('-')[1]);
        await new Promise<void>((resolve) => releases.set(id, resolve));
      },
    });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(submitted).toEqual([1, 2, 3]);
    window = 1;
    releases.get(1)?.();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(submitted).toEqual([1, 2, 3]);
    releases.get(2)?.();
    releases.get(3)?.();
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
    expect(submitted).toEqual([1, 2, 3, 4]);
    releases.get(4)?.();
    expect((await run).succeeded.sort()).toEqual([1, 2, 3, 4]);
  });

  it('stops before the next batch after cancellation', async () => {
    const controller = new AbortController();
    const summary = await runMutationBatches([1, 2, 3], {
      batchSize: 1,
      delayMs: 0,
      signal: controller.signal,
      mutate: async (batch) => {
        if (batch[0] === 1) controller.abort();
        return 'task';
      },
      waitTask: async () => undefined,
    });
    expect(summary.succeeded).toEqual([1]);
    expect(summary.canceled).toBe(true);
  });
});
