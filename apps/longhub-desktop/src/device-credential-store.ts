import { randomUUID, timingSafeEqual } from "node:crypto";
import { dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { DeviceCredentials, DeviceCredentialVault } from "./windows-credential-manager.js";

interface DeviceMetadata {
  schema_version: 2;
  fingerprint: string;
  idsByBaseUrl: Record<string, string>;
}

interface LoadedDeviceState {
  metadata: DeviceMetadata;
  legacyTokens: Record<string, string>;
  requiresRewrite: boolean;
}

export interface DeviceCredentialStoreOptions {
  stateFile: string;
  vault: DeviceCredentialVault;
  fingerprintFactory?: () => string;
  resolveLegacyDeviceId?: (baseUrl: string, deviceToken: string) => Promise<string>;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string" && entry[1].length > 0,
    ),
  );
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export class DeviceCredentialStore {
  private readonly stateFile: string;
  private readonly vault: DeviceCredentialVault;
  private readonly fingerprintFactory: () => string;
  private readonly resolveLegacyDeviceId?: (baseUrl: string, deviceToken: string) => Promise<string>;
  private readonly memory = new Map<string, DeviceCredentials>();
  private readonly inFlight = new Map<string, Promise<DeviceCredentials>>();

  constructor(options: DeviceCredentialStoreOptions) {
    this.stateFile = options.stateFile;
    this.vault = options.vault;
    this.fingerprintFactory = options.fingerprintFactory ?? (() => `fp-${randomUUID()}`);
    this.resolveLegacyDeviceId = options.resolveLegacyDeviceId;
  }

  credentialsFor(
    baseUrl: string,
    register: (fingerprint: string) => Promise<DeviceCredentials>,
  ): Promise<DeviceCredentials> {
    const cached = this.memory.get(baseUrl);
    if (cached) return Promise.resolve({ ...cached });
    const active = this.inFlight.get(baseUrl);
    if (active) return active.then((credentials) => ({ ...credentials }));
    const operation = this.loadOrRegister(baseUrl, register).finally(() => this.inFlight.delete(baseUrl));
    this.inFlight.set(baseUrl, operation);
    return operation.then((credentials) => ({ ...credentials }));
  }

  private loadState(): LoadedDeviceState {
    if (!existsSync(this.stateFile)) {
      return {
        metadata: { schema_version: 2, fingerprint: this.fingerprintFactory(), idsByBaseUrl: {} },
        legacyTokens: {},
        requiresRewrite: true,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.stateFile, "utf8"));
    } catch {
      throw new Error("device.json 格式无效，拒绝覆盖可能仍包含的设备凭据");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("device.json 格式无效，拒绝覆盖可能仍包含的设备凭据");
    }
    const raw = parsed as Record<string, unknown>;
    if (typeof raw.fingerprint !== "string" || raw.fingerprint.length < 1 || raw.fingerprint.length > 512) {
      throw new Error("device.json 缺少有效设备指纹");
    }
    const idsByBaseUrl = stringRecord(raw.idsByBaseUrl);
    const legacyTokens = stringRecord(raw.tokensByBaseUrl);
    return {
      metadata: { schema_version: 2, fingerprint: raw.fingerprint, idsByBaseUrl },
      legacyTokens,
      requiresRewrite: raw.schema_version !== 2 || "tokensByBaseUrl" in raw,
    };
  }

  private saveMetadata(metadata: DeviceMetadata): void {
    mkdirSync(dirname(this.stateFile), { recursive: true });
    const temporary = `${this.stateFile}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(metadata, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.stateFile);
  }

  private async persistAndVerify(baseUrl: string, credentials: DeviceCredentials): Promise<DeviceCredentials> {
    await this.vault.write(baseUrl, credentials);
    const verified = await this.vault.read(baseUrl);
    if (
      !verified || verified.deviceId !== credentials.deviceId ||
      !sameSecret(verified.deviceToken, credentials.deviceToken)
    ) {
      throw new Error("Windows Credential Manager 写入后回读不一致；旧明文凭据未删除");
    }
    return verified;
  }

  private async loadOrRegister(
    baseUrl: string,
    register: (fingerprint: string) => Promise<DeviceCredentials>,
  ): Promise<DeviceCredentials> {
    const state = this.loadState();
    const migrated = await this.migrateLegacyCredentials(state);
    const stored = migrated.get(baseUrl) ?? await this.vault.read(baseUrl);
    if (stored) {
      state.metadata.idsByBaseUrl[baseUrl] = stored.deviceId;
      if (state.requiresRewrite && migrated.size === 0) this.saveMetadata(state.metadata);
      this.memory.set(baseUrl, stored);
      return stored;
    }

    const credentials = await register(state.metadata.fingerprint);
    const persisted = await this.persistAndVerify(baseUrl, credentials);
    state.metadata.idsByBaseUrl[baseUrl] = persisted.deviceId;
    this.saveMetadata(state.metadata);
    this.memory.set(baseUrl, persisted);
    return persisted;
  }

  private async migrateLegacyCredentials(state: LoadedDeviceState): Promise<Map<string, DeviceCredentials>> {
    const entries = Object.entries(state.legacyTokens);
    if (entries.length === 0) return new Map();
    const migrated = new Map<string, DeviceCredentials>();
    for (const [legacyBaseUrl, legacyToken] of entries) {
      const existing = await this.vault.read(legacyBaseUrl);
      if (existing) {
        if (!sameSecret(existing.deviceToken, legacyToken)) {
          throw new Error("Credential Manager 与旧 device.json 凭据不一致；旧文件未修改");
        }
        state.metadata.idsByBaseUrl[legacyBaseUrl] = existing.deviceId;
        migrated.set(legacyBaseUrl, existing);
        continue;
      }
      let deviceId = state.metadata.idsByBaseUrl[legacyBaseUrl];
      if (!deviceId && this.resolveLegacyDeviceId) {
        deviceId = await this.resolveLegacyDeviceId(legacyBaseUrl, legacyToken);
      }
      if (!deviceId) throw new Error("旧设备凭据缺少设备 ID；为避免丢失授权，已保留 device.json 原文");
      const verified = await this.persistAndVerify(legacyBaseUrl, { deviceId, deviceToken: legacyToken });
      state.metadata.idsByBaseUrl[legacyBaseUrl] = deviceId;
      migrated.set(legacyBaseUrl, verified);
    }
    // 所有条目均已写入并回读后才一次性清空旧文件；中途失败时原文件完全不动。
    this.saveMetadata(state.metadata);
    return migrated;
  }
}
