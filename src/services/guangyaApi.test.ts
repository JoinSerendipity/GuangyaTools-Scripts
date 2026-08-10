import { afterEach, describe, expect, it, vi } from 'vitest';
import { GuangyaApi, parseListData, parseRetryAfter, type GuangyaApiLike } from './guangyaApi';
import { FileType, type ApiEnvelope, type GuangyaItem, type ListData } from '../types';
import { createCommittedRequestContext, createOperationRequestContext } from './requestContext';
import { requestScheduler } from './requestScheduler';

const item = (fileId: string, fileName: string, parentId: string, resType: 1 | 2): GuangyaItem => ({
  fileId,
  fileName,
  parentId,
  parentName: '',
  fileSize: 0,
  depth: 0,
  dirType: 0,
  resType,
  fileType: FileType.UNKNOWN,
  ext: '',
  fullParentIds: parentId,
  ctime: 0,
  utime: 0,
});

class ProgressApi extends GuangyaApi implements GuangyaApiLike {
  constructor(private readonly pages: Record<string, ListData[]>) { super(); }

  override async listPage(parentId: string, page: number): Promise<ListData> {
    return this.pages[parentId]?.[page] || { total: 0, list: [] };
  }
}

class RecordingApi extends GuangyaApi {
  calls: Array<{ path: string; body: unknown }> = [];

  protected override async request<T>(path: string, body: unknown): Promise<ApiEnvelope<T>> {
    this.calls.push({ path, body });
    return { code: 0, data: {} as T };
  }
}

describe('Guangya list response contract', () => {
  it('accepts the verified empty-directory data object', () => {
    expect(parseListData({}, 'parent')).toEqual({ total: 0, list: [] });
  });

  it('parses a complete list and supplies a missing parentId from the request', () => {
    const parsed = parseListData({ total: 1, list: [{ fileId: '1', fileName: 'A', resType: 2 }] }, 'parent');
    expect(parsed.total).toBe(1);
    expect(parsed.list[0]).toMatchObject({ fileId: '1', fileName: 'A', parentId: 'parent', resType: 2 });
  });

  it('fails closed on malformed or partial list data', () => {
    expect(() => parseListData(null, 'parent')).toThrow('停止操作');
    expect(() => parseListData({ total: 1 }, 'parent')).toThrow('停止操作');
    expect(() => parseListData({ total: -1, list: [] }, 'parent')).toThrow('停止操作');
    expect(() => parseListData({ total: 1, list: [null] }, 'parent')).toThrow('停止操作');
  });

  it('reports paged list progress with scanned item counts', async () => {
    const api = new ProgressApi({
      root: [
        { total: 3, list: [item('1', 'a.txt', 'root', 1), item('2', 'b.txt', 'root', 1)] },
        { total: 3, list: [item('3', 'c.txt', 'root', 1)] },
      ],
    });
    const progress: string[] = [];
    const result = await api.listAllChildren('root', { pageSize: 2, onProgress: (entry) => progress.push(`${entry.current}/${entry.total}:${entry.message}`) });
    expect(result).toHaveLength(3);
    expect(progress).toContain('0/1:正在读取第 1 页，已扫描 0 项');
    expect(progress.at(-1)).toBe('3/3:已扫描 3/3 项');
  });

  it('sends the verified rename endpoint payload', async () => {
    const api = new RecordingApi();
    await api.renameItem('file-1', '新名称.txt');
    expect(api.calls).toEqual([{ path: '/userres/v1/file/rename', body: { fileId: 'file-1', newName: '新名称.txt' } }]);
  });

  it('reports recursive scan progress with directory and item counts', async () => {
    const api = new ProgressApi({
      root: [{ total: 2, list: [item('dir', 'Sub', 'root', 2), item('file', 'root.txt', 'root', 1)] }],
      dir: [{ total: 1, list: [item('nested', 'nested.txt', 'dir', 1)] }],
    });
    const messages: string[] = [];
    const result = await api.walkDescendants('root', { onProgress: (entry) => messages.push(entry.message) });
    expect(result.files.map((entry) => entry.fileId)).toEqual(['file', 'nested']);
    expect(messages.some((message) => message.includes('累计'))).toBe(true);
    expect(messages.at(-1)).toBe('扫描完成：2 个目录，3 项');
  });
});

describe('concurrent listing completeness', () => {
  it('merges out-of-order page completions by page index', async () => {
    class OutOfOrderApi extends GuangyaApi {
      override async listPage(parentId: string, page: number): Promise<ListData> {
        if (page === 1) await new Promise((resolve) => setTimeout(resolve, 15));
        if (page === 2) await new Promise((resolve) => setTimeout(resolve, 1));
        return {
          total: 6,
          list: [item(String(page * 2 + 1), `${page}-a`, parentId, 1), item(String(page * 2 + 2), `${page}-b`, parentId, 1)],
        };
      }
    }
    const result = await new OutOfOrderApi().listAllChildrenDetailed('root', { pageSize: 2 });
    expect(result.complete).toBe(true);
    expect(result.snapshotStable).toBe(false);
    expect(result.items.map((entry) => entry.fileId)).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('marks duplicate/shifted pages incomplete after bounded reconciliation', async () => {
    class DuplicateApi extends GuangyaApi {
      override async listPage(parentId: string, page: number): Promise<ListData> {
        if (page === 0) return { total: 3, list: [item('1', 'a', parentId, 1), item('2', 'b', parentId, 1)] };
        if (page === 1) return { total: 3, list: [item('2', 'b', parentId, 1)] };
        return { total: 3, list: [] };
      }
    }
    const result = await new DuplicateApi().listAllChildrenDetailed('root', { pageSize: 2, maxPages: 4 });
    expect(result.complete).toBe(false);
    expect(result.items.map((entry) => entry.fileId)).toEqual(['1', '2']);
  });

  it('rejects duplicate IDs even when unique IDs still reach total', async () => {
    class DuplicateButFullApi extends GuangyaApi {
      override async listPage(parentId: string, page: number): Promise<ListData> {
        if (page === 0) return { total: 3, page, list: [item('1', 'a', parentId, 1), item('2', 'b', parentId, 1)] };
        return { total: 3, page, list: [item('2', 'b', parentId, 1), item('3', 'c', parentId, 1)] };
      }
    }
    const result = await new DuplicateButFullApi().listAllChildrenDetailed('root', { purpose: 'consistency', pageSize: 2 });
    expect(result.complete).toBe(false);
    expect(result.reason).toContain('重复');
  });

  it('rejects wrong-page and overfull consistency responses', async () => {
    class WrongPageApi extends GuangyaApi {
      override async listPage(parentId: string, page: number): Promise<ListData> {
        return { total: 1, page: page + 1, list: [item('1', 'a', parentId, 1)] };
      }
    }
    class OverfullApi extends GuangyaApi {
      override async listPage(parentId: string, page: number): Promise<ListData> {
        return { total: 3, page, list: [item('1', 'a', parentId, 1), item('2', 'b', parentId, 1), item('3', 'c', parentId, 1)] };
      }
    }
    await expect(new WrongPageApi().listAllChildrenDetailed('root', { purpose: 'consistency', pageSize: 2 }))
      .resolves.toMatchObject({ complete: false });
    await expect(new OverfullApi().listAllChildrenDetailed('root', { purpose: 'consistency', pageSize: 2 }))
      .resolves.toMatchObject({ complete: false });
  });

  it('requires two identical complete sequential listings for verification', async () => {
    class ChangingApi extends GuangyaApi {
      calls = 0;
      override async listPage(parentId: string): Promise<ListData> {
        this.calls += 1;
        const id = this.calls === 1 ? 'first' : 'second';
        return { total: 1, list: [item(id, id, parentId, 1)] };
      }
    }
    const result = await new ChangingApi().listAllChildrenDetailed('root', { purpose: 'verification' });
    expect(result.complete).toBe(false);
    expect(result.reason).toContain('连续两次');
  });

  it('runs globally sequential stable tree passes and rejects same-total replacement drift', async () => {
    class StableTreeApi extends GuangyaApi {
      rootCalls = 0;
      order: string[] = [];
      override async listPage(parentId: string): Promise<ListData> {
        this.order.push(parentId);
        if (parentId === 'root') {
          this.rootCalls += 1;
          return this.rootCalls === 1
            ? { total: 1, list: [item('dir', 'Dir', 'root', 2)] }
            : { total: 1, list: [item('replacement', 'Dir', 'root', 2)] };
        }
        return { total: 0, list: [] };
      }
    }
    const api = new StableTreeApi();
    const result = await api.walkDescendantsStable('root');
    expect(api.order).toEqual(['root', 'dir', 'root', 'replacement']);
    expect(result.complete).toBe(false);
    expect(result.stable).toBe(false);
  });

  it('finishes every multi-page directory in Pass A before Pass B starts', async () => {
    class OrderedStableApi extends GuangyaApi {
      pass = 0;
      events: string[] = [];
      override async listPage(parentId: string, page: number, pageSize: number): Promise<ListData> {
        if (parentId === 'root' && page === 0) this.pass += 1;
        this.events.push(`${this.pass}:${parentId}:${page}`);
        if (parentId !== 'root') return { total: 0, page, list: [] };
        const start = page * pageSize;
        const list = Array.from({ length: Math.max(0, Math.min(pageSize, 51 - start)) }, (_, index) =>
          item(`d${start + index}`, `D${start + index}`, 'root', 2));
        return { total: 51, page, list };
      }
    }
    const api = new OrderedStableApi();
    const result = await api.walkDescendantsStable('root');
    expect(result.stable).toBe(true);
    const passBStart = api.events.indexOf('2:root:0');
    expect(passBStart).toBeGreaterThan(0);
    expect(api.events.slice(0, passBStart).every((event) => event.startsWith('1:'))).toBe(true);
    expect(api.events.slice(passBStart).every((event) => event.startsWith('2:'))).toBe(true);
  });

  it('aborts a hung concurrent page at the listing deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    requestScheduler.resetForTests();
    const pageFetch = vi.fn<typeof fetch>(async (_input, init) => {
      const page = Number(JSON.parse(String(init?.body || '{}')).page || 0);
      if (page > 0) return new Promise<Response>(() => undefined);
      return new Response(JSON.stringify({
        code: 0,
        data: { total: 100, list: Array.from({ length: 50 }, (_, index) => ({ fileId: String(index), fileName: String(index), resType: 1 })) },
      }), { status: 200 });
    });
    const api = new GuangyaApi({
      fetch: pageFetch,
      authProvider: async () => ({ authorization: 'secret', did: 'did', dt: 'dt', capturedAt: 0 }),
    });
    const listing = api.listAllChildrenDetailed('root', { deadlineMs: 500, context: createOperationRequestContext('fast') });
    await vi.runAllTimersAsync();
    await expect(listing).resolves.toMatchObject({ complete: false, reason: '目录读取超过安全时间上限' });
  });

  it('terminates when the first observed page range exceeds the hard cap', async () => {
    class HugeApi extends GuangyaApi {
      override async listPage(parentId: string): Promise<ListData> {
        return { total: 10_000, list: [item('1', 'a', parentId, 1)] };
      }
    }
    const result = await new HugeApi().listAllChildrenDetailed('root', { pageSize: 50, maxPages: 3 });
    expect(result.complete).toBe(false);
    expect(result.reason).toContain('安全上限');
  });
});

describe('retry and task contracts', () => {
  afterEach(() => {
    requestScheduler.resetForTests();
    vi.useRealTimers();
  });

  it('parses Retry-After seconds, HTTP dates, and malformed values', () => {
    expect(parseRetryAfter('2', 0)).toBe(2_000);
    expect(parseRetryAfter('Thu, 01 Jan 1970 00:00:05 GMT', 1_000)).toBe(4_000);
    expect(parseRetryAfter('invalid', 0)).toBeUndefined();
  });

  it('retries an idempotent 429 read after Retry-After', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    requestScheduler.resetForTests();
    const pageFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 429, msg: '请求频繁', data: {} }), { status: 429, headers: { 'Retry-After': '0.5' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 }));
    const api = new GuangyaApi({
      fetch: pageFetch,
      authProvider: async () => ({ authorization: 'secret', did: 'did', dt: 'dt', capturedAt: 0 }),
    });
    const listing = api.listPage('root', 0, 50, { context: createOperationRequestContext('fast') });
    await vi.runAllTimersAsync();
    await expect(listing).resolves.toEqual({ total: 0, list: [] });
    expect(pageFetch).toHaveBeenCalledTimes(2);
  });

  it('rejects direct mutation calls above the immutable 50-item boundary before fetch', async () => {
    const pageFetch = vi.fn<typeof fetch>();
    const api = new GuangyaApi({
      fetch: pageFetch,
      authProvider: async () => ({ authorization: 'secret', did: 'did', dt: 'dt', capturedAt: 0 }),
    });
    const ids = Array.from({ length: 51 }, (_, index) => String(index));
    await expect(api.moveItems(ids, 'root')).rejects.toThrow('最多 50');
    await expect(api.trashItems(ids)).rejects.toThrow('最多 50');
    expect(pageFetch).not.toHaveBeenCalled();
  });

  it('never replays a non-idempotent write after a 5xx outcome', async () => {
    requestScheduler.resetForTests();
    const pageFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ code: 500, msg: 'server error', data: {} }), { status: 500 }),
    );
    const api = new GuangyaApi({
      fetch: pageFetch,
      authProvider: async () => ({ authorization: 'secret', did: 'did', dt: 'dt', capturedAt: 0 }),
    });
    await expect(api.renameItem('file', 'next.txt', { context: createOperationRequestContext('fast') }))
      .rejects.toMatchObject({ outcome: 'outcome-unknown' });
    expect(pageFetch).toHaveBeenCalledTimes(1);
  });

  it('classifies a successful mutation response without task ID as unknown', async () => {
    requestScheduler.resetForTests();
    const pageFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 }),
    );
    const api = new GuangyaApi({
      fetch: pageFetch,
      authProvider: async () => ({ authorization: 'secret', did: 'did', dt: 'dt', capturedAt: 0 }),
    });
    await expect(api.moveItems(['file'], 'target', { context: createOperationRequestContext('fast') }))
      .rejects.toMatchObject({ outcome: 'outcome-unknown' });
    expect(pageFetch).toHaveBeenCalledTimes(1);
    expect(requestScheduler.getAcceptedTaskWindow('fast')).toBe(1);
  });

  it('uses progressive polling until a known terminal success', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    class TaskApi extends GuangyaApi {
      calls = 0;
      protected override async request<T>(): Promise<ApiEnvelope<T>> {
        this.calls += 1;
        const status = this.calls >= 3 ? 2 : 0;
        return { code: 0, data: { status } as T };
      }
    }
    const api = new TaskApi();
    const waiting = api.waitTask('task', { pollMs: 10, timeoutMs: 1_000 });
    await vi.runAllTimersAsync();
    await expect(waiting).resolves.toBeUndefined();
    expect(api.calls).toBe(3);
  });

  it('bounds a hung committed poll by its own deadline and releases the poll lane', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    requestScheduler.resetForTests();
    const never = new Promise<Response>(() => undefined);
    const api = new GuangyaApi({
      fetch: async () => never,
      authProvider: async () => ({ authorization: 'secret', did: 'did', dt: 'dt', capturedAt: 0 }),
    });
    const waiting = api.waitTask('hung-task', { pollMs: 10, timeoutMs: 50 });
    const assertion = expect(waiting).rejects.toMatchObject({ outcome: 'task-unknown' });
    await vi.runAllTimersAsync();
    await assertion;

    const operation = createOperationRequestContext('fast');
    const nextPoll = requestScheduler.schedule('poll', createCommittedRequestContext(operation), async () => 'released');
    await vi.runAllTimersAsync();
    await expect(nextPoll).resolves.toBe('released');
  });

  it('reports an explicit server task failure as definite task failure', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    class FailedTaskApi extends GuangyaApi {
      protected override async request<T>(): Promise<ApiEnvelope<T>> {
        return { code: 0, data: { status: 3, detail: { code: 9, msg: 'task failed' } } as T };
      }
    }
    const waiting = new FailedTaskApi().waitTask('task', { pollMs: 10 });
    const assertion = expect(waiting).rejects.toMatchObject({ outcome: 'task-failed', code: 9 });
    await vi.runAllTimersAsync();
    await assertion;
  });

  it('classifies polling timeout as an unknown task outcome', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    class PendingApi extends GuangyaApi {
      protected override async request<T>(): Promise<ApiEnvelope<T>> {
        return { code: 0, data: { status: 0 } as T };
      }
    }
    const waiting = new PendingApi().waitTask('task', { pollMs: 10, timeoutMs: 25 });
    const assertion = expect(waiting).rejects.toMatchObject({ outcome: 'task-unknown' });
    await vi.runAllTimersAsync();
    await assertion;
    expect(requestScheduler.getAcceptedTaskWindow('fast')).toBe(1);
    expect(requestScheduler.getAcceptedTaskWindow('balanced')).toBe(1);
  });
});
