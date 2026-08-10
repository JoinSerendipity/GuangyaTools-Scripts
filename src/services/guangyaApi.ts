import { unsafeWindow } from '$';
import type {
  ApiEnvelope,
  GuangyaItem,
  ListData,
  ProgressInfo,
  TaskData,
  TaskStatusData,
} from '../types';
import { clearAuthContext, waitForAuthContext, type AuthContext } from './authCapture';
import {
  createCommittedRequestContext,
  createOperationRequestContext,
  type RequestContext,
} from './requestContext';
import { requestScheduler, type RequestLane } from './requestScheduler';
import { REQUEST_SAFETY_LIMITS } from './requestSafetyLimits';

const API_BASE = 'https://api.guangyapan.com';
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 1_000;
const DEFAULT_LIST_DEADLINE_MS = 2 * 60_000;
const DEFAULT_TRANSPORT_TIMEOUT_MS = 30_000;
const POLL_TRANSPORT_TIMEOUT_MS = REQUEST_SAFETY_LIMITS.pollTransportTimeoutMs;

export type MutationErrorOutcome = 'definite-rejection' | 'outcome-unknown' | 'task-failed' | 'task-unknown';

export class GuangyaApiError extends Error {
  readonly retryable: boolean;
  readonly rateLimited: boolean;
  readonly retryAfterMs?: number;
  readonly outcome?: MutationErrorOutcome;

  constructor(
    message: string,
    readonly code?: number,
    readonly status?: number,
    details: {
      retryable?: boolean;
      rateLimited?: boolean;
      retryAfterMs?: number;
      outcome?: MutationErrorOutcome;
    } = {},
  ) {
    super(message);
    this.name = 'GuangyaApiError';
    this.retryable = Boolean(details.retryable);
    this.rateLimited = Boolean(details.rateLimited);
    this.retryAfterMs = details.retryAfterMs;
    this.outcome = details.outcome;
  }
}

export interface ListingResult {
  items: GuangyaItem[];
  complete: boolean;
  observedTotal: number;
  snapshotStable?: boolean;
  reason?: string;
}

export interface DirectoryListingEvidence {
  parentId: string;
  observedTotal: number;
  orderedChildIds: string[];
  complete: boolean;
}

export interface WalkResult {
  items: GuangyaItem[];
  directories: GuangyaItem[];
  files: GuangyaItem[];
  itemById?: Map<string, GuangyaItem>;
  directoryListings?: Map<string, DirectoryListingEvidence>;
  complete?: boolean;
  incompleteReason?: string;
  stable?: boolean;
}

export interface ApiOperationOptions {
  signal?: AbortSignal;
  context?: RequestContext;
}

export interface ListChildrenOptions extends ApiOperationOptions {
  pageSize?: number;
  onProgress?: (progress: ProgressInfo) => void;
  purpose?: 'preview' | 'verification' | 'consistency';
  maxPages?: number;
  deadlineMs?: number;
}

export interface GuangyaApiLike {
  listAllChildren(parentId: string, options?: ListChildrenOptions): Promise<GuangyaItem[]>;
  listAllChildrenDetailed?(parentId: string, options?: ListChildrenOptions): Promise<ListingResult>;
  walkDescendants(
    parentId: string,
    options?: ApiOperationOptions & { onProgress?: (progress: ProgressInfo) => void; purpose?: 'preview' | 'verification' | 'consistency'; deadlineMs?: number },
  ): Promise<WalkResult>;
  walkDescendantsStable?(
    parentId: string,
    options?: ApiOperationOptions & { onProgress?: (progress: ProgressInfo) => void; deadlineMs?: number },
  ): Promise<WalkResult>;
  renameItem(fileId: string, newName: string, options?: ApiOperationOptions): Promise<void>;
  moveItems(fileIds: string[], parentId: string, options?: ApiOperationOptions): Promise<string>;
  trashItems(fileIds: string[], options?: ApiOperationOptions): Promise<string>;
  waitTask(taskId: string, options?: { pollMs?: number; timeoutMs?: number; context?: RequestContext }): Promise<void>;
}

interface InternalRequestOptions extends ApiOperationOptions {
  lane?: RequestLane;
  idempotent?: boolean;
  mutation?: boolean;
  transportTimeoutMs?: number;
  deadlineAt?: number;
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

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(120_000, Math.round(seconds * 1_000));
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.min(120_000, Math.max(0, timestamp - now));
}

function isRateLimitMessage(message: string): boolean {
  return /(请求.{0,4}(频繁|过快)|操作.{0,4}频繁|稍后再试|too\s*many|rate\s*limit)/i.test(message);
}

function contextFor(options: ApiOperationOptions = {}, committed = false): RequestContext {
  const base = options.context || createOperationRequestContext('auto', { signal: options.signal });
  return committed && !base.committed ? createCommittedRequestContext(base) : base;
}

function stableMerge(pages: readonly ListData[]): GuangyaItem[] {
  const byId = new Map<string, GuangyaItem>();
  for (const page of pages) {
    for (const item of page.list) if (item.fileId && !byId.has(item.fileId)) byId.set(item.fileId, item);
  }
  return [...byId.values()];
}

function sameListing(left: ListingResult, right: ListingResult): boolean {
  if (!left.complete || !right.complete || left.observedTotal !== right.observedTotal || left.items.length !== right.items.length) return false;
  return left.items.every((item, index) => item.fileId === right.items[index]?.fileId);
}

export function walkEvidenceFingerprint(walk: WalkResult): string {
  if (walk.complete === false || !walk.directoryListings) return '';
  const items = [...walk.items]
    .sort((left, right) => left.fileId.localeCompare(right.fileId))
    .map((item) => [item.fileId, item.parentId, item.resType, item.fileName, item.depth, item.fullParentIds]);
  const listings = [...walk.directoryListings.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, evidence]) => [id, evidence.observedTotal, evidence.complete, evidence.orderedChildIds]);
  return JSON.stringify({ items, listings });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason || new DOMException('请求已中止', 'AbortError'));
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

function createTransportSignal(source: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timeoutReached = false;
  const onSourceAbort = () => controller.abort(source?.reason || new DOMException('操作已取消', 'AbortError'));
  if (source?.aborted) onSourceAbort();
  else source?.addEventListener('abort', onSourceAbort, { once: true });
  const timer = setTimeout(() => {
    timeoutReached = true;
    controller.abort(new DOMException('请求传输超时', 'TimeoutError'));
  }, Math.max(1, timeoutMs));
  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    cleanup: () => {
      clearTimeout(timer);
      source?.removeEventListener('abort', onSourceAbort);
    },
  };
}

export interface GuangyaApiDependencies {
  fetch?: typeof fetch;
  authProvider?: (options: { signal?: AbortSignal }) => Promise<AuthContext>;
}

export class GuangyaApi implements GuangyaApiLike {
  private readonly pageFetch: typeof fetch;
  private readonly authProvider: (options: { signal?: AbortSignal }) => Promise<AuthContext>;

  constructor(dependencies: GuangyaApiDependencies = {}) {
    this.pageFetch = dependencies.fetch || unsafeWindow.fetch.bind(unsafeWindow);
    this.authProvider = dependencies.authProvider || waitForAuthContext;
  }

  private async performHttpRequest<T>(
    path: string,
    body: unknown,
    lane: RequestLane,
    idempotent: boolean,
    mutation: boolean,
    context: RequestContext,
    transportTimeoutMs: number,
  ): Promise<ApiEnvelope<T>> {
    const operationSignal = lane === 'write' || context.committed ? undefined : context.signal;
    const transport = createTransportSignal(operationSignal, transportTimeoutMs);
    try {
      const auth = await awaitWithSignal(this.authProvider({ signal: transport.signal }), transport.signal);
      const headers: Record<string, string> = {
        Authorization: auth.authorization,
        did: auth.did,
        dt: auth.dt,
        traceparent: makeTraceparent(),
        'Content-Type': 'application/json',
      };
      if (auth.smid) headers.smid = auth.smid;

      let response: Response;
      try {
        response = await awaitWithSignal(this.pageFetch(`${API_BASE}${path}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body ?? {}),
          signal: transport.signal,
        }), transport.signal);
      } catch (error) {
        if (operationSignal?.aborted) throw operationSignal.reason;
        if (transport.timedOut()) {
          throw new GuangyaApiError('请求传输超时', undefined, undefined, {
            retryable: idempotent,
            outcome: mutation ? 'outcome-unknown' : undefined,
          });
        }
        throw new GuangyaApiError(error instanceof Error ? error.message : '光鸭网盘请求失败', undefined, undefined, {
          retryable: idempotent,
          outcome: mutation ? 'outcome-unknown' : undefined,
        });
      }

      const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
      let envelope: ApiEnvelope<T>;
      try {
        envelope = (await awaitWithSignal(response.json(), transport.signal)) as ApiEnvelope<T>;
      } catch {
        if (transport.timedOut()) {
          throw new GuangyaApiError('读取接口响应超时', undefined, response.status, {
            retryable: idempotent,
            outcome: mutation ? 'outcome-unknown' : undefined,
          });
        }
        throw new GuangyaApiError(`接口返回了无法解析的数据（HTTP ${response.status}）`, undefined, response.status, {
          retryable: idempotent && (response.status === 408 || response.status === 429 || response.status >= 500),
          rateLimited: response.status === 429,
          retryAfterMs,
          outcome: mutation ? 'outcome-unknown' : undefined,
        });
      }

      const code = typeof envelope.code === 'number' ? envelope.code : 0;
      const message = envelope.msg || `光鸭网盘业务错误 ${code}`;
      if (response.status === 401 || response.status === 403) {
        clearAuthContext();
        throw new GuangyaApiError('登录状态已过期，请刷新光鸭网盘页面后重试', code, response.status, {
          outcome: mutation ? 'outcome-unknown' : undefined,
        });
      }
      if (!response.ok || code !== 0) {
        const rateLimited = response.status === 429 || isRateLimitMessage(message);
        const retryable = idempotent && (rateLimited || response.status === 408 || response.status >= 500);
        const definiteBusinessRejection = response.ok && code !== 0;
        throw new GuangyaApiError(message, code, response.status, {
          retryable,
          rateLimited,
          retryAfterMs,
          outcome: mutation ? (definiteBusinessRejection ? 'definite-rejection' : 'outcome-unknown') : undefined,
        });
      }
      return envelope;
    } catch (error) {
      if (error instanceof GuangyaApiError || operationSignal?.aborted) throw error;
      if (transport.timedOut()) {
        throw new GuangyaApiError('认证或请求传输超时', undefined, undefined, {
          retryable: idempotent,
          outcome: mutation ? 'outcome-unknown' : undefined,
        });
      }
      throw new GuangyaApiError(error instanceof Error ? error.message : String(error), undefined, undefined, {
        retryable: idempotent,
        outcome: mutation ? 'outcome-unknown' : undefined,
      });
    } finally {
      transport.cleanup();
    }
  }

  protected async request<T>(path: string, body: unknown, options: InternalRequestOptions = {}): Promise<ApiEnvelope<T>> {
    const lane = options.lane || 'read';
    const idempotent = options.idempotent ?? lane !== 'write';
    const mutation = options.mutation ?? lane === 'write';
    const context = contextFor(options, lane === 'poll');
    const maxAttempts = idempotent ? 3 : 1;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
        throw new GuangyaApiError('请求超过截止时间');
      }
      try {
        const remainingTransportMs = options.deadlineAt === undefined
          ? undefined
          : Math.max(1, options.deadlineAt - Date.now());
        return await requestScheduler.schedule(lane, context, () => this.performHttpRequest<T>(
          path,
          body,
          lane,
          idempotent,
          mutation,
          context,
          Math.min(
            options.transportTimeoutMs || (lane === 'poll' ? POLL_TRANSPORT_TIMEOUT_MS : DEFAULT_TRANSPORT_TIMEOUT_MS),
            remainingTransportMs ?? Number.POSITIVE_INFINITY,
          ),
        ));
      } catch (error) {
        if (!(error instanceof GuangyaApiError)) throw error;
        if (error.rateLimited) requestScheduler.penalize(error.retryAfterMs ?? 1_000 * (2 ** attempt), error.message);
        else if (error.retryable || error.status && error.status >= 500 || mutation && error.outcome === 'outcome-unknown') {
          requestScheduler.penalize(500 * (2 ** attempt), `接口暂时不可用：${error.message}`);
        }
        if (!error.retryable || attempt >= maxAttempts - 1) throw error;
      }
    }
    throw new GuangyaApiError('请求重试次数已耗尽');
  }

  async listPage(parentId: string, page: number, pageSize = DEFAULT_PAGE_SIZE, options: ApiOperationOptions = {}): Promise<ListData> {
    const response = await this.request<ListData>(
      '/userres/v1/file/get_file_list',
      { parentId, pageSize, orderBy: 3, sortType: 1, page },
      { ...options, lane: 'read', idempotent: true },
    );
    return parseListData(response.data, parentId);
  }

  private async sequentialListing(parentId: string, options: ListChildrenOptions, context: RequestContext): Promise<ListingResult> {
    const pageSize = options.pageSize || DEFAULT_PAGE_SIZE;
    const maxPages = options.maxPages || DEFAULT_MAX_PAGES;
    const deadline = Date.now() + (options.deadlineMs || DEFAULT_LIST_DEADLINE_MS);
    const pages: ListData[] = [];
    const rawIds = new Set<string>();
    let rawCount = 0;
    let expectedTotal: number | undefined;
    let complete = false;
    let reason = '目录分页在安全页数/时间上限内未能完整收敛';
    for (let page = 0; page < maxPages && Date.now() <= deadline; page += 1) {
      if (!context.committed) context.signal?.throwIfAborted();
      const data = await this.listPage(parentId, page, pageSize, { context });
      pages.push(data);
      if (data.page !== undefined && data.page !== page) {
        reason = `目录分页返回了错误页码（期望 ${page}，实际 ${data.page}）`;
        break;
      }
      if (data.list.length > pageSize) {
        reason = '目录分页返回项目数超过请求页大小';
        break;
      }
      if (expectedTotal === undefined) expectedTotal = data.total;
      else if (data.total !== expectedTotal) {
        reason = '顺序分页期间目录 total 发生变化';
        break;
      }
      let duplicateOrInvalidId = false;
      for (const item of data.list) {
        if (!item.fileId || rawIds.has(item.fileId)) {
          duplicateOrInvalidId = true;
          break;
        }
        rawIds.add(item.fileId);
      }
      if (duplicateOrInvalidId) {
        reason = '顺序分页包含重复或无效项目 ID';
        break;
      }
      rawCount += data.list.length;
      if (expectedTotal !== undefined && rawCount > expectedTotal) {
        reason = '顺序分页项目数超过目录 total';
        break;
      }
      const items = stableMerge(pages);
      options.onProgress?.({
        phase: 'scan-page',
        message: `已扫描 ${items.length}/${Math.max(expectedTotal || 0, 1)} 项`,
        current: items.length,
        total: Math.max(expectedTotal || 0, 1),
      });
      if (rawCount === expectedTotal) {
        complete = true;
        reason = '';
        break;
      }
      if (data.list.length === 0) break;
    }
    const items = stableMerge(pages);
    if (complete && (expectedTotal === undefined || items.length !== expectedTotal || rawIds.size !== expectedTotal)) {
      complete = false;
      reason = '目录分页项目数与 total 不一致';
    }
    return {
      items,
      complete,
      observedTotal: expectedTotal ?? 0,
      snapshotStable: false,
      reason: complete ? undefined : reason,
    };
  }

  async listAllChildrenDetailed(parentId: string, options: ListChildrenOptions = {}): Promise<ListingResult> {
    const baseContext = contextFor(options);
    if (baseContext.committed) return this.listAllChildrenDetailedInternal(parentId, options, baseContext);
    const deadlineController = new AbortController();
    let deadlineReached = false;
    const onOperationAbort = () => deadlineController.abort(baseContext.signal?.reason || new DOMException('操作已取消', 'AbortError'));
    if (baseContext.signal?.aborted) onOperationAbort();
    else baseContext.signal?.addEventListener('abort', onOperationAbort, { once: true });
    const timer = setTimeout(() => {
      deadlineReached = true;
      deadlineController.abort(new DOMException('目录读取超过安全时间上限', 'TimeoutError'));
    }, options.deadlineMs || DEFAULT_LIST_DEADLINE_MS);
    const context = createOperationRequestContext(baseContext.mode, {
      operationId: baseContext.operationId,
      signal: deadlineController.signal,
      onSchedulerStatus: baseContext.onSchedulerStatus,
    });
    try {
      return await this.listAllChildrenDetailedInternal(parentId, options, context);
    } catch (error) {
      if (!deadlineReached) throw error;
      return { items: [], complete: false, observedTotal: 0, snapshotStable: false, reason: '目录读取超过安全时间上限' };
    } finally {
      clearTimeout(timer);
      baseContext.signal?.removeEventListener('abort', onOperationAbort);
    }
  }

  private async listAllChildrenDetailedInternal(parentId: string, options: ListChildrenOptions, context: RequestContext): Promise<ListingResult> {
    const purpose = options.purpose || 'preview';
    if (purpose === 'consistency') {
      return this.sequentialListing(parentId, options, context);
    }
    if (purpose === 'verification') {
      const first = await this.sequentialListing(parentId, options, context);
      if (!first.complete) return first;
      const second = await this.sequentialListing(parentId, options, context);
      if (!sameListing(first, second)) {
        return { ...second, complete: false, snapshotStable: false, reason: '连续两次目录列表不一致，无法安全判空' };
      }
      return { ...second, snapshotStable: true };
    }

    const pageSize = options.pageSize || DEFAULT_PAGE_SIZE;
    options.onProgress?.({ phase: 'scan-page', message: '正在读取第 1 页，已扫描 0 项', current: 0, total: 1 });
    const first = await this.listPage(parentId, 0, pageSize, { context });
    const pageCount = Math.max(1, Math.ceil(first.total / pageSize));
    const maxPages = options.maxPages || DEFAULT_MAX_PAGES;
    if (pageCount > maxPages) {
      return { items: first.list, complete: false, observedTotal: first.total, snapshotStable: false, reason: '目录页数超过安全上限' };
    }
    if (pageCount === 1) {
      const items = stableMerge([first]);
      options.onProgress?.({ phase: 'scan-page', message: `已扫描 ${items.length}/${Math.max(first.total, items.length)} 项`, current: items.length, total: Math.max(first.total, items.length, 1) });
      return { items, complete: items.length >= first.total, observedTotal: first.total, snapshotStable: false, reason: items.length >= first.total ? undefined : '首目录页不完整' };
    }

    const pages: ListData[] = Array(pageCount);
    pages[0] = first;
    let cursor = 1;
    let completed = 1;
    const workers = Array.from({ length: Math.min(requestScheduler.getReadConcurrency(context.mode), pageCount - 1) }, async () => {
      while (cursor < pageCount) {
        const page = cursor++;
        pages[page] = await this.listPage(parentId, page, pageSize, { context });
        completed += 1;
        const scanned = pages.filter(Boolean).reduce((sum, entry) => sum + entry.list.length, 0);
        options.onProgress?.({
          phase: 'scan-page',
          message: `并发读取目录页 ${completed}/${pageCount}，已收到 ${scanned} 项`,
          current: completed,
          total: pageCount,
        });
      }
    });
    await Promise.all(workers);
    const totalsStable = pages.every((page) => page.total === first.total);
    const hasUnexpectedEmptyPage = pages.slice(0, -1).some((page) => page.list.length === 0);
    const items = stableMerge(pages);
    if (totalsStable && !hasUnexpectedEmptyPage && items.length >= first.total) {
      options.onProgress?.({ phase: 'scan-page', message: `已扫描 ${items.length}/${Math.max(first.total, items.length)} 项`, current: items.length, total: Math.max(first.total, items.length, 1) });
      return { items, complete: true, observedTotal: first.total, snapshotStable: false };
    }
    return this.sequentialListing(parentId, options, context);
  }

  async listAllChildren(parentId: string, options: ListChildrenOptions = {}): Promise<GuangyaItem[]> {
    const result = await this.listAllChildrenDetailed(parentId, options);
    if (!result.complete) throw new GuangyaApiError(result.reason || '目录列表不完整，已停止操作以避免误删');
    return result.items;
  }

  async walkDescendants(
    parentId: string,
    options: ApiOperationOptions & { onProgress?: (progress: ProgressInfo) => void; purpose?: 'preview' | 'verification' | 'consistency'; deadlineMs?: number } = {},
  ): Promise<WalkResult> {
    const context = contextFor(options);
    const treeDeadlineAt = Date.now() + (options.deadlineMs || 20 * 60_000);
    const queue: Array<{ id: string; order: number }> = [{ id: parentId, order: 0 }];
    const visited = new Set<string>();
    const items: GuangyaItem[] = [];
    const directories: GuangyaItem[] = [];
    const files: GuangyaItem[] = [];
    const itemById = new Map<string, GuangyaItem>();
    const directoryListings = new Map<string, DirectoryListingEvidence>();
    let nextOrder = 1;
    let completedDirectories = 0;
    let complete = true;
    let incompleteReason: string | undefined;
    let active = true;

    while (queue.length > 0 && complete) {
      if (!context.committed) context.signal?.throwIfAborted();
      if (Date.now() >= treeDeadlineAt) {
        complete = false;
        incompleteReason = '递归目录扫描超过安全时间上限';
        break;
      }
      const concurrency = options.purpose === 'verification' ? 1 : requestScheduler.getReadConcurrency(context.mode);
      const wave = queue.splice(0, concurrency).filter((entry) => !visited.has(entry.id));
      wave.forEach((entry) => visited.add(entry.id));
      const discoveredTotal = completedDirectories + wave.length + queue.length;
      options.onProgress?.({
        phase: 'scan',
        message: `正在并发扫描 ${wave.length} 个目录，已完成 ${completedDirectories}/${discoveredTotal}，累计 ${items.length} 项`,
        current: completedDirectories,
        total: Math.max(discoveredTotal, 1),
        discovered: discoveredTotal,
        queued: queue.length,
        inFlight: wave.length,
      });
      const results = await Promise.all(wave.map(async (entry) => ({
        entry,
        listing: await this.listAllChildrenDetailed(entry.id, {
          context,
          purpose: options.purpose,
          deadlineMs: Math.max(1, treeDeadlineAt - Date.now()),
          onProgress: undefined,
        }),
      })));
      results.sort((left, right) => left.entry.order - right.entry.order);
      for (const { entry, listing } of results) {
        completedDirectories += 1;
        directoryListings.set(entry.id, {
          parentId: entry.id,
          observedTotal: listing.observedTotal,
          orderedChildIds: listing.items.map((item) => item.fileId),
          complete: listing.complete,
        });
        if (!listing.complete) {
          complete = false;
          incompleteReason = listing.reason;
          break;
        }
        for (const item of listing.items) {
          if (!item.fileId) continue;
          if (item.parentId !== entry.id) {
            complete = false;
            incompleteReason = `目录树父子关系不一致：${item.fileId}`;
            break;
          }
          if (itemById.has(item.fileId)) {
            complete = false;
            incompleteReason = `目录树出现重复项目 ID：${item.fileId}`;
            break;
          }
          itemById.set(item.fileId, item);
          items.push(item);
          if (item.resType === 2) {
            directories.push(item);
            if (!visited.has(item.fileId)) queue.push({ id: item.fileId, order: nextOrder++ });
          } else files.push(item);
        }
        if (!complete) break;
      }
    }
    active = false;
    if (!active) {
      options.onProgress?.({
        phase: 'scan',
        message: complete ? `扫描完成：${visited.size} 个目录，${items.length} 项` : `扫描未完整：${incompleteReason}`,
        current: completedDirectories,
        total: Math.max(completedDirectories, 1),
        discovered: visited.size + queue.length,
        queued: queue.length,
        inFlight: 0,
      });
    }
    return { items, directories, files, itemById, directoryListings, complete, incompleteReason };
  }

  async walkDescendantsStable(
    parentId: string,
    options: ApiOperationOptions & { onProgress?: (progress: ProgressInfo) => void; deadlineMs?: number } = {},
  ): Promise<WalkResult> {
    const stableDeadlineAt = Date.now() + (options.deadlineMs || 20 * 60_000);
    options.onProgress?.({ phase: 'stable-verify-a', message: '正在进行稳定验证 Pass A', current: 0, total: 2 });
    const first = await this.walkDescendants(parentId, { ...options, deadlineMs: Math.max(1, stableDeadlineAt - Date.now()), purpose: 'consistency' });
    if (first.complete === false || !walkEvidenceFingerprint(first)) return { ...first, stable: false };
    options.onProgress?.({ phase: 'stable-verify-b', message: 'Pass A 完成，正在进行 Pass B', current: 1, total: 2 });
    const second = await this.walkDescendants(parentId, { ...options, deadlineMs: Math.max(1, stableDeadlineAt - Date.now()), purpose: 'consistency' });
    const stable = second.complete !== false && walkEvidenceFingerprint(first) === walkEvidenceFingerprint(second);
    options.onProgress?.({ phase: 'stable-verify-b', message: stable ? '双 Pass 稳定验证完成' : '双 Pass 结果不一致', current: 2, total: 2 });
    return stable
      ? { ...second, stable: true }
      : { ...second, complete: false, stable: false, incompleteReason: '连续两个完整 tree pass 不一致，无法安全删除目录' };
  }

  async renameItem(fileId: string, newName: string, options: ApiOperationOptions = {}): Promise<void> {
    if (!fileId) throw new GuangyaApiError('重命名缺少文件 ID', undefined, undefined, { outcome: 'definite-rejection' });
    await this.request<unknown>('/userres/v1/file/rename', { fileId, newName }, { ...options, lane: 'write', mutation: true });
  }

  async moveItems(fileIds: string[], parentId: string, options: ApiOperationOptions = {}): Promise<string> {
    if (fileIds.length === 0) return '';
    if (fileIds.length > REQUEST_SAFETY_LIMITS.maxMutationBatch) throw new GuangyaApiError('移动请求单批最多 50 项', undefined, undefined, { outcome: 'definite-rejection' });
    const response = await this.request<TaskData>('/userres/v1/file/move_file', { fileIds, parentId }, { ...options, lane: 'write', mutation: true });
    const taskId = String(response.data?.taskId || '');
    if (!taskId) {
      requestScheduler.penalize(2_000, '移动结果未知，已关闭快速提交并进入共享退避');
      throw new GuangyaApiError('移动接口未返回任务 ID，操作结果未知，请刷新确认', undefined, undefined, { outcome: 'outcome-unknown' });
    }
    return taskId;
  }

  async trashItems(fileIds: string[], options: ApiOperationOptions = {}): Promise<string> {
    if (fileIds.length === 0) return '';
    if (fileIds.length > REQUEST_SAFETY_LIMITS.maxMutationBatch) throw new GuangyaApiError('回收请求单批最多 50 项', undefined, undefined, { outcome: 'definite-rejection' });
    const response = await this.request<TaskData>('/userres/v1/file/delete_file', { fileIds }, { ...options, lane: 'write', mutation: true });
    const taskId = String(response.data?.taskId || '');
    if (!taskId) {
      requestScheduler.penalize(2_000, '回收结果未知，已关闭快速提交并进入共享退避');
      throw new GuangyaApiError('删除接口未返回任务 ID，操作结果未知，请刷新确认', undefined, undefined, { outcome: 'outcome-unknown' });
    }
    return taskId;
  }

  async waitTask(taskId: string, options: { pollMs?: number; timeoutMs?: number; context?: RequestContext } = {}): Promise<void> {
    if (!taskId) return;
    const context = contextFor({ context: options.context }, true);
    const initialPollMs = options.pollMs || requestScheduler.getInitialPollMs(context.mode);
    const timeoutMs = options.timeoutMs || REQUEST_SAFETY_LIMITS.committedTaskTimeoutMs;
    const startedAt = Date.now();
    let pollMs = initialPollMs;

    while (Date.now() - startedAt < timeoutMs) {
      const beforePollRemainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
      await delay(Math.min(pollMs, beforePollRemainingMs));
      try {
        const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
        const response = await this.request<TaskStatusData>('/userres/v1/get_task_status', { taskId }, {
          context,
          lane: 'poll',
          idempotent: true,
          transportTimeoutMs: Math.min(POLL_TRANSPORT_TIMEOUT_MS, remainingMs),
          deadlineAt: startedAt + timeoutMs,
        });
        const status = Number(response.data?.status);
        const detailCode = Number(response.data?.detail?.code || 0);
        if ([2, 3].includes(status) && detailCode !== 0) {
          throw new GuangyaApiError(response.data?.detail?.msg || '任务失败', detailCode, undefined, { outcome: 'task-failed' });
        }
        if (status === 2) return;
        if (status === 3) throw new GuangyaApiError(response.data?.detail?.msg || '任务失败', undefined, undefined, { outcome: 'task-failed' });
      } catch (error) {
        if (error instanceof GuangyaApiError && error.outcome === 'task-failed') throw error;
        if (error instanceof GuangyaApiError && error.status && [401, 403].includes(error.status)) {
          requestScheduler.penalize(2_000, '任务轮询鉴权失效，已降低请求速度');
          throw new GuangyaApiError(`${error.message}；任务结果未知`, error.code, error.status, { outcome: 'task-unknown' });
        }
        // 临时轮询失败由共享退避控制，继续到专属任务截止时间。
      }
      pollMs = Math.min(5_000, Math.round(pollMs * 1.45));
    }
    requestScheduler.penalize(2_000, '任务结果未知，已关闭快速提交并进入共享退避');
    throw new GuangyaApiError('等待任务完成超时，任务结果未知，请刷新确认', undefined, undefined, { outcome: 'task-unknown' });
  }
}
