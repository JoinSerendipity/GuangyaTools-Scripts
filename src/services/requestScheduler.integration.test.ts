import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runIndependentMutationPipeline, runMutationBatches } from '../utils/batch';
import { createCommittedRequestContext, createOperationRequestContext, type RequestContext } from './requestContext';
import { RequestScheduler } from './requestScheduler';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

describe('scheduler + mutation batch lifecycle', () => {
  it('drains three healthy committed tasks fairly under read and write load', async () => {
    const scheduler = new RequestScheduler({ random: () => 0 });
    const operation = createOperationRequestContext('fast');
    const committed = createCommittedRequestContext(operation);
    let totalActive = 0;
    let totalPeak = 0;
    let writeActive = 0;
    let writePeak = 0;
    let pollActive = 0;
    let pollPeak = 0;
    let committedActive = 0;
    let committedPeak = 0;
    const scheduled = async <T>(lane: 'read' | 'write' | 'poll', context: RequestContext, task: () => Promise<T>) =>
      scheduler.schedule(lane, context, async () => {
        totalActive += 1;
        totalPeak = Math.max(totalPeak, totalActive);
        if (lane === 'write') { writeActive += 1; writePeak = Math.max(writePeak, writeActive); }
        if (lane === 'poll') { pollActive += 1; pollPeak = Math.max(pollPeak, pollActive); }
        try { return await task(); }
        finally {
          totalActive -= 1;
          if (lane === 'write') writeActive -= 1;
          if (lane === 'poll') pollActive -= 1;
        }
      });

    const reads = Array.from({ length: 8 }, () => scheduled('read', operation, async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }));
    const pipeline = runIndependentMutationPipeline(Array.from({ length: 6 }, (_, index) => [index]), {
      window: 3,
      mutate: ([id]) => scheduled('write', operation, async () => `task-${id}`),
      waitTask: async () => {
        committedActive += 1;
        committedPeak = Math.max(committedPeak, committedActive);
        try {
          for (let round = 0; round < 3; round += 1) {
            await scheduled('poll', committed, async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
          }
        } finally { committedActive -= 1; }
      },
    });
    await vi.runAllTimersAsync();
    const [summary] = await Promise.all([pipeline, ...reads]);
    expect(summary.succeeded).toHaveLength(6);
    expect(committedPeak).toBe(3);
    expect(writePeak).toBe(1);
    expect(pollPeak).toBe(1);
    expect(totalPeak).toBeLessThanOrEqual(5);
  });

  it('finishes committed polling after cancellation and never submits the next mutation', async () => {
    const scheduler = new RequestScheduler({ random: () => 0 });
    const controller = new AbortController();
    const operation = createOperationRequestContext('fast', { signal: controller.signal });
    const committed = createCommittedRequestContext(operation);
    const submitted: number[] = [];
    const polled: string[] = [];

    const resultPromise = runMutationBatches([1, 2], {
      batchSize: 1,
      signal: controller.signal,
      mutate: (batch) => scheduler.schedule('write', operation, async () => {
        submitted.push(batch[0]);
        controller.abort(new DOMException('cancel after accepted', 'AbortError'));
        return `task-${batch[0]}`;
      }),
      waitTask: (taskId) => scheduler.schedule('poll', committed, async () => { polled.push(taskId); }),
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(submitted).toEqual([1]);
    expect(polled).toEqual(['task-1']);
    expect(result.succeeded).toEqual([1]);
    expect(result.unsubmitted).toEqual([2]);
    expect(result.canceled).toBe(true);
  });
});
