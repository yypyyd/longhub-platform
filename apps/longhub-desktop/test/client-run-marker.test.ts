import { lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLIENT_RUN_MARKER_SCHEMA, ClientRunMarker } from "../src/client-run-marker.js";

const directories: string[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "longhub-run-marker-"));
  directories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("ClientRunMarker", () => {
  it("首次启动不报告，正常退出后报告 clean", async () => {
    const dir = await directory();
    const marker = new ClientRunMarker(dir);
    expect(marker.begin()).toBeUndefined();
    marker.markClean();
    expect(new ClientRunMarker(dir).begin()).toBe("clean");
    expect(JSON.parse(readFileSync(join(dir, "client-run-marker.json"), "utf8"))).toEqual({
      schema_version: CLIENT_RUN_MARKER_SCHEMA,
      state: "running",
    });
  });

  it("检测上一次未清理的 running 标记", async () => {
    const dir = await directory();
    new ClientRunMarker(dir).begin();
    expect(new ClientRunMarker(dir).begin()).toBe("unclean");
  });

  it("损坏内容安全重建且不阻断", async () => {
    const dir = await directory();
    writeFileSync(join(dir, "client-run-marker.json"), "not-json");
    const onFailure = vi.fn();
    expect(new ClientRunMarker(dir, { onFailure }).begin()).toBeUndefined();
    expect(onFailure).toHaveBeenCalledWith("read_failed");
    expect(JSON.parse(readFileSync(join(dir, "client-run-marker.json"), "utf8"))).toMatchObject({ state: "running" });
  });

  it("拒绝符号链接和非普通文件", async () => {
    const dir = await directory();
    const target = join(dir, "target.json");
    writeFileSync(target, "protected");
    const link = join(dir, "client-run-marker.json");
    symlinkSync(target, link, "file");
    const onFailure = vi.fn();
    expect(new ClientRunMarker(dir, { onFailure }).begin()).toBeUndefined();
    expect(readFileSync(target, "utf8")).toBe("protected");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(onFailure).toHaveBeenCalledWith("unsafe_file");

    await rm(link, { force: true });
    mkdirSync(link);
    expect(new ClientRunMarker(dir, { onFailure }).begin()).toBeUndefined();
    expect(lstatSync(link).isDirectory()).toBe(true);
  });
});
