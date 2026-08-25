import { describe, expect, it } from "vitest";
import {
  isValidManagerInstallerFilename,
  isValidManagerVersion,
  managerInstallerFilename,
} from "./manager-release-model";

describe("LongHub Manager 发布模型", () => {
  it("使用 Manager 独立安装包名称", () => {
    expect(managerInstallerFilename("1.2.3")).toBe("LongHub-Manager-Setup-1.2.3.exe");
    expect(isValidManagerInstallerFilename("1.2.3", "LongHub-Manager-Setup-1.2.3.exe")).toBe(true);
    expect(isValidManagerInstallerFilename("1.2.3", "LongHub-Setup-1.2.3.exe")).toBe(false);
  });

  it("拒绝非规范版本，避免前端接受后端会拒绝的文件", () => {
    expect(isValidManagerVersion("0.0.0")).toBe(true);
    expect(isValidManagerVersion("01.2.3")).toBe(false);
    expect(isValidManagerVersion("1.2")).toBe(false);
    expect(isValidManagerVersion("1000000000.2.3")).toBe(false);
    expect(() => managerInstallerFilename("latest")).toThrow("规范的 x.y.z");
  });
});
