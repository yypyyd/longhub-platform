import type { BillingOutboxRecord, CloudStore } from "./store.js";

export interface BillingPublishedEvent {
  outbox_id: string;
  event_type: BillingOutboxRecord["event_type"];
  aggregate_id: string;
  settlement_id: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface BillingEventPublisher {
  publish(event: BillingPublishedEvent): Promise<void>;
}

export interface BillingOutboxWorkerOptions {
  store: CloudStore;
  publisher: BillingEventPublisher;
  batch_size?: number;
  lease_ms?: number;
  max_attempts?: number;
  retry_base_ms?: number;
  retry_max_ms?: number;
  now?: () => Date;
}

export interface BillingOutboxRunResult {
  claimed: number;
  published: number;
  retried: number;
  dead_lettered: number;
  lease_lost: number;
}

export class BillingOutboxWorker {
  private readonly options: Required<Omit<BillingOutboxWorkerOptions, "store" | "publisher">> &
    Pick<BillingOutboxWorkerOptions, "store" | "publisher">;

  constructor(options: BillingOutboxWorkerOptions) {
    if (!options.store || !options.publisher) throw new TypeError("billing outbox worker dependencies are required");
    const normalized = {
      store: options.store,
      publisher: options.publisher,
      batch_size: options.batch_size ?? 25,
      lease_ms: options.lease_ms ?? 30_000,
      max_attempts: options.max_attempts ?? 8,
      retry_base_ms: options.retry_base_ms ?? 1_000,
      retry_max_ms: options.retry_max_ms ?? 5 * 60_000,
      now: options.now ?? (() => new Date()),
    };
    if (!Number.isSafeInteger(normalized.batch_size) || normalized.batch_size < 1 || normalized.batch_size > 100 ||
      !Number.isSafeInteger(normalized.lease_ms) || normalized.lease_ms < 1_000 || normalized.lease_ms > 5 * 60_000 ||
      !Number.isSafeInteger(normalized.max_attempts) || normalized.max_attempts < 1 || normalized.max_attempts > 100 ||
      !Number.isSafeInteger(normalized.retry_base_ms) || normalized.retry_base_ms < 100 ||
      !Number.isSafeInteger(normalized.retry_max_ms) || normalized.retry_max_ms < normalized.retry_base_ms ||
      normalized.retry_max_ms > 24 * 60 * 60_000) {
      throw new TypeError("billing outbox worker options are invalid");
    }
    this.options = normalized;
  }

  async runOnce(): Promise<BillingOutboxRunResult> {
    const result: BillingOutboxRunResult = {
      claimed: 0,
      published: 0,
      retried: 0,
      dead_lettered: 0,
      lease_lost: 0,
    };
    const claimedAt = this.checkedNow();
    const records = await this.options.store.claimBillingOutbox({
      limit: this.options.batch_size,
      lease_ms: this.options.lease_ms,
      now: claimedAt.toISOString(),
    });
    result.claimed = records.length;
    for (const record of records) {
      const lockToken = record.lock_token;
      if (!lockToken) {
        result.lease_lost += 1;
        continue;
      }
      try {
        await this.options.publisher.publish(publicEvent(record));
        const completed = await this.options.store.completeBillingOutbox(
          record.outbox_id,
          lockToken,
          this.checkedNow().toISOString(),
        );
        if (completed) result.published += 1;
        else result.lease_lost += 1;
      } catch {
        const failedAt = this.checkedNow();
        const deadLettered = record.attempts >= this.options.max_attempts;
        const retryAt = new Date(failedAt.getTime() + retryDelay(
          record.attempts,
          this.options.retry_base_ms,
          this.options.retry_max_ms,
        ));
        const failed = await this.options.store.failBillingOutbox({
          outbox_id: record.outbox_id,
          lock_token: lockToken,
          failed_at: failedAt.toISOString(),
          retry_at: retryAt.toISOString(),
          error_code: "PUBLISH_FAILED",
          ...(deadLettered ? { dead_lettered_at: failedAt.toISOString() } : {}),
        });
        if (!failed) result.lease_lost += 1;
        else if (deadLettered) result.dead_lettered += 1;
        else result.retried += 1;
      }
    }
    return result;
  }

  private checkedNow(): Date {
    const value = this.options.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new TypeError("billing outbox clock returned an invalid time");
    }
    return value;
  }
}

function publicEvent(record: BillingOutboxRecord): BillingPublishedEvent {
  return {
    outbox_id: record.outbox_id,
    event_type: record.event_type,
    aggregate_id: record.aggregate_id,
    settlement_id: record.settlement_id,
    payload: { ...record.payload },
    created_at: record.created_at,
  };
}

function retryDelay(attempts: number, baseMs: number, maximumMs: number): number {
  const exponent = Math.max(0, Math.min(30, attempts - 1));
  return Math.min(maximumMs, baseMs * (2 ** exponent));
}
