/** Preload 暴露的白名单 API（见 src/preload.cts） */
export interface TaskEvent {
  event_id: string;
  task_id: string;
  type: string;
  ts: string;
  error?: { code: string; message: string; retryable: boolean };
}

export interface TaskRecord {
  taskId: string;
  status: string;
  output?: unknown;
  error?: { code: string; message: string };
}

export interface InstalledPack {
  packId: string;
  activeVersion?: string;
  previousVersion?: string;
}

export type InstallResult =
  | { ok: true; packId: string; version: string; previousVersion?: string }
  | { ok: false; code: string; message: string };

export interface SubmitTaskParams {
  idempotencyKey: string;
  skillId: string;
  input: unknown;
  grantedPermissions?: string[];
  userConfirmed?: boolean;
}

export type SubmitTaskResult =
  | { needsConfirmation: string[] }
  | { taskId: string; status: string };

export interface LonghubApi {
  hello(): Promise<{ coreRpcVersion: string }>;
  submitTask(params: SubmitTaskParams): Promise<SubmitTaskResult>;
  getTask(taskId: string): Promise<TaskRecord>;
  cancelTask(taskId: string): Promise<TaskRecord>;
  listPacks(): Promise<InstalledPack[]>;
  installPack(): Promise<InstallResult>;
  rollbackPack(packId: string): Promise<InstallResult>;
  installPackFromCloud(params: {
    baseUrl: string;
    packId: string;
    version?: string;
  }): Promise<InstallResult>;
  onTaskEvent(callback: (event: TaskEvent) => void): () => void;
}

declare global {
  interface Window {
    longhub: LonghubApi;
  }
}
