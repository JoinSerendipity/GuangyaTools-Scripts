export const REQUEST_SAFETY_LIMITS = Object.freeze({
  maxReadFetch: 4,
  maxWriteFetch: 1,
  maxPollFetch: 1,
  maxTotalFetch: 5,
  maxAcceptedMoveTasks: 3,
  maxMutationBatch: 50,
  minGlobalStartIntervalMs: 120,
  minReadStartIntervalMs: 150,
  minWriteStartIntervalMs: 350,
  minPollStartIntervalMs: 350,
  pollTransportTimeoutMs: 20_000,
  committedTaskTimeoutMs: 5 * 60_000,
} as const);

export function clampMutationBatchSize(size: number | undefined): number {
  const requested = size ?? REQUEST_SAFETY_LIMITS.maxMutationBatch;
  if (!Number.isInteger(requested) || requested <= 0) throw new Error('批次大小必须是正整数');
  return Math.min(requested, REQUEST_SAFETY_LIMITS.maxMutationBatch);
}
