import { describe, expect, it } from 'vitest';
import { GuangyaApi, parseListData, type GuangyaApiLike } from './guangyaApi';
import { FileType, type ApiEnvelope, type GuangyaItem, type ListData } from '../types';

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
