/**
 * Skill Worker 进程：隔离执行本地低敏感技能（L0/L1）与底座智能体技能（L2）。
 * 通过 stdin/stdout NDJSON 与 Core 进程通信（skill.execute / skill.abort）。
 * L2 技能经小龙虾适配层调用底座：设 OPENCLAW_GATEWAY_URL 时走真实 OpenClaw Gateway，
 * 否则用内存 Mock（开发/测试）。
 */
import { createLineChannel, isRequest, RPC_VERSION, type RpcMessage } from "@longhub/core";
import { defineSkill, type SkillDefinition } from "@longhub/sdk";
import { createJdDraftSkill, hrLocalSkills } from "@longhub/hr-suite";
import {
  createMockAdapter,
  createOpenClawAdapter,
  type UpstreamRuntimeAdapter,
  type UpstreamSession,
} from "@longhub/xiaolongxia-adapter";

const echoUpper = defineSkill<{ text: string }, { text: string }>({
  id: "longhub.skill.echo-upper",
  level: "L1",
  permissions: [],
  async run(input) {
    return { text: input.text.toUpperCase() };
  },
});

/** 惰性初始化底座适配器：首个 L2 技能调用时才连接 */
let upstreamReady: Promise<UpstreamRuntimeAdapter> | undefined;
function upstream(): Promise<UpstreamRuntimeAdapter> {
  upstreamReady ??= (async () => {
    const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL;
    const adapter = gatewayUrl
      ? createOpenClawAdapter({ gatewayUrl, token: process.env.OPENCLAW_GATEWAY_TOKEN })
      : createMockAdapter();
    await adapter.init();
    return adapter;
  })();
  return upstreamReady;
}

const jdDraft = createJdDraftSkill(upstream);

/** 底座默认智能体（OpenClaw 默认 agent id 为 main），可用环境变量覆盖 */
const CHAT_AGENT_ID = process.env.LONGHUB_CHAT_AGENT_ID ?? "main";

/** 每个对话复用一个底座会话，上下文跨消息保持 */
const chatSessions = new Map<string, Promise<UpstreamSession>>();

const chat = defineSkill<
  { conversationId: string; message: string },
  { reply: string }
>({
  id: "longhub.skill.chat",
  level: "L2",
  permissions: [],
  async run(input) {
    if (!input.message.trim()) throw new Error("message 不能为空");
    const adapter = await upstream();
    let sessionPromise = chatSessions.get(input.conversationId);
    if (!sessionPromise) {
      sessionPromise = adapter.createSession(CHAT_AGENT_ID);
      chatSessions.set(input.conversationId, sessionPromise);
    }
    const session = await sessionPromise;
    let finalText = "";
    for await (const event of adapter.sendMessage(session, input.message)) {
      if (event.type === "done") {
        finalText = event.finalText;
      } else if (event.type === "error") {
        chatSessions.delete(input.conversationId);
        throw new Error(`底座回复失败 [${event.code}] ${event.message}`);
      }
    }
    if (!finalText) throw new Error("底座未返回内容");
    return { reply: finalText };
  },
});

const skills = new Map<string, SkillDefinition<unknown, unknown>>([
  [echoUpper.id, echoUpper as SkillDefinition<unknown, unknown>],
  [jdDraft.id, jdDraft as SkillDefinition<unknown, unknown>],
  [chat.id, chat as SkillDefinition<unknown, unknown>],
  ...hrLocalSkills.map(
    (skill) => [skill.id, skill] as [string, SkillDefinition<unknown, unknown>],
  ),
]);

const channel = createLineChannel(process.stdin, process.stdout, (msg: RpcMessage) => {
  if (!isRequest(msg)) return;
  void (async () => {
    if (msg.method === "skill.execute") {
      const { skillId, input, grantedPermissions, taskId } = msg.params as {
        skillId: string;
        input: unknown;
        grantedPermissions: string[];
        taskId: string;
      };
      const skill = skills.get(skillId);
      if (!skill) {
        channel.send({
          rpc: RPC_VERSION,
          id: msg.id,
          error: { code: "SKILL_NOT_FOUND", message: `未知技能: ${skillId}`, retryable: false },
        });
        return;
      }
      try {
        const output = await skill.run(input, { taskId, grantedPermissions });
        channel.send({ rpc: RPC_VERSION, id: msg.id, result: output });
      } catch (err) {
        channel.send({
          rpc: RPC_VERSION,
          id: msg.id,
          error: {
            code: "SKILL_EXECUTION_FAILED",
            message: err instanceof Error ? err.message : String(err),
            retryable: false,
          },
        });
      }
    }
  })();
});
