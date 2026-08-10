import type { RequestContext, RequestSchedulerStatus } from './requestContext';
import { REQUEST_SAFETY_LIMITS } from './requestSafetyLimits';
import { REQUEST_SPEED_PROFILES, type RequestSpeedMode, type RequestSpeedProfile } from './requestSpeedSettings';

export type RequestLane = 'read' | 'write' | 'poll';
type EffectiveLevel = 'conservative' | 'balanced' | 'fast';

type QueueItem = {
  id: number;
  lane: RequestLane;
  context: RequestContext;
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  abortCleanup?: () => void;
};

export interface RequestSchedulerOptions {
  now?: () => number;
  random?: () => number;
  maxRead?: number;
  maxWrite?: number;
  maxPoll?: number;
  maxTotal?: number;
}

const LANE_ORDER: readonly RequestLane[] = ['poll', 'write', 'read'];
const LEVEL_MODES: readonly EffectiveLevel[] = ['conservative', 'balanced', 'fast'];

function abortError(signal?: AbortSignal): unknown {
  return signal?.reason || new DOMException('操作已取消', 'AbortError');
}

function clampPositiveLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || (value as number) <= 0) return fallback;
  return Math.max(1, Math.min(value as number, maximum));
}

export class RequestScheduler {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly limits: Record<RequestLane, number>;
  private readonly maxTotal: number;
  private readonly queues: Record<RequestLane, QueueItem[]> = { read: [], write: [], poll: [] };
  private readonly active: Record<RequestLane, number> = { read: 0, write: 0, poll: 0 };
  private readonly laneNextStartAt: Record<RequestLane, number> = { read: 0, write: 0, poll: 0 };
  private readonly listeners = new Set<(status: RequestSchedulerStatus) => void>();
  private sequence = 0;
  private lastLaneIndex = -1;
  private globalNextStartAt = 0;
  private penaltyUntil = 0;
  private penaltyMultiplier = 1;
  private autoLevelIndex = 1;
  private adaptiveReadCeiling: number;
  private acceptedTaskCeiling: number = REQUEST_SAFETY_LIMITS.maxAcceptedMoveTasks;
  private successfulRequests = 0;
  private latencyEwmaMs = 0;
  private pumpTimer: ReturnType<typeof setTimeout> | undefined;
  private latestStatus: RequestSchedulerStatus = { state: 'idle', message: '请求调度器空闲', active: 0, queued: 0 };

  constructor(options: RequestSchedulerOptions = {}) {
    this.now = options.now || (() => Date.now());
    this.random = options.random || Math.random;
    this.limits = {
      read: clampPositiveLimit(options.maxRead, REQUEST_SAFETY_LIMITS.maxReadFetch, REQUEST_SAFETY_LIMITS.maxReadFetch),
      write: clampPositiveLimit(options.maxWrite, REQUEST_SAFETY_LIMITS.maxWriteFetch, REQUEST_SAFETY_LIMITS.maxWriteFetch),
      poll: clampPositiveLimit(options.maxPoll, REQUEST_SAFETY_LIMITS.maxPollFetch, REQUEST_SAFETY_LIMITS.maxPollFetch),
    };
    this.maxTotal = clampPositiveLimit(options.maxTotal, REQUEST_SAFETY_LIMITS.maxTotalFetch, REQUEST_SAFETY_LIMITS.maxTotalFetch);
    this.adaptiveReadCeiling = this.limits.read;
  }

  schedule<T>(lane: RequestLane, context: RequestContext, task: () => Promise<T>): Promise<T> {
    if (!context.committed && context.signal?.aborted) return Promise.reject(abortError(context.signal));
    return new Promise<T>((resolve, reject) => {
      const item: QueueItem = { id: this.sequence++, lane, context, task, resolve: (value) => resolve(value as T), reject };
      if (!context.committed && context.signal) {
        const onAbort = () => {
          if (!this.removeQueued(item)) return;
          reject(abortError(context.signal));
          this.emitCurrentState();
          this.pump();
        };
        context.signal.addEventListener('abort', onAbort, { once: true });
        item.abortCleanup = () => context.signal?.removeEventListener('abort', onAbort);
      }
      this.queues[lane].push(item);
      this.emit('throttled', '请求已进入安全调度队列');
      this.pump();
    });
  }

  getEffectiveLevel(mode: RequestSpeedMode): EffectiveLevel {
    return mode === 'auto' ? LEVEL_MODES[this.autoLevelIndex] : mode;
  }

  getEffectiveProfile(mode: RequestSpeedMode): RequestSpeedProfile {
    return REQUEST_SPEED_PROFILES[this.getEffectiveLevel(mode)];
  }

  getReadConcurrency(mode: RequestSpeedMode): number {
    return Math.max(1, Math.min(this.limits.read, this.adaptiveReadCeiling, this.getEffectiveProfile(mode).readConcurrency));
  }

  getAcceptedTaskWindow(mode: RequestSpeedMode): number {
    return Math.max(1, Math.min(
      REQUEST_SAFETY_LIMITS.maxAcceptedMoveTasks,
      this.acceptedTaskCeiling,
      this.getEffectiveProfile(mode).acceptedTaskWindow,
    ));
  }

  getInitialPollMs(mode: RequestSpeedMode): number {
    return this.getEffectiveProfile(mode).initialPollMs;
  }

  penalize(waitMs: number, message = '请求过于频繁，正在退避'): void {
    const bounded = Math.min(120_000, Math.max(500, Number.isFinite(waitMs) ? waitMs : 1_000));
    this.penaltyUntil = Math.max(this.penaltyUntil, this.now() + bounded);
    this.penaltyMultiplier = Math.min(8, this.penaltyMultiplier * 2);
    this.autoLevelIndex = 0;
    this.adaptiveReadCeiling = 1;
    this.acceptedTaskCeiling = 1;
    this.successfulRequests = 0;
    this.emit('backoff', message, this.penaltyUntil);
    this.schedulePump(this.penaltyUntil - this.now());
  }

  subscribe(listener: (status: RequestSchedulerStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.latestStatus);
    return () => this.listeners.delete(listener);
  }

  getStatus(): RequestSchedulerStatus { return { ...this.latestStatus }; }

  resetForTests(): void {
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.pumpTimer = undefined;
    for (const lane of LANE_ORDER) {
      for (const item of this.queues[lane]) { item.abortCleanup?.(); item.reject(new DOMException('调度器已重置', 'AbortError')); }
      this.queues[lane] = [];
      this.active[lane] = 0;
      this.laneNextStartAt[lane] = 0;
    }
    this.globalNextStartAt = 0;
    this.penaltyUntil = 0;
    this.penaltyMultiplier = 1;
    this.autoLevelIndex = 1;
    this.adaptiveReadCeiling = this.limits.read;
    this.acceptedTaskCeiling = REQUEST_SAFETY_LIMITS.maxAcceptedMoveTasks;
    this.successfulRequests = 0;
    this.latencyEwmaMs = 0;
    this.emit('idle', '请求调度器空闲');
  }

  private queueLength(): number { return this.queues.read.length + this.queues.write.length + this.queues.poll.length; }
  private activeCount(): number { return this.active.read + this.active.write + this.active.poll; }

  private statusDetails(): Pick<RequestSchedulerStatus, 'effectiveLevel' | 'readConcurrency' | 'acceptedTaskWindow' | 'latencyEwmaMs'> {
    return {
      effectiveLevel: LEVEL_MODES[this.autoLevelIndex],
      readConcurrency: this.getReadConcurrency('auto'),
      acceptedTaskWindow: this.getAcceptedTaskWindow('auto'),
      latencyEwmaMs: this.latencyEwmaMs ? Math.round(this.latencyEwmaMs) : undefined,
    };
  }

  private emit(state: RequestSchedulerStatus['state'], message: string, retryAt?: number, context?: RequestContext): void {
    const status: RequestSchedulerStatus = { state, message, retryAt, active: this.activeCount(), queued: this.queueLength(), ...this.statusDetails() };
    this.latestStatus = status;
    for (const listener of this.listeners) listener(status);
    context?.onSchedulerStatus?.(status);
  }

  private emitCurrentState(): void {
    if (this.activeCount() === 0 && this.queueLength() === 0) this.emit('idle', '请求调度器空闲');
    else if (this.penaltyUntil > this.now()) this.emit('backoff', '请求频率保护中', this.penaltyUntil);
    else if (this.queueLength() > 0) this.emit('throttled', '请求正在安全排队');
    else this.emit('running', '请求处理中');
  }

  private removeQueued(target: QueueItem): boolean {
    const queue = this.queues[target.lane];
    const index = queue.indexOf(target);
    if (index < 0) return false;
    queue.splice(index, 1);
    target.abortCleanup?.();
    return true;
  }

  private intervalFor(item: QueueItem): number {
    const profile = this.getEffectiveProfile(item.context.mode);
    const configured = item.lane === 'write' ? profile.mutationStartIntervalMs : item.lane === 'poll' ? profile.pollStartIntervalMs : profile.readStartIntervalMs;
    const minimum = item.lane === 'write' ? REQUEST_SAFETY_LIMITS.minWriteStartIntervalMs : item.lane === 'poll' ? REQUEST_SAFETY_LIMITS.minPollStartIntervalMs : REQUEST_SAFETY_LIMITS.minReadStartIntervalMs;
    const base = Math.max(minimum, configured);
    return Math.round((base + base * 0.12 * Math.max(0, Math.min(1, this.random()))) * this.penaltyMultiplier);
  }

  private isLaneCapacityEligible(lane: RequestLane): boolean {
    if (this.queues[lane].length === 0 || this.active[lane] >= this.limits[lane]) return false;
    const total = this.activeCount();
    if (total >= this.maxTotal) return false;
    if (lane !== 'poll' && this.queues.poll.length > 0 && total >= this.maxTotal - 1) return false;
    if (lane === 'read') {
      const first = this.queues.read[0];
      if (first && this.active.read >= this.getReadConcurrency(first.context.mode)) return false;
    }
    return true;
  }

  private pickNext(now: number): QueueItem | undefined {
    for (let offset = 1; offset <= LANE_ORDER.length; offset += 1) {
      const index = (this.lastLaneIndex + offset) % LANE_ORDER.length;
      const lane = LANE_ORDER[index];
      if (!this.isLaneCapacityEligible(lane) || this.laneNextStartAt[lane] > now) continue;
      this.lastLaneIndex = index;
      return this.queues[lane].shift();
    }
    return undefined;
  }

  private earliestPacedLaneTime(): number | undefined {
    const values = LANE_ORDER.filter((lane) => this.isLaneCapacityEligible(lane)).map((lane) => this.laneNextStartAt[lane]);
    return values.length ? Math.min(...values) : undefined;
  }

  private pump(): void {
    if (this.pumpTimer) { clearTimeout(this.pumpTimer); this.pumpTimer = undefined; }
    if (this.queueLength() === 0) { this.emitCurrentState(); return; }
    const now = this.now();
    const accountWaitUntil = Math.max(this.globalNextStartAt, this.penaltyUntil);
    if (accountWaitUntil > now) {
      const state = this.penaltyUntil > now ? 'backoff' : 'throttled';
      this.emit(state, state === 'backoff' ? '请求频率保护中' : '正在平滑全局请求间隔', accountWaitUntil);
      this.schedulePump(accountWaitUntil - now);
      return;
    }
    const item = this.pickNext(now);
    if (!item) {
      const pacedAt = this.earliestPacedLaneTime();
      if (pacedAt !== undefined && pacedAt > now) {
        this.emit('throttled', '等待对应请求通道安全间隔', pacedAt);
        this.schedulePump(pacedAt - now);
      } else this.emitCurrentState();
      return;
    }
    item.abortCleanup?.();
    if (!item.context.committed && item.context.signal?.aborted) { item.reject(abortError(item.context.signal)); this.pump(); return; }
    this.active[item.lane] += 1;
    this.globalNextStartAt = now + REQUEST_SAFETY_LIMITS.minGlobalStartIntervalMs;
    this.laneNextStartAt[item.lane] = now + this.intervalFor(item);
    const startedAt = now;
    this.emit('running', `${item.lane === 'read' ? '读取' : item.lane === 'write' ? '写入' : '任务轮询'}请求处理中`, undefined, item.context);
    void item.task().then(
      (value) => { this.recordSuccess(this.now() - startedAt); item.resolve(value); },
      (error) => item.reject(error),
    ).finally(() => { this.active[item.lane] -= 1; this.emitCurrentState(); this.pump(); });
    if (this.queueLength() > 0) this.schedulePump(REQUEST_SAFETY_LIMITS.minGlobalStartIntervalMs);
  }

  private recordSuccess(durationMs: number): void {
    this.latencyEwmaMs = this.latencyEwmaMs === 0 ? durationMs : this.latencyEwmaMs * 0.8 + durationMs * 0.2;
    if (this.penaltyUntil > this.now()) return;
    if (this.latencyEwmaMs > 4_000) {
      this.autoLevelIndex = Math.max(0, this.autoLevelIndex - 1);
      const reducedProfile = REQUEST_SPEED_PROFILES[LEVEL_MODES[this.autoLevelIndex]];
      this.adaptiveReadCeiling = Math.min(this.adaptiveReadCeiling, reducedProfile.readConcurrency);
      this.acceptedTaskCeiling = Math.min(this.acceptedTaskCeiling, reducedProfile.acceptedTaskWindow);
      this.successfulRequests = 0;
      return;
    }
    this.successfulRequests += 1;
    if (this.successfulRequests < 10) return;
    this.successfulRequests = 0;
    this.penaltyMultiplier = Math.max(1, this.penaltyMultiplier / 2);
    if (this.latencyEwmaMs <= 2_000) this.autoLevelIndex = Math.min(2, this.autoLevelIndex + 1);
    const recoveredProfile = REQUEST_SPEED_PROFILES[LEVEL_MODES[this.autoLevelIndex]];
    this.adaptiveReadCeiling = Math.min(this.limits.read, recoveredProfile.readConcurrency);
    this.acceptedTaskCeiling = Math.min(REQUEST_SAFETY_LIMITS.maxAcceptedMoveTasks, recoveredProfile.acceptedTaskWindow);
  }

  private schedulePump(ms: number): void {
    if (this.pumpTimer) return;
    this.pumpTimer = setTimeout(() => { this.pumpTimer = undefined; this.pump(); }, Math.max(0, ms));
  }
}

export const requestScheduler = new RequestScheduler();
