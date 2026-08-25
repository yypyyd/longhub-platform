import { createHash, randomBytes, randomUUID } from "node:crypto";

const ID = /^[A-Za-z0-9._:-]{1,160}$/;

export interface AgentHandoffPreview {
  readonly handoffId: string;
  readonly sourceAgentId: string;
  readonly targetAgentId: string;
  readonly summary: string;
  readonly digest: string;
  readonly expiresAt: string;
  readonly confirmationToken: string;
}

/** 转交只接受用户可见摘要；原始 transcript、memory、权限、确认和工具状态不在类型中。 */
export class AgentHandoffCoordinator {
  private readonly pending = new Map<string, AgentHandoffPreview>();
  constructor(private readonly now: () => number = Date.now) {}

  preview(sourceAgentId: string, targetAgentId: string, summary: string): AgentHandoffPreview {
    if (!ID.test(sourceAgentId) || !ID.test(targetAgentId) || sourceAgentId === targetAgentId) throw new Error("转交 Agent 无效");
    const normalized = summary.trim();
    if (!normalized || normalized.length > 4_000) throw new Error("转交摘要无效");
    const handoffId = randomUUID();
    const confirmationToken = randomBytes(32).toString("base64url");
    const preview: AgentHandoffPreview = {
      handoffId, sourceAgentId, targetAgentId, summary: normalized,
      digest: createHash("sha256").update(`${sourceAgentId}\0${targetAgentId}\0${normalized}`).digest("hex"),
      expiresAt: new Date(this.now() + 5 * 60_000).toISOString(), confirmationToken,
    };
    this.pending.set(handoffId, preview);
    return { ...preview };
  }

  confirm(handoffId: string, targetAgentId: string, confirmationToken: string): {
    targetAgentId: string;
    message: string;
    inheritedPermissions: readonly [];
    inheritedMemory: readonly [];
  } {
    const preview = this.pending.get(handoffId);
    this.pending.delete(handoffId);
    if (!preview || preview.targetAgentId !== targetAgentId || preview.confirmationToken !== confirmationToken ||
      Date.parse(preview.expiresAt) < this.now()) throw new Error("转交确认无效、过期或已使用");
    return {
      targetAgentId,
      message: `用户确认从智能体 ${preview.sourceAgentId} 转交以下摘要：\n\n${preview.summary}`,
      inheritedPermissions: [],
      inheritedMemory: [],
    };
  }

  cancel(handoffId: string): void {
    this.pending.delete(handoffId);
  }
}
