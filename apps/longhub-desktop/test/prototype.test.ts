import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

describe("Desktop → Core → Skill Worker 多进程原型", () => {
  it("完成本地技能闭环：hello → submit（幂等）→ 事件 → 结果", async () => {
    const entry = fileURLToPath(new URL("../dist/prototype.js", import.meta.url));
    const { stdout } = await run(process.execPath, [entry], { timeout: 30_000 });
    expect(stdout).toContain("[hello] Core RPC 1.0");
    expect(stdout).toContain("output=LONGHUB");
    expect(stdout).toContain("task.accepted");
    expect(stdout).toContain("task.succeeded");
  }, 40_000);
});
