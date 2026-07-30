import { describe, expect, it } from "vitest";
import { validateWindowsInstallerSignature } from "../src/windows-update-installer.js";

describe("Windows 更新安装器签名记录", () => {
  const valid = {
    status: "Valid",
    signerSubject: "CN=LongHub Technology, O=LongHub",
    signerThumbprint: "abc",
    timestampSubject: "CN=Trusted Timestamp",
  };

  it("要求状态、主体和可信时间戳同时有效", () => {
    expect(validateWindowsInstallerSignature(valid, "LongHub Technology")).toEqual(valid);
    expect(() => validateWindowsInstallerSignature({ ...valid, status: "HashMismatch" }, "LongHub")).toThrow("状态无效");
    expect(() => validateWindowsInstallerSignature({ ...valid, signerSubject: "CN=Other" }, "LongHub")).toThrow("主体不匹配");
    expect(() => validateWindowsInstallerSignature({ ...valid, timestampSubject: null }, "LongHub")).toThrow("时间戳");
    expect(() => validateWindowsInstallerSignature(valid, " ")).toThrow("为空");
  });
});
