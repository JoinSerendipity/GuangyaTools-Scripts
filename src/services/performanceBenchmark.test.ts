import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileType, type GuangyaItem, type ListData } from '../types';
import { GuangyaApi } from './guangyaApi';
import { createOperationRequestContext, type RequestContext } from './requestContext';
import type { RequestSpeedMode } from './requestSpeedSettings';
import { requestScheduler } from './requestScheduler';
import { runIndependentMutationPipeline } from '../utils/batch';

function file(id: number, parentId: string): GuangyaItem {
  return {
    fileId: String(id), fileName: `${id}.txt`, fileSize: 1, parentId, parentName: '', depth: 1,
    dirType: 0, resType: 1, fileType: FileType.DOCUMENT, ext: 'txt', fullParentIds: parentId, ctime: 0, utime: 0,
  };
}

afterEach(() => {
  requestScheduler.resetForTests();
  vi.useRealTimers();
});

describe('simulated performance benchmark', () => {
  it('reads a 20-page directory in bounded parallel waves without increasing request count', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    requestScheduler.resetForTests();
    class TimedApi extends GuangyaApi {
      requests = 0;
      active = 0;
      peak = 0;
      override async listPage(parentId: string, page: number): Promise<ListData> {
        this.requests += 1;
        this.active += 1;
        this.peak = Math.max(this.peak, this.active);
        await new Promise((resolve) => setTimeout(resolve, 100));
        this.active -= 1;
        return { total: 1_000, list: Array.from({ length: 50 }, (_, index) => file(page * 50 + index, parentId)) };
      }
    }
    const api = new TimedApi();
    const startedAt = Date.now();
    const listing = api.listAllChildrenDetailed('root', {
      pageSize: 50,
      context: createOperationRequestContext('fast'),
    });
    await vi.runAllTimersAsync();
    const result = await listing;
    const elapsed = Date.now() - startedAt;

    expect(result).toMatchObject({ complete: true, observedTotal: 1_000 });
    expect(result.items).toHaveLength(1_000);
    expect(api.requests).toBe(20);
    expect(api.peak).toBe(4);
    expect(elapsed).toBeLessThanOrEqual(600);
    expect(elapsed).toBeLessThan(2_000); // 同样 100ms 延迟的串行基线为 20 × 100ms。
  });

  it('records four-mode staged baseline for a 500-directory consistency pass', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const elapsedByMode = {} as Record<RequestSpeedMode, number>;
    for (const mode of ['conservative', 'balanced', 'fast', 'auto'] as const) {
      requestScheduler.resetForTests();
      class ScheduledWideApi extends GuangyaApi {
        override async listPage(parentId: string, page: number, pageSize: number, options: { context?: RequestContext } = {}): Promise<ListData> {
          return requestScheduler.schedule('read', options.context || createOperationRequestContext(mode), async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            if (parentId === 'root') {
              const start = page * pageSize;
              const list = Array.from({ length: Math.max(0, Math.min(pageSize, 500 - start)) }, (_, index) => ({
                ...file(start + index, 'root'), fileId: `d${start + index}`, fileName: `D${start + index}`, resType: 2 as const,
              }));
              return { total: 500, page, list };
            }
            return { total: 0, page, list: [] };
          });
        }
      }
      const startedAt = Date.now();
      const pass = new ScheduledWideApi().walkDescendants('root', { purpose: 'consistency', context: createOperationRequestContext(mode) });
      await vi.runAllTimersAsync();
      expect((await pass).complete).toBe(true);
      elapsedByMode[mode] = Date.now() - startedAt;
    }
    // Deterministic 50ms-latency/50-item-page baseline: conservative 270110ms, balanced 129374ms, fast 80747ms, auto 82080ms.
    expect(elapsedByMode.conservative).toBeGreaterThan(elapsedByMode.balanced);
    expect(elapsedByMode.balanced).toBeGreaterThan(elapsedByMode.fast);
    expect(elapsedByMode.auto).toBeLessThan(elapsedByMode.balanced);
  });

  it('records the dependency-bound deep-tree baseline separately from the wide-tree case', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    class DeepTreeApi extends GuangyaApi {
      requests = 0;
      override async listPage(parentId: string): Promise<ListData> {
        this.requests += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        const depth = parentId === 'root' ? 0 : Number(parentId.slice(1)) + 1;
        if (depth >= 500) return { total: 0, list: [] };
        const id = `d${depth}`;
        return { total: 1, list: [{ ...file(depth, parentId), fileId: id, fileName: id, resType: 2 as const }] };
      }
    }
    const api = new DeepTreeApi();
    const startedAt = Date.now();
    const pass = api.walkDescendants('root', { purpose: 'consistency', context: createOperationRequestContext('fast') });
    await vi.runAllTimersAsync();
    expect((await pass).complete).toBe(true);
    expect(api.requests).toBe(501);
    expect(Date.now() - startedAt).toBe(5_010);
  });

  it('models 500 one-page child directories with bounded consistency and stable-pass request counts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    class WideTreeApi extends GuangyaApi {
      requests = 0;
      active = 0;
      peak = 0;
      override async listPage(parentId: string, page: number, pageSize: number): Promise<ListData> {
        this.requests += 1;
        this.active += 1;
        this.peak = Math.max(this.peak, this.active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        this.active -= 1;
        if (parentId === 'root') {
          const start = page * pageSize;
          const list = Array.from({ length: Math.max(0, Math.min(pageSize, 500 - start)) }, (_, index) => ({
            ...file(start + index, 'root'), fileId: `d${start + index}`, fileName: `D${start + index}`, resType: 2 as const,
          }));
          return { total: 500, page, list };
        }
        return { total: 0, page, list: [] };
      }
    }
    const api = new WideTreeApi();
    const pass = api.walkDescendants('root', { purpose: 'consistency', context: createOperationRequestContext('auto') });
    await vi.runAllTimersAsync();
    const result = await pass;
    expect(result.complete).toBe(true);
    expect(api.requests).toBe(510);
    expect(api.peak).toBeLessThanOrEqual(3);

    api.requests = 0;
    const stable = api.walkDescendantsStable('root', { context: createOperationRequestContext('fast') });
    await vi.runAllTimersAsync();
    expect((await stable).stable).toBe(true);
    expect(api.requests).toBe(1_020);
    expect(api.peak).toBeLessThanOrEqual(4);
  });

  it('models 500 independent committed move tasks with bounded windows', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const measure = async (window: number) => {
      let active = 0;
      let peak = 0;
      const startedAt = Date.now();
      const run = runIndependentMutationPipeline(
        Array.from({ length: 500 }, (_, index) => [index]),
        {
          window,
          mutate: async ([id]) => `task-${id}`,
          waitTask: async () => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            active -= 1;
          },
        },
      );
      await vi.runAllTimersAsync();
      const summary = await run;
      return { elapsed: Date.now() - startedAt, peak, succeeded: summary.succeeded.length };
    };
    const serial = await measure(1);
    vi.setSystemTime(0);
    const pipelined = await measure(3);
    expect(serial).toMatchObject({ peak: 1, succeeded: 500 });
    expect(pipelined).toMatchObject({ peak: 3, succeeded: 500 });
    expect(pipelined.elapsed).toBeLessThan(serial.elapsed * 0.4);
  });
});
