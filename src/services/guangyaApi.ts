import { unsafeWindow } from '$';
import type {
  ApiEnvelope,
  GuangyaItem,
  ListData,
  ProgressInfo,
  TaskData,
  TaskStatusData,
} from '../types';
import { clearAuthContext, waitForAuthContext } from './authCapture';

const API_BASE = 'https://api.guangyapan.com';
const DEFAULT_PAGE_SIZE = 50;

export class GuangyaApiError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GuangyaApiError';
  }
}

export interface WalkResult {
  items: GuangyaItem[];
  directories: GuangyaItem[];
  files: GuangyaItem[];
  itemById?: Map<string, GuangyaItem>;
}

export interface GuangyaApiLike {
  listAllChildren(
    parentId: string,
    options?: { signal?: AbortSignal; pageSize?: number; onProgress?: (progress: ProgressInfo) => void },
  ): Promise<GuangyaItem[]>;
  walkDescendants(
    parentId: string,
    options?: { signal?: AbortSignal; onProgress?: (progress: ProgressInfo) => void },
  ): Promise<WalkResult>;
  renameItem(fileId: string, newName: string, options?: { signal?: AbortSignal }): Promise<void>;
  moveItems(fileIds: string[], parentId: string, options?: { signal?: AbortSignal }): Promise<string>;
  trashItems(fileIds: string[], options?: { signal?: AbortSignal }): Promise<string>;
  waitTask(taskId: string, options?: { pollMs?: number; timeoutMs?: number }): Promise<void>;
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  unsafeWindow.crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function makeTraceparent(): string {
  return `00-${randomHex(16)}-${randomHex(8)}-01`;
}

function normalizeItem(item: Partial<GuangyaItem>): GuangyaItem {
  return {
    fileId: String(item.fileId || ''),
    fileName: String(item.fileName || ''),
    fileSize: Number(item.fileSize || 0),
    parentId: String(item.parentId || ''),
    parentName: String(item.parentName || ''),
    depth: Number(item.depth || 0),
    dirType: Number(item.dirType || 0),
    resType: item.resType === 2 ? 2 : 1,
    fileType: Number(item.fileType || 0) as GuangyaItem['fileType'],
    ext: String(item.ext || ''),
    fullParentIds: String(item.fullParentIds || ''),
    ctime: Number(item.ctime || 0),
    utime: Number(item.utime || 0),
    subFolderCount: item.subFolderCount == null ? undefined : Number(item.subFolderCount),
    auditStatus: item.auditStatus == null ? undefined : Number(item.auditStatus),
  };
}

export function parseListData(value: unknown, parentId: string): ListData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GuangyaApiError('目录列表响应结构无效，已停止操作以避免误删');
  }
  const record = value as Record<string, unknown>;
  const hasList = Object.hasOwn(record, 'list');
  const hasTotal = Object.hasOwn(record, 'total');
  // 已在真实接口确认：空目录返回 data: {}；非空目录同时返回 list 和 total。
  if (!hasList && !hasTotal) return { total: 0, list: [] };
  if (!hasList || !hasTotal || !Array.isArray(record.list)) {
    throw new GuangyaApiError('目录列表响应字段不完整，已停止操作以避免误删');
  }
  const total = Number(record.total);
  if (!Number.isFinite(total) || total < 0) {
    throw new GuangyaApiError('目录列表总数无效，已停止操作以避免误删');
  }
  return {
    total,
    page: typeof record.page === 'number' ? record.page : undefined,
    list: record.list.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new GuangyaApiError('目录列表包含无效项目，已停止操作以避免误删');
      }
      const typed = item as Partial<GuangyaItem>;
      return normalizeItem({ ...typed, parentId: typed.parentId ?? parentId });
    }),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GuangyaApi implements GuangyaApiLike {
  private readonly pageFetch = unsafeWindow.fetch.bind(unsafeWindow);

  protected async request<T>(path: string, body: unknown, options: { signal?: AbortSignal } = {}): Promise<ApiEnvelope<T>> {
    const context = await waitForAuthContext({ signal: options.signal });
    const headers: Record<string, string> = {
      Authorization: context.authorization,
      did: context.did,
      dt: context.dt,
      traceparent: makeTraceparent(),
      'Content-Type': 'application/json',
    };
    if (context.smid) headers.smid = context.smid;

    let response: Response;
    try {
      response = await this.pageFetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body ?? {}),
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      throw new GuangyaApiError(error instanceof Error ? error.message : '光鸭网盘请求失败');
    }

    let envelope: ApiEnvelope<T>;
    try {
      envelope = (await response.json()) as ApiEnvelope<T>;
    } catch {
      throw new GuangyaApiError(`接口返回了无法解析的数据（HTTP ${response.status}）`, undefined, response.status);
    }

    const code = typeof envelope.code === 'number' ? envelope.code : 0;
    if (response.status === 401 || response.status === 403) {
      clearAuthContext();
      throw new GuangyaApiError('登录状态已过期，请刷新光鸭网盘页面后重试', code, response.status);
    }
    if (!response.ok || code !== 0) {
      throw new GuangyaApiError(envelope.msg || `光鸭网盘业务错误 ${code}`, code, response.status);
    }
    return envelope;
  }

  async listPage(
    parentId: string,
    page: number,
    pageSize = DEFAULT_PAGE_SIZE,
    options: { signal?: AbortSignal } = {},
  ): Promise<ListData> {
    const response = await this.request<ListData>(
      '/userres/v1/file/get_file_list',
      { parentId, pageSize, orderBy: 3, sortType: 1, page },
      options,
    );
    return parseListData(response.data, parentId);
  }

  async listAllChildren(
    parentId: string,
    options: { signal?: AbortSignal; pageSize?: number; onProgress?: (progress: ProgressInfo) => void } = {},
  ): Promise<GuangyaItem[]> {
    const pageSize = options.pageSize || DEFAULT_PAGE_SIZE;
    const result: GuangyaItem[] = [];
    for (let page = 0; ; page += 1) {
      options.signal?.throwIfAborted();
      options.onProgress?.({
        phase: 'scan-page',
        message: `正在读取第 ${page + 1} 页，已扫描 ${result.length} 项`,
        current: result.length,
        total: Math.max(result.length + 1, 1),
      });
      const data = await this.listPage(parentId, page, pageSize, options);
      result.push(...data.list);
      const total = Math.max(data.total, result.length);
      options.onProgress?.({
        phase: 'scan-page',
        message: `已扫描 ${result.length}/${total} 项`,
        current: result.length,
        total,
      });
      if (data.list.length === 0 || result.length >= data.total) break;
    }
    return result;
  }

  async walkDescendants(
    parentId: string,
    options: { signal?: AbortSignal; onProgress?: (progress: ProgressInfo) => void } = {},
  ): Promise<WalkResult> {
    const queue = [parentId];
    const visited = new Set<string>();
    const items: GuangyaItem[] = [];
    const directories: GuangyaItem[] = [];
    const files: GuangyaItem[] = [];
    const itemById = new Map<string, GuangyaItem>();

    while (queue.length > 0) {
      options.signal?.throwIfAborted();
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const knownDirectoryTotal = visited.size + queue.length;
      options.onProgress?.({
        phase: 'scan',
        message: `正在扫描第 ${visited.size}/${knownDirectoryTotal} 个目录，累计 ${items.length} 项`,
        current: visited.size - 1,
        total: knownDirectoryTotal,
      });
      const children = await this.listAllChildren(current, {
        signal: options.signal,
        onProgress: (pageProgress) => {
          const pageRatio = pageProgress.total > 0 ? pageProgress.current / pageProgress.total : 0;
          options.onProgress?.({
            phase: 'scan',
            message: `目录 ${visited.size}/${knownDirectoryTotal}：${pageProgress.message}；累计 ${items.length + pageProgress.current} 项`,
            current: (visited.size - 1) + Math.min(1, Math.max(0, pageRatio)),
            total: knownDirectoryTotal,
          });
        },
      });
      for (const item of children) {
        if (!item.fileId) continue;
        itemById.set(item.fileId, item);
        items.push(item);
        if (item.resType === 2) {
          directories.push(item);
          if (!visited.has(item.fileId)) queue.push(item.fileId);
        } else {
          files.push(item);
        }
      }
      options.onProgress?.({
        phase: 'scan',
        message: `已扫描 ${visited.size}/${visited.size + queue.length} 个目录，累计 ${items.length} 项`,
        current: visited.size,
        total: visited.size + queue.length,
      });
    }
    options.onProgress?.({
      phase: 'scan',
      message: `扫描完成：${visited.size} 个目录，${items.length} 项`,
      current: visited.size,
      total: visited.size,
    });
    return { items, directories, files, itemById };
  }

  async renameItem(fileId: string, newName: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    if (!fileId) throw new GuangyaApiError('重命名缺少文件 ID');
    await this.request<unknown>('/userres/v1/file/rename', { fileId, newName }, options);
  }

  async moveItems(fileIds: string[], parentId: string, options: { signal?: AbortSignal } = {}): Promise<string> {
    if (fileIds.length === 0) return '';
    const response = await this.request<TaskData>(
      '/userres/v1/file/move_file',
      { fileIds, parentId },
      options,
    );
    const taskId = String(response.data?.taskId || '');
    if (!taskId) throw new GuangyaApiError('移动接口未返回任务 ID');
    return taskId;
  }

  async trashItems(fileIds: string[], options: { signal?: AbortSignal } = {}): Promise<string> {
    if (fileIds.length === 0) return '';
    const response = await this.request<TaskData>('/userres/v1/file/delete_file', { fileIds }, options);
    const taskId = String(response.data?.taskId || '');
    if (!taskId) throw new GuangyaApiError('删除接口未返回任务 ID');
    return taskId;
  }

  async waitTask(taskId: string, options: { pollMs?: number; timeoutMs?: number } = {}): Promise<void> {
    if (!taskId) return;
    const pollMs = options.pollMs || 1_000;
    const timeoutMs = options.timeoutMs || 10 * 60_000;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      await delay(pollMs);
      const response = await this.request<TaskStatusData>('/userres/v1/get_task_status', { taskId });
      const status = Number(response.data?.status);
      const detailCode = Number(response.data?.detail?.code || 0);
      if ([2, 3].includes(status) && detailCode !== 0) {
        throw new GuangyaApiError(response.data?.detail?.msg || '任务失败', detailCode);
      }
      if (status === 2) return;
      if (status === 3) throw new GuangyaApiError(response.data?.detail?.msg || '任务失败');
    }
    throw new GuangyaApiError('等待任务完成超时');
  }
}
