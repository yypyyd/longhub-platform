import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CLOUD_PLUGIN_CREDENTIAL_NAMESPACE,
  DESKTOP_CREDENTIAL_NAMESPACE,
  WindowsCredentialManager,
  credentialTargetFor,
} from "../src/index.js";

const credentialManagerIntegration = process.platform === "win32" && process.env.CI ? it.skip : it;

describe("Windows credential target isolation", () => {
  it("normalizes an origin while keeping product namespaces separate", () => {
    const cloud = credentialTargetFor("https://EXAMPLE.com/", CLOUD_PLUGIN_CREDENTIAL_NAMESPACE);
    const desktop = credentialTargetFor("https://example.com", DESKTOP_CREDENTIAL_NAMESPACE);
    expect(cloud).toMatch(/^LongHub Cloud Plugin\/device\/[a-f0-9]{64}$/u);
    expect(desktop).toMatch(/^LongHub Desktop\/device\/[a-f0-9]{64}$/u);
    expect(cloud.slice(cloud.lastIndexOf("/") + 1)).toBe(desktop.slice(desktop.lastIndexOf("/") + 1));
  });

  credentialManagerIntegration("uses real Credential Manager with write-after-read verification on Windows", async () => {
    const baseUrl = `http://127.0.0.1/credential-test-${randomUUID()}`;
    const vault = new WindowsCredentialManager({ namespace: "LongHub Test" });
    if (process.platform !== "win32") {
      await expect(vault.read(baseUrl)).rejects.toThrow("UNSUPPORTED_PLATFORM");
      return;
    }
    const expected = { deviceId: "test-device", deviceToken: `test-token-${randomUUID()}` };
    try {
      await vault.write(baseUrl, expected);
      await expect(vault.read(baseUrl)).resolves.toEqual(expected);
    } finally {
      await vault.delete(baseUrl);
    }
    await expect(vault.read(baseUrl)).resolves.toBeUndefined();
  }, 30_000);
});
