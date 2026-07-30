import { describe, expect, it } from "vitest";
import { resolveExternalRuntimePath } from "../src/packaged-runtime-path.js";

describe("ASAR 外置运行时路径", () => {
  it("开发环境保持应用目录内的物理路径", () => {
    expect(resolveExternalRuntimePath("C:\\LongHub", "node_modules\\openclaw\\openclaw.mjs", () => true))
      .toBe("C:\\LongHub\\node_modules\\openclaw\\openclaw.mjs");
  });

  it("打包环境只解析到 app.asar.unpacked", () => {
    expect(resolveExternalRuntimePath(
      "C:\\LongHub\\resources\\app.asar",
      "node_modules\\openclaw\\openclaw.mjs",
      () => true,
    )).toBe("C:\\LongHub\\resources\\app.asar.unpacked\\node_modules\\openclaw\\openclaw.mjs");
  });

  it("拒绝路径穿越且不静默回退 ASAR", () => {
    expect(() => resolveExternalRuntimePath("C:\\LongHub\\resources\\app.asar", "..\\secret", () => true))
      .toThrow("路径越界");
    expect(() => resolveExternalRuntimePath(
      "C:\\LongHub\\resources\\app.asar",
      "node_modules\\openclaw\\openclaw.mjs",
      () => false,
    )).toThrow("app.asar.unpacked");
  });
});
