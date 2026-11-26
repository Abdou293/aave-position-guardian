// Simple per-network rate limiter: tasks start at least `minIntervalMs` apart.
// One instance per network keeps us inside each free RPC's request limits.
import { defaultSleep } from './retry.js';

export interface RateLimiterOptions {
  minIntervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class RateLimiter {
  private nextSlot = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: RateLimiterOptions) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** Runs `task` once its time slot arrives. Slots are reserved in call order. */
  async schedule<T>(task: () => Promise<T>): Promise<T> {
    const now = this.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.opts.minIntervalMs;
    const wait = slot - now;
    if (wait > 0) await this.sleep(wait);
    return task();
  }
}
