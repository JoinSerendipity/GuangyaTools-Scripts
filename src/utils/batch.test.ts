import { describe, expect, it } from 'vitest';
import { chunkItems, runMutationBatches } from './batch';

describe('batch utilities', () => {
  it('splits items without dropping the tail', () => {
    expect(chunkItems([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(() => chunkItems([1], 0)).toThrow();
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
