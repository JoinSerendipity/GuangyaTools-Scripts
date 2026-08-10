import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCommittedRequestContext, createOperationRequestContext } from './requestContext';
import { RequestScheduler } from './requestScheduler';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RequestScheduler', () => {
  it('enforces global request-start spacing and read concurrency across contexts', async () => {
    const scheduler = new RequestScheduler({ random: () => 0 });
    const first = deferred<void>();
    const second = deferred<void>();
    const starts: number[] = [];
    const a = scheduler.schedule('read', createOperationRequestContext('fast'), async () => { starts.push(Date.now()); return first.promise; });
    const b = scheduler.schedule('read', createOperationRequestContext('fast'), async () => { starts.push(Date.now()); return second.promise; });
    expect(starts).toEqual([0]);
    await vi.advanceTimersByTimeAsync(149);
    expect(starts).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toEqual([0, 150]);
    first.resolve(); second.resolve();
    await Promise.all([a, b]);
  });

  it('uses per-lane pacing without allowing a long poll interval to block an eligible write', async () => {
    const scheduler = new RequestScheduler({ random: () => 0 });
    const starts: Array<[string, number]> = [];
    const context = createOperationRequestContext('conservative');
    const poll = scheduler.schedule('poll', createCommittedRequestContext(context), async () => { starts.push(['poll', Date.now()]); });
    const write = scheduler.schedule('write', context, async () => { starts.push(['write', Date.now()]); });
    await vi.advanceTimersByTimeAsync(120);
    await Promise.all([poll, write]);
    expect(starts).toEqual([['poll', 0], ['write', 120]]);
  });

  it('promotes healthy automatic traffic and immediately demotes on penalty', async () => {
    const scheduler = new RequestScheduler({ random: () => 0 });
    const context = createOperationRequestContext('auto');
    const requests = Array.from({ length: 10 }, () => scheduler.schedule('read', context, async () => undefined));
    await vi.runAllTimersAsync();
    await Promise.all(requests);
    expect(scheduler.getStatus()).toMatchObject({ effectiveLevel: 'fast', readConcurrency: 4, acceptedTaskWindow: 3 });
    const slow = scheduler.schedule('read', context, async () => { await new Promise((resolve) => setTimeout(resolve, 5_000)); });
    await vi.runAllTimersAsync();
    await slow;
    expect(scheduler.getStatus().effectiveLevel).toBe('balanced');
    scheduler.penalize(1_000, '429');
    expect(scheduler.getStatus()).toMatchObject({ effectiveLevel: 'conservative', readConcurrency: 1, acceptedTaskWindow: 1 });
  });

  it('forces fixed balanced and fast task windows to one during shared penalty recovery', () => {
    const scheduler = new RequestScheduler({ random: () => 0 });
    expect(scheduler.getAcceptedTaskWindow('balanced')).toBe(2);
    expect(scheduler.getAcceptedTaskWindow('fast')).toBe(3);
    scheduler.penalize(1_000, '429');
    expect(scheduler.getAcceptedTaskWindow('balanced')).toBe(1);
    expect(scheduler.getAcceptedTaskWindow('fast')).toBe(1);
  });

  it('clamps malformed constructor limits back to safe positive defaults', async () => {
    const scheduler = new RequestScheduler({ random: () => 0, maxRead: -2, maxWrite: 99, maxPoll: 0, maxTotal: Number.NaN });
    const result = scheduler.schedule('read', createOperationRequestContext('fast'), async () => 'ok');
    await expect(result).resolves.toBe('ok');
    expect(scheduler.getReadConcurrency('fast')).toBe(4);
  });

  it('keeps writes single-concurrency even when their start interval has elapsed', async () => {
    const scheduler = new RequestScheduler({ random: () => 0 });
    const first = deferred<void>();
    let active = 0;
    let peak = 0;
    const context = createOperationRequestContext('fast');
    const a = scheduler.schedule('write', context, async () => { active += 1; peak = Math.max(peak, active); await first.promise; active -= 1; });
    const b = scheduler.schedule('write', context, async () => { active += 1; peak = Math.max(peak, active); active -= 1; });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(peak).toBe(1);
    first.resolve();
    await vi.runAllTimersAsync();
    await Promise.all([a, b]);
    expect(peak).toBe(1);
  });

  it('cancels queued unsubmitted work and cleans it out of the queue', async () => {
    const scheduler = new RequestScheduler({ random: () => 0 });
    const blocker = deferred<void>();
    const first = scheduler.schedule('write', createOperationRequestContext('fast'), () => blocker.promise);
    const controller = new AbortController();
    let called = false;
    const queued = scheduler.schedule('write', createOperationRequestContext('fast', { signal: controller.signal }), async () => { called = true; });
    controller.abort(new DOMException('cancel', 'AbortError'));
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(called).toBe(false);
    blocker.resolve();
    await first;
  });

  it('does not starve committed polling behind queued scans', async () => {
    const scheduler = new RequestScheduler({ random: () => 0 });
    const blocker = deferred<void>();
    const order: string[] = [];
    const context = createOperationRequestContext('fast');
    const readOne = scheduler.schedule('read', context, async () => { order.push('read-1'); await blocker.promise; });
    const readTwo = scheduler.schedule('read', context, async () => { order.push('read-2'); });
    const poll = scheduler.schedule('poll', createCommittedRequestContext(context), async () => { order.push('poll'); });
    await vi.advanceTimersByTimeAsync(150);
    expect(order).toEqual(['read-1', 'poll']);
    blocker.resolve();
    await vi.runAllTimersAsync();
    await Promise.all([readOne, readTwo, poll]);
    expect(order.indexOf('poll')).toBeLessThan(order.indexOf('read-2'));
  });

  it('releases active slots when a fetch rejects', async () => {
    const scheduler = new RequestScheduler({ random: () => 0, maxRead: 1 });
    const context = createOperationRequestContext('fast');
    const failed = scheduler.schedule('read', context, async () => { throw new Error('boom'); });
    const next = scheduler.schedule('read', context, async () => 'ok');
    await expect(failed).rejects.toThrow('boom');
    await vi.runAllTimersAsync();
    await expect(next).resolves.toBe('ok');
  });

  it('cancels a request waiting in shared backoff without starting fetch', async () => {
    const scheduler = new RequestScheduler({ random: () => 0 });
    scheduler.penalize(5_000);
    const controller = new AbortController();
    let called = false;
    const queued = scheduler.schedule('read', createOperationRequestContext('fast', { signal: controller.signal }), async () => { called = true; });
    controller.abort(new DOMException('cancel', 'AbortError'));
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(called).toBe(false);
  });

  it('uses a shared penalty and delays new work until retry time', async () => {
    const scheduler = new RequestScheduler({ random: () => 0 });
    scheduler.penalize(2_000, '429');
    let started = false;
    const result = scheduler.schedule('read', createOperationRequestContext('fast'), async () => { started = true; return 1; });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe(1);
  });

  it('allows committed polling to continue without an operation signal', async () => {
    const scheduler = new RequestScheduler({ random: () => 0 });
    const controller = new AbortController();
    const operation = createOperationRequestContext('balanced', { signal: controller.signal });
    const committed = createCommittedRequestContext(operation);
    controller.abort();
    const result = scheduler.schedule('poll', committed, async () => 'terminal');
    await expect(result).resolves.toBe('terminal');
  });

  it('emits scheduler state and supports listener cleanup', async () => {
    const scheduler = new RequestScheduler({ random: () => 0 });
    const states: string[] = [];
    const unsubscribe = scheduler.subscribe((status) => states.push(status.state));
    await scheduler.schedule('read', createOperationRequestContext('fast'), async () => undefined);
    unsubscribe();
    const before = states.length;
    scheduler.penalize(1_000);
    expect(states.length).toBe(before);
    expect(states).toContain('running');
  });
});
