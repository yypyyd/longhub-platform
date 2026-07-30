import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeviceCredentialStore } from "../src/device-credential-store.js";
import type { DeviceCredentials, DeviceCredentialVault } from "../src/windows-credential-manager.js";

const BASE_URL = "https://cloud.longhub.test";
const LEGACY_TOKEN = "legacy-device-token";

class MemoryVault implements DeviceCredentialVault {
  readonly entries = new Map<string, DeviceCredentials>();
  readonly writes: Array<{ baseUrl: string; credentials: DeviceCredentials }> = [];
  failWrite = false;
  corruptReadAfterWrite = false;

  async read(baseUrl: string): Promise<DeviceCredentials | undefined> {
    const value = this.entries.get(baseUrl);
    if (!value) return undefined;
    return this.corruptReadAfterWrite ? { ...value, deviceToken: `${value.deviceToken}-corrupt` } : { ...value };
  }

  async write(baseUrl: string, credentials: DeviceCredentials): Promise<void> {
    this.writes.push({ baseUrl, credentials: { ...credentials } });
    if (this.failWrite) throw new Error("vault unavailable");
    this.entries.set(baseUrl, { ...credentials });
  }

  async delete(baseUrl: string): Promise<void> {
    this.entries.delete(baseUrl);
  }
}

const directories: string[] = [];

function stateFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "longhub-credential-store-"));
  directories.push(directory);
  return join(directory, "device.json");
}

function readState(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("DeviceCredentialStore", () => {
  it("把旧 Token 写入并回读 Credential Manager 后从 device.json 清除", async () => {
    const file = stateFile();
    writeFileSync(file, JSON.stringify({
      fingerprint: "fp-existing",
      tokensByBaseUrl: { [BASE_URL]: LEGACY_TOKEN },
      idsByBaseUrl: { [BASE_URL]: "dev-existing" },
    }));
    const vault = new MemoryVault();
    const register = vi.fn();
    const store = new DeviceCredentialStore({ stateFile: file, vault });

    await expect(store.credentialsFor(BASE_URL, register)).resolves.toEqual({
      deviceId: "dev-existing",
      deviceToken: LEGACY_TOKEN,
    });
    expect(register).not.toHaveBeenCalled();
    expect(vault.writes).toEqual([{ baseUrl: BASE_URL, credentials: {
      deviceId: "dev-existing",
      deviceToken: LEGACY_TOKEN,
    } }]);
    const persisted = readState(file);
    expect(persisted).toEqual({
      schema_version: 2,
      fingerprint: "fp-existing",
      idsByBaseUrl: { [BASE_URL]: "dev-existing" },
    });
    expect(readFileSync(file, "utf8")).not.toContain(LEGACY_TOKEN);
  });

  it("旧文件缺少设备 ID 时通过已认证云端状态恢复后迁移", async () => {
    const file = stateFile();
    writeFileSync(file, JSON.stringify({
      fingerprint: "fp-existing",
      tokensByBaseUrl: { [BASE_URL]: LEGACY_TOKEN },
    }));
    const vault = new MemoryVault();
    const resolveLegacyDeviceId = vi.fn().mockResolvedValue("dev-recovered");
    const store = new DeviceCredentialStore({ stateFile: file, vault, resolveLegacyDeviceId });

    await expect(store.credentialsFor(BASE_URL, vi.fn())).resolves.toEqual({
      deviceId: "dev-recovered",
      deviceToken: LEGACY_TOKEN,
    });
    expect(resolveLegacyDeviceId).toHaveBeenCalledWith(BASE_URL, LEGACY_TOKEN);
    expect(readFileSync(file, "utf8")).not.toContain(LEGACY_TOKEN);
  });

  it("写入失败或回读不一致时保留旧明文，不制造不可恢复状态", async () => {
    for (const mode of ["write", "verify"] as const) {
      const file = stateFile();
      writeFileSync(file, JSON.stringify({
        fingerprint: "fp-existing",
        tokensByBaseUrl: { [BASE_URL]: LEGACY_TOKEN },
        idsByBaseUrl: { [BASE_URL]: "dev-existing" },
      }));
      const vault = new MemoryVault();
      vault.failWrite = mode === "write";
      vault.corruptReadAfterWrite = mode === "verify";
      const store = new DeviceCredentialStore({ stateFile: file, vault });

      await expect(store.credentialsFor(BASE_URL, vi.fn())).rejects.toThrow();
      expect(readFileSync(file, "utf8")).toContain(LEGACY_TOKEN);
    }
  });

  it("首次注册只把非敏感元数据写入文件，并合并并发注册", async () => {
    const file = stateFile();
    const vault = new MemoryVault();
    const register = vi.fn().mockResolvedValue({ deviceId: "dev-new", deviceToken: "new-secret-token" });
    const store = new DeviceCredentialStore({
      stateFile: file,
      vault,
      fingerprintFactory: () => "fp-new",
    });

    const [first, second] = await Promise.all([
      store.credentialsFor(BASE_URL, register),
      store.credentialsFor(BASE_URL, register),
    ]);
    expect(first).toEqual(second);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith("fp-new");
    expect(readState(file)).toEqual({
      schema_version: 2,
      fingerprint: "fp-new",
      idsByBaseUrl: { [BASE_URL]: "dev-new" },
    });
    expect(readFileSync(file, "utf8")).not.toContain("new-secret-token");
  });

  it("一次性迁移全部地址，所有条目成功前不清空旧文件", async () => {
    const file = stateFile();
    const otherUrl = "https://other.longhub.test";
    writeFileSync(file, JSON.stringify({
      fingerprint: "fp-existing",
      tokensByBaseUrl: { [BASE_URL]: LEGACY_TOKEN, [otherUrl]: "other-token" },
      idsByBaseUrl: { [BASE_URL]: "dev-existing", [otherUrl]: "dev-other" },
    }));
    const vault = new MemoryVault();
    const store = new DeviceCredentialStore({ stateFile: file, vault });

    await store.credentialsFor(BASE_URL, vi.fn());
    expect(vault.entries.get(otherUrl)).toEqual({ deviceId: "dev-other", deviceToken: "other-token" });
    expect(readState(file)).toEqual({
      schema_version: 2,
      fingerprint: "fp-existing",
      idsByBaseUrl: { [BASE_URL]: "dev-existing", [otherUrl]: "dev-other" },
    });
    expect(readFileSync(file, "utf8")).not.toContain("other-token");
  });
});
