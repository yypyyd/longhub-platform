/**
 * 龙枢执行器：执行受保护的云端原子技能（L3）。
 * 原型提供 HTTP 接口：POST /execute { skillId, input } → { output }。
 */
import { createServer, type Server } from "node:http";
import { createConsoleLogger } from "@longhub/observability";

type CloudSkill = (input: unknown) => Promise<unknown>;

/** 受保护逻辑示例：薪酬带宽计算，源码仅存在于云端 */
const salaryBand: CloudSkill = async (input) => {
  const { level } = input as { level: number };
  if (!Number.isInteger(level) || level < 1 || level > 10) {
    throw new Error(`非法职级: ${String(level)}`);
  }
  const base = 8000 + level * 4000;
  return { level, min: base, max: Math.round(base * 1.6), currency: "CNY" };
};

const skills = new Map<string, CloudSkill>([["longhub.skill.salary-band", salaryBand]]);

export function createExecutorServer(): Server {
  const logger = createConsoleLogger("executor");
  return createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/execute") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "NOT_FOUND", message: "未知路由", retryable: false }));
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      void (async () => {
        try {
          const { skillId, input } = JSON.parse(body) as { skillId: string; input: unknown };
          const skill = skills.get(skillId);
          if (!skill) {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ code: "SKILL_NOT_FOUND", message: `未知技能: ${skillId}`, retryable: false }));
            return;
          }
          const output = await skill(input);
          logger.info("skill.executed", { skillId });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ output }));
        } catch (err) {
          res.writeHead(422, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              code: "SKILL_EXECUTION_FAILED",
              message: err instanceof Error ? err.message : String(err),
              retryable: false,
            }),
          );
        }
      })();
    });
  });
}
