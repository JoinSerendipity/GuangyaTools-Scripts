import type { ProgressInfo } from '../types';

export class ProgressTracker {
  private active = true;
  private maximumRatio = 0;

  constructor(private readonly listener: (progress: ProgressInfo) => void) {}

  reset(): void {
    this.active = true;
    this.maximumRatio = 0;
  }

  update(progress: ProgressInfo): void {
    if (!this.active) return;
    const total = Math.max(progress.total, 1);
    const rawRatio = Math.min(1, Math.max(0, progress.current / total));
    this.maximumRatio = Math.max(this.maximumRatio, Math.min(0.99, rawRatio));
    this.listener({
      ...progress,
      current: this.maximumRatio * total,
      total,
    });
  }

  finish(progress: Omit<ProgressInfo, 'current' | 'total'> & Partial<Pick<ProgressInfo, 'current' | 'total'>>): void {
    if (!this.active) return;
    this.maximumRatio = 1;
    const total = Math.max(progress.total || progress.current || 1, 1);
    this.listener({ ...progress, current: total, total });
    this.active = false;
  }

  stop(): void {
    this.active = false;
  }
}
