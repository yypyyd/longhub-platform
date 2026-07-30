import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ClientExitResult } from "@longhub/observability";

export const CLIENT_RUN_MARKER_SCHEMA = "longhub/client-run-marker/v1" as const;

interface MarkerDocument {
  schema_version: typeof CLIENT_RUN_MARKER_SCHEMA;
  state: "running" | "clean";
}

export interface ClientRunMarkerOptions {
  onFailure?: (code: "read_failed" | "write_failed" | "unsafe_file") => void;
}

/**
 * 本地运行标记只回答“上一进程是否完成正常退出”。它不是事件队列，不含时间、
 * 身份、路径或会话数据；所有故障均安全降级，绝不阻断客户端启动或退出。
 */
export class ClientRunMarker {
  private readonly markerPath: string;

  constructor(userDataDir: string, private readonly options: ClientRunMarkerOptions = {}) {
    this.markerPath = join(userDataDir, "client-run-marker.json");
  }

  begin(): ClientExitResult | undefined {
    const previous = this.read();
    this.write("running");
    return previous?.state === "running" ? "unclean" : previous?.state === "clean" ? "clean" : undefined;
  }

  markClean(): void {
    this.write("clean");
  }

  private read(): MarkerDocument | undefined {
    if (!existsSync(this.markerPath)) return undefined;
    try {
      const stat = lstatSync(this.markerPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        this.options.onFailure?.("unsafe_file");
        return undefined;
      }
      const parsed = JSON.parse(readFileSync(this.markerPath, "utf8")) as unknown;
      if (!isMarkerDocument(parsed)) throw new Error("invalid marker");
      return parsed;
    } catch {
      this.options.onFailure?.("read_failed");
      return undefined;
    }
  }

  private write(state: MarkerDocument["state"]): void {
    let temporary: string | undefined;
    let handle: number | undefined;
    try {
      if (existsSync(this.markerPath)) {
        const stat = lstatSync(this.markerPath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          this.options.onFailure?.("unsafe_file");
          return;
        }
      }
      temporary = join(dirname(this.markerPath), `.client-run-marker-${process.pid}.tmp`);
      if (existsSync(temporary)) unlinkSync(temporary);
      handle = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      const document: MarkerDocument = { schema_version: CLIENT_RUN_MARKER_SCHEMA, state };
      writeFileSync(handle, JSON.stringify(document), "utf8");
      closeSync(handle);
      handle = undefined;
      renameSync(temporary, this.markerPath);
      temporary = undefined;
    } catch {
      this.options.onFailure?.("write_failed");
    } finally {
      if (handle !== undefined) {
        try { closeSync(handle); } catch { /* best-effort cleanup */ }
      }
      if (temporary) {
        try { unlinkSync(temporary); } catch { /* best-effort cleanup */ }
      }
    }
  }
}

function isMarkerDocument(value: unknown): value is MarkerDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(",") === "schema_version,state" &&
    record.schema_version === CLIENT_RUN_MARKER_SCHEMA &&
    (record.state === "running" || record.state === "clean");
}
