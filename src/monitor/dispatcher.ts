// ALERT DISPATCHER: delivers alerts from the database outbox to Telegram.
//
// Delivery is AT MOST ONCE: an alert is marked `sending` before the send. If the app stops in the
// middle, the alert becomes `uncertain` on restart and is NOT sent again (no duplicate alerts).
// Temporary errors are retried with backoff; alerts that waited too long expire, because an old
// "critical" message could mislead (e.g. after a free host slept).
import type { AlertRow, Store } from '../db/Store.js';

export interface AlertSender {
  send(chatId: string, text: string): Promise<void>;
}

/** Errors that will never succeed (user blocked the bot, chat not found). */
export class PermanentSendError extends Error {
  constructor(message: string, readonly userBlocked = false) {
    super(message);
  }
}

/** Telegram asks us to wait (HTTP 429). */
export class RetryAfterError extends Error {
  constructor(message: string, readonly retryAfterMs: number) {
    super(message);
  }
}

export interface DispatcherOptions {
  store: Store;
  sender: AlertSender;
  now?: () => number;
  maxAttempts?: number;
  /** Pending alerts older than this are not sent (marked failed: expired). */
  maxAgeMs?: number;
  batchSize?: number;
}

export interface FlushReport {
  sent: number;
  retried: number;
  failed: number;
  expired: number;
}

export class AlertDispatcher {
  private readonly now: () => number;
  private flushing = false;

  constructor(private readonly opts: DispatcherOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Call once at startup, before the first flush. */
  async recover(): Promise<number> {
    return this.opts.store.recoverInterruptedSends(this.now());
  }

  async flush(): Promise<FlushReport> {
    const report: FlushReport = { sent: 0, retried: 0, failed: 0, expired: 0 };
    if (this.flushing) return report;
    this.flushing = true;
    try {
      const { store, sender } = this.opts;
      const due = await store.claimDueAlerts(this.now(), this.opts.batchSize ?? 25);
      for (const alert of due) {
        const now = this.now();
        const age = now - alert.createdAt;
        if (age > (this.opts.maxAgeMs ?? 30 * 60_000)) {
          await store.markAlertFailed(alert.id, `expired: not sent after ${Math.round(age / 60_000)} min`, null);
          await this.audit(alert, 'suppress', 'expired: too old to be useful');
          report.expired++;
          continue;
        }
        try {
          await sender.send(alert.chatId, withDelayNote(alert, now));
          await store.markAlertSent(alert.id, this.now());
          report.sent++;
        } catch (err) {
          const message = err instanceof Error ? err.message.slice(0, 200) : 'send failed';
          if (err instanceof PermanentSendError || alert.attempts >= (this.opts.maxAttempts ?? 5)) {
            await store.markAlertFailed(alert.id, message, null);
            if (err instanceof PermanentSendError && err.userBlocked) await store.setUserActive(alert.userId, false);
            report.failed++;
          } else {
            const backoff = err instanceof RetryAfterError ? err.retryAfterMs : Math.min(60_000, 2_000 * 2 ** (alert.attempts - 1));
            await store.markAlertFailed(alert.id, message, now + backoff);
            report.retried++;
          }
        }
      }
      return report;
    } finally {
      this.flushing = false;
    }
  }

  private audit(alert: AlertRow, decision: 'emit' | 'suppress', reason: string) {
    return this.opts.store.appendAudit([
      { at: this.now(), eventId: alert.id, kind: alert.kind, decision, reason, userId: alert.userId, network: alert.network, address: alert.address },
    ]);
  }
}

/** Be honest when an alert is delivered late. */
function withDelayNote(alert: AlertRow, now: number): string {
  const delayMin = Math.floor((now - alert.createdAt) / 60_000);
  if (delayMin < 2) return alert.message;
  return `${alert.message}\n(Detected ${delayMin} min ago, at ${new Date(alert.createdAt).toISOString().slice(11, 16)} UTC. Check /status for the latest value.)`;
}
