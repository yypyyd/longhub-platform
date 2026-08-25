import type { CloudStore, DeviceRecord, ModelGatewayConfigRecord, ModelUsageAggregateRecord } from "./store.js";

const minuteRequests = new Map<string, number[]>();
const concurrency = new Map<string, number>();
const admissionLocks = new Map<string, Promise<void>>();

export class ModelQuotaError extends Error {
  constructor(readonly code: "MODEL_RATE_LIMITED" | "MODEL_DAILY_QUOTA_EXCEEDED" | "TENANT_MONTHLY_QUOTA_EXCEEDED" | "MODEL_CONCURRENCY_LIMITED") {
    super(code);
    this.name = "ModelQuotaError";
  }
}

function periodStart(date: Date, period: "day" | "month"): string {
  return period === "day"
    ? date.toISOString().slice(0, 10)
    : `${date.toISOString().slice(0, 7)}-01`;
}

function tokensFromHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (!raw || !/^\d{1,12}$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

export interface ModelUsageLease {
  complete(params: { success: boolean; inputBytes: number; outputBytes: number; headers?: Headers }): Promise<void>;
  release(): void;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("模型客户端已断开连接");
}

/**
 * Race an operation against a request abort without cancelling the underlying
 * store promise. The late store result is deliberately ignored so it cannot
 * mutate admission state after the request has already left.
 */
function waitForAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

async function withDeviceAdmissionLock<T>(
  deviceId: string,
  action: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const previous = admissionLocks.get(deviceId) ?? Promise.resolve();
  let unlock!: () => void;
  const current = new Promise<void>((resolve) => { unlock = resolve; });
  admissionLocks.set(deviceId, current);
  let acquired = false;
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    unlock();
    if (admissionLocks.get(deviceId) === current) admissionLocks.delete(deviceId);
  };
  try {
    await waitForAbort(previous, signal);
    if (signal?.aborted) throw abortReason(signal);
    acquired = true;
    return await action();
  } finally {
    if (acquired) finish();
    else void previous.then(finish, finish);
  }
}

export async function beginModelUsage(
  store: CloudStore,
  device: DeviceRecord,
  config: ModelGatewayConfigRecord,
  now = new Date(),
  signal?: AbortSignal,
): Promise<ModelUsageLease> {
  const day = periodStart(now, "day");
  const month = periodStart(now, "month");
  await withDeviceAdmissionLock(device.device_id, async () => {
    const usage = await waitForAbort(store.listModelUsage(), signal);
    if (signal?.aborted) throw abortReason(signal);
    const minute = now.getTime() - 60_000;
    const recent = (minuteRequests.get(device.device_id) ?? []).filter((time) => time > minute);
    if (recent.length >= config.device_requests_per_minute) throw new ModelQuotaError("MODEL_RATE_LIMITED");
    const active = concurrency.get(device.device_id) ?? 0;
    if (active >= config.max_device_concurrency) throw new ModelQuotaError("MODEL_CONCURRENCY_LIMITED");
    const deviceTokens = usage.filter((row) => row.period === "day" && row.period_start === day && row.device_id === device.device_id)
      .reduce((sum, row) => sum + row.input_tokens + row.output_tokens, 0);
    if (deviceTokens >= config.device_daily_tokens) throw new ModelQuotaError("MODEL_DAILY_QUOTA_EXCEEDED");
    const tenantTokens = usage.filter((row) => row.period === "month" && row.period_start === month && row.tenant_id === device.tenant_id)
      .reduce((sum, row) => sum + row.input_tokens + row.output_tokens, 0);
    if (tenantTokens >= config.tenant_monthly_tokens) throw new ModelQuotaError("TENANT_MONTHLY_QUOTA_EXCEEDED");
    recent.push(now.getTime());
    minuteRequests.set(device.device_id, recent);
    concurrency.set(device.device_id, active + 1);
  }, signal);
  let released = false;
  let releaseOnAbort: (() => void) | undefined;
  const release = (): void => {
    if (released) return;
    released = true;
    if (signal && releaseOnAbort) signal.removeEventListener("abort", releaseOnAbort);
    const current = concurrency.get(device.device_id) ?? 1;
    if (current <= 1) concurrency.delete(device.device_id);
    else concurrency.set(device.device_id, current - 1);
  };
  if (signal) {
    releaseOnAbort = release;
    signal.addEventListener("abort", releaseOnAbort, { once: true });
    if (signal.aborted) release();
  }
  return {
    release,
    async complete(params) {
      try {
      const headerInput = params.headers ? tokensFromHeader(params.headers, "x-longhub-input-tokens") : undefined;
      const headerOutput = params.headers ? tokensFromHeader(params.headers, "x-longhub-output-tokens") : undefined;
      const cacheTokens = params.headers ? tokensFromHeader(params.headers, "x-longhub-cache-tokens") ?? 0 : 0;
      const inputTokens = headerInput ?? Math.ceil(params.inputBytes / 4);
      const outputTokens = headerOutput ?? Math.ceil(params.outputBytes / 4);
      const estimatedTokens = (headerInput === undefined ? inputTokens : 0) + (headerOutput === undefined ? outputTokens : 0);
      const cost = Math.ceil((inputTokens * config.input_cost_microunits_per_million +
        outputTokens * config.output_cost_microunits_per_million + cacheTokens * config.cache_cost_microunits_per_million) / 1_000_000);
      const base = {
        tenant_id: device.tenant_id,
        device_id: device.device_id,
        config_id: config.config_id,
        request_count: 1,
        success_count: params.success ? 1 : 0,
        error_count: params.success ? 0 : 1,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_tokens: cacheTokens,
        estimated_tokens: estimatedTokens,
        cost_microunits: cost,
      };
      const records: ModelUsageAggregateRecord[] = [
        { ...base, period: "day", period_start: day },
        { ...base, period: "month", period_start: month },
      ];
      await store.incrementModelUsage(records);
      } finally {
        release();
      }
    },
  };
}
