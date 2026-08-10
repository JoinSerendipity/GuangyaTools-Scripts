import type { RequestSpeedMode } from './requestSpeedSettings';

export type SchedulerActivityState = 'idle' | 'running' | 'throttled' | 'backoff';

export interface RequestSchedulerStatus {
  state: SchedulerActivityState;
  message: string;
  retryAt?: number;
  active: number;
  queued: number;
  effectiveLevel?: 'conservative' | 'balanced' | 'fast';
  readConcurrency?: number;
  acceptedTaskWindow?: number;
  latencyEwmaMs?: number;
}

export interface OperationRequestContext {
  readonly operationId: string;
  readonly mode: RequestSpeedMode;
  readonly signal?: AbortSignal;
  readonly committed: false;
  readonly onSchedulerStatus?: (status: RequestSchedulerStatus) => void;
}

export interface CommittedRequestContext {
  readonly operationId: string;
  readonly mode: RequestSpeedMode;
  readonly committed: true;
  readonly onSchedulerStatus?: (status: RequestSchedulerStatus) => void;
}

export type RequestContext = OperationRequestContext | CommittedRequestContext;

let operationSequence = 0;

export function createOperationRequestContext(
  mode: RequestSpeedMode,
  options: { signal?: AbortSignal; onSchedulerStatus?: (status: RequestSchedulerStatus) => void; operationId?: string } = {},
): OperationRequestContext {
  return Object.freeze({
    operationId: options.operationId || `operation-${Date.now()}-${operationSequence++}`,
    mode,
    signal: options.signal,
    committed: false as const,
    onSchedulerStatus: options.onSchedulerStatus,
  });
}

export function createCommittedRequestContext(context: RequestContext): CommittedRequestContext {
  return Object.freeze({
    operationId: context.operationId,
    mode: context.mode,
    committed: true as const,
    onSchedulerStatus: context.onSchedulerStatus,
  });
}

export function throwIfOperationAborted(context?: RequestContext): void {
  if (context && !context.committed) context.signal?.throwIfAborted();
}
