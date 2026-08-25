import {
  CLIENT_TELEMETRY_MAX_EVENTS,
  CLIENT_TELEMETRY_SCHEMA,
  type ClientGatewayState,
  type ClientExitResult,
  type ClientProductErrorCode,
  type ClientTelemetryArchitecture,
  type ClientTelemetryBatch,
  type ClientTelemetryEvent,
  type ClientTelemetryPlatform,
  type ClientUpdateResult,
  clientAgentCountBucket,
  clientStartupBucket,
} from "@longhub/observability";

export interface ClientTelemetryReporterOptions {
  baseUrl: string;
  deviceToken: string;
  desktopVersion: string;
  openClawVersion: string;
  platform: ClientTelemetryPlatform;
  architecture: ClientTelemetryArchitecture;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  flushDelayMs?: number;
  onDrop?: () => void;
}

type EventInput =
  | { event_type: "client_started"; fields: Extract<ClientTelemetryEvent, { event_type: "client_started" }>["fields"] }
  | { event_type: "gateway_state"; fields: Extract<ClientTelemetryEvent, { event_type: "gateway_state" }>["fields"] }
  | { event_type: "client_update_result"; fields: Extract<ClientTelemetryEvent, { event_type: "client_update_result" }>["fields"] }
  | { event_type: "product_error"; fields: Extract<ClientTelemetryEvent, { event_type: "product_error" }>["fields"] }
  | { event_type: "previous_exit"; fields: Extract<ClientTelemetryEvent, { event_type: "previous_exit" }>["fields"] };

/**
 * 最小内存上报器：不创建持久队列、不重试失败批次，且所有网络失败均在内部吞掉。
 * 因此遥测永远不会阻断启动、聊天、更新或退出。
 */
export class ClientTelemetryReporter {
  private readonly queue: ClientTelemetryEvent[] = [];
  private timer: NodeJS.Timeout | undefined;
  private sending = false;
  private stopped = false;

  constructor(private readonly options: ClientTelemetryReporterOptions) {}

  recordStarted(durationMs: number, activeAgentCount: number): void {
    this.record({
      event_type: "client_started",
      fields: { startup_duration: clientStartupBucket(durationMs), active_agent_count: clientAgentCountBucket(activeAgentCount) },
    });
  }

  recordGatewayState(state: ClientGatewayState): void {
    this.record({ event_type: "gateway_state", fields: { state } });
  }

  recordUpdateResult(result: ClientUpdateResult): void {
    this.record({ event_type: "client_update_result", fields: { result } });
  }

  recordProductError(code: ClientProductErrorCode): void {
    this.record({ event_type: "product_error", fields: { code } });
  }

  recordPreviousExit(result: ClientExitResult): void {
    this.record({ event_type: "previous_exit", fields: { result } });
  }

  async flush(): Promise<void> {
    if (this.sending || this.queue.length === 0) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const events = this.queue.splice(0, CLIENT_TELEMETRY_MAX_EVENTS);
    const batch: ClientTelemetryBatch = { schema_version: CLIENT_TELEMETRY_SCHEMA, events };
    this.sending = true;
    try {
      const response = await (this.options.fetchImpl ?? fetch)(`${this.options.baseUrl}/v1/client/telemetry`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.deviceToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(batch),
      });
      if (!response.ok) this.options.onDrop?.();
    } catch {
      this.options.onDrop?.();
    } finally {
      this.sending = false;
      if (this.queue.length > 0 && !this.stopped) this.schedule();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    void this.flush();
  }

  private record(input: EventInput): void {
    if (this.stopped) return;
    if (this.queue.length >= CLIENT_TELEMETRY_MAX_EVENTS) {
      this.options.onDrop?.();
      return;
    }
    const common = {
      occurred_at: (this.options.now ?? (() => new Date()))().toISOString(),
      manager_version: this.options.desktopVersion,
      openclaw_version: this.options.openClawVersion,
      platform: this.options.platform,
      architecture: this.options.architecture,
    };
    this.queue.push({ ...common, ...input } as ClientTelemetryEvent);
    if (this.queue.length >= CLIENT_TELEMETRY_MAX_EVENTS) void this.flush();
    else this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.options.flushDelayMs ?? 5_000);
    this.timer.unref();
  }
}
