import { describe, expect, it } from 'vitest';
import type { ProgressInfo } from '../types';
import { ProgressTracker } from './progressTracker';

describe('ProgressTracker', () => {
  it('keeps displayed progress monotonic when totals grow and callbacks finish out of order', () => {
    const ratios: number[] = [];
    const tracker = new ProgressTracker((entry) => ratios.push(entry.current / entry.total));
    tracker.update({ phase: 'scan', message: 'first', current: 5, total: 10 });
    tracker.update({ phase: 'scan', message: 'discovered more', current: 6, total: 20 });
    tracker.update({ phase: 'scan', message: 'late worker', current: 4, total: 20 });
    expect(ratios).toEqual([0.5, 0.5, 0.5]);
  });

  it('emits one terminal completion and suppresses late callbacks', () => {
    const entries: ProgressInfo[] = [];
    const tracker = new ProgressTracker((entry) => entries.push(entry));
    tracker.update({ phase: 'scan', message: 'running', current: 1, total: 4 });
    tracker.finish({ phase: 'scan', message: 'done', total: 4 });
    tracker.update({ phase: 'scan', message: 'late', current: 3, total: 4 });
    expect(entries.map((entry) => entry.message)).toEqual(['running', 'done']);
    expect(entries.at(-1)?.current).toBe(entries.at(-1)?.total);
  });

  it('can reset for another operation after cancellation', () => {
    const messages: string[] = [];
    const tracker = new ProgressTracker((entry) => messages.push(entry.message));
    tracker.stop();
    tracker.update({ phase: 'scan', message: 'ignored', current: 1, total: 1 });
    tracker.reset();
    tracker.update({ phase: 'scan', message: 'next', current: 0, total: 1 });
    expect(messages).toEqual(['next']);
  });
});
