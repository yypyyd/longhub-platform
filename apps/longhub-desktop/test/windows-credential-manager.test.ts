import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WindowsCredentialManager, credentialTargetFor } from "../src/windows-credential-manager.js";

describe("WindowsCredentialManager", () => {
  it("相同规范地址使用稳定且不泄露 URL 的 Credential target", () => {
    const first = credentialTargetFor("https://EXAMPLE.com/");
    const second = credentialTargetFor("https://example.com");
    expect(first).toBe(second);
    expect(first).toMatch(/^LongHub Desktop\/device\/[a-f0-9]{64}$/);
    expect(first).not.toContain("example.com");
  });

  it.skipIf(process.platform !== "win32")("通过真实 Windows Credential Manager 写入、读取并删除", async () => {
    const vault = new WindowsCredentialManager();
    const baseUrl = `https://credential-${randomUUID()}.longhub.invalid`;
    const credentials = { deviceId: `dev-${randomUUID()}`, deviceToken: `token-${randomUUID()}` };
    try {
      await vault.write(baseUrl, credentials);
      await expect(vault.read(baseUrl)).resolves.toEqual(credentials);
    } finally {
      await vault.delete(baseUrl);
    }
    await expect(vault.read(baseUrl)).resolves.toBeUndefined();
  }, 30_000);
});
