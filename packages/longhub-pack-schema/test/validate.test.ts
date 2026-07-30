import { describe, expect, it } from "vitest";
import { validatePackManifest } from "../src/validate.js";

const valid = {
  schemaVersion: "longhub/v1",
  pack: {
    id: "longhub.hr-suite",
    version: "1.3.0",
    minDesktopVersion: "1.0.0",
  },
  agentTemplate: {
    id: "longhub.agent.hr",
    version: "1.2.0",
    profilePath: "agent-profile.json",
  },
  capabilities: [
    {
      id: "longhub.capability.recruitment",
      version: "2.1.0",
      required: true,
      permissions: ["connector:hr-api:read"],
    },
  ],
  runtime: {
    sdkVersion: "1.0",
    executionMode: "hybrid",
  },
  limits: {
    maxConcurrentSkills: 3,
    maxTaskDepth: 3,
  },
  integrity: {
    algorithm: "sha256",
    digest: "abc123",
    signatureKeyId: "longhub-release-2026-01",
  },
};

describe("validatePackManifest", () => {
  it("接受符合 V1 契约的 manifest", () => {
    const result = validatePackManifest(valid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.pack.id).toBe("longhub.hr-suite");
    }
  });

  it("拒绝错误的 schemaVersion", () => {
    const result = validatePackManifest({ ...valid, schemaVersion: "longhub/v2" });
    expect(result.ok).toBe(false);
  });

  it("拒绝非法版本号", () => {
    const result = validatePackManifest({
      ...valid,
      pack: { ...valid.pack, version: "1.3" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.path).toBe("pack.version");
    }
  });

  it("拒绝空能力列表", () => {
    const result = validatePackManifest({ ...valid, capabilities: [] });
    expect(result.ok).toBe(false);
  });

  it("拒绝非法权限格式", () => {
    const result = validatePackManifest({
      ...valid,
      capabilities: [{ ...valid.capabilities[0], permissions: ["BadPermission"] }],
    });
    expect(result.ok).toBe(false);
  });
});
