import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  createUserContentSkill,
  exportUserContentSkill,
  importUserContentSkill,
  parseBoundedWorkflow,
  parseUserContentSkill,
  type BoundedWorkflow,
  type UserContentSkill,
  type WorkflowStep,
} from "@longhub/pack-schema";
import type { WorkflowExecutionResult } from "@longhub/core";
import { AgentHandoffCoordinator, type AgentHandoffPreview } from "./agent-handoff.js";
import {
  createNoCodeAgentOverlay,
  parseNoCodeAgentOverlay,
  type NoCodeAgentOverlay,
} from "./nocode-agent-overlay.js";

const ID = /^[A-Za-z0-9._:-]{1,160}$/;

export interface NoCodeWorkspaceAgent {
  readonly agentId: string;
  readonly profileId: string;
  readonly name: string;
}

interface NoCodeWorkspaceState {
  readonly schemaVersion: "longhub/nocode-workspace/v1";
  readonly ownerHash: string;
  readonly contentSkills: readonly UserContentSkill[];
  readonly workflows: readonly BoundedWorkflow[];
  readonly overlays: readonly NoCodeAgentOverlay[];
}

export interface NoCodeWorkspaceSnapshot {
  readonly agents: readonly NoCodeWorkspaceAgent[];
  readonly contentSkills: readonly {
    skillId: string;
    name: string;
    description: string;
    source: UserContentSkill["source"];
  }[];
  readonly workflows: readonly { workflowId: string; name: string; stepCount: number }[];
  readonly overlays: readonly NoCodeAgentOverlay[];
  readonly pendingHandoff?: AgentHandoffPreview;
  readonly completedHandoff?: {
    targetAgentId: string;
    message: string;
    inheritedPermissions: readonly [];
    inheritedMemory: readonly [];
  };
  readonly exportedContent?: { skillId: string; serialized: string };
  readonly lastWorkflowRun?: WorkflowExecutionResult;
}

export type NoCodeWorkspaceAction =
  | { action: "content.create"; name: string; description: string; instructions: string }
  | { action: "content.import"; serialized: string }
  | { action: "content.export"; skillId: string }
  | { action: "openclaw.import" }
  | { action: "workflow.create"; name: string; steps: readonly WorkflowStep[] }
  | { action: "workflow.run"; workflowId: string; agentId: string }
  | {
      action: "agent.create";
      baseProfileId: string;
      targetAgentId: string;
      name: string;
      description: string;
      language: "zh-CN" | "en-US";
      tone: "concise" | "balanced" | "detailed";
      personalEntryIds: readonly string[];
      skillIds: readonly string[];
    }
  | { action: "handoff.preview"; sourceAgentId: string; targetAgentId: string; summary: string }
  | { action: "handoff.confirm"; handoffId: string; targetAgentId: string; confirmationToken: string }
  | { action: "handoff.cancel"; handoffId: string };

function exactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

function countSteps(steps: readonly WorkflowStep[]): number {
  return steps.reduce((total, step) => total + 1 + (
    step.kind === "branch"
      ? countSteps(step.then) + countSteps(step.else)
      : step.kind === "loop" ? countSteps(step.steps) : 0
  ), 0);
}

/**
 * 当前 Windows 用户、当前设备上的无代码工作台。持久状态只含严格数据契约；
 * 执行、OpenClaw 导入和已授权 Skill 查询均由 Main 注入，不能从 Renderer 注入代码或权限。
 */
export class NoCodeWorkspaceService {
  private readonly ownerHash: string;
  private readonly handoffs: AgentHandoffCoordinator;
  private contentSkills: UserContentSkill[];
  private workflows: BoundedWorkflow[];
  private overlays: NoCodeAgentOverlay[];
  private pendingHandoff?: AgentHandoffPreview;
  private completedHandoff?: NoCodeWorkspaceSnapshot["completedHandoff"];
  private exportedContent?: NoCodeWorkspaceSnapshot["exportedContent"];
  private lastWorkflowRun?: WorkflowExecutionResult;

  constructor(private readonly options: {
    stateFile: string;
    owner: string;
    agents: () => readonly NoCodeWorkspaceAgent[];
    personalEntryIds: (agentId: string) => readonly string[];
    authorizedSkillIds: (agentId: string) => readonly string[];
    runWorkflow: (workflow: BoundedWorkflow, agentId: string) => Promise<WorkflowExecutionResult>;
    selectOpenClawContent?: () => Promise<UserContentSkill | undefined>;
    now?: () => number;
  }) {
    if (options.owner.length < 8) throw new Error("无代码工作台 owner 无效");
    this.ownerHash = createHash("sha256").update(options.owner).digest("hex");
    this.handoffs = new AgentHandoffCoordinator(options.now);
    const state = this.load();
    this.contentSkills = state.contentSkills;
    this.workflows = state.workflows;
    this.overlays = state.overlays;
  }

  read(): NoCodeWorkspaceSnapshot {
    const agents = this.options.agents().map((agent) => ({ ...agent }));
    return {
      agents,
      contentSkills: this.contentSkills.map((item) => ({
        skillId: item.skill.id,
        name: item.skill.name,
        description: item.skill.description,
        source: item.source,
      })),
      workflows: this.workflows.map((item) => ({
        workflowId: item.workflowId,
        name: item.name,
        stepCount: countSteps(item.steps),
      })),
      overlays: this.overlays.map((item) => structuredClone(item)),
      ...(this.pendingHandoff ? { pendingHandoff: { ...this.pendingHandoff } } : {}),
      ...(this.completedHandoff ? { completedHandoff: structuredClone(this.completedHandoff) } : {}),
      ...(this.exportedContent ? { exportedContent: { ...this.exportedContent } } : {}),
      ...(this.lastWorkflowRun ? { lastWorkflowRun: structuredClone(this.lastWorkflowRun) } : {}),
    };
  }

  async perform(input: NoCodeWorkspaceAction): Promise<NoCodeWorkspaceSnapshot> {
    this.clearTransient(input.action);
    if (input.action === "content.create") {
      this.contentSkills.push(createUserContentSkill({
        name: input.name,
        description: input.description,
        instructions: input.instructions,
      }));
      this.persist();
    } else if (input.action === "content.import") {
      this.contentSkills.push(importUserContentSkill(input.serialized));
      this.persist();
    } else if (input.action === "content.export") {
      const skill = this.contentSkill(input.skillId);
      this.exportedContent = { skillId: skill.skill.id, serialized: exportUserContentSkill(skill) };
    } else if (input.action === "openclaw.import") {
      if (!this.options.selectOpenClawContent) throw new Error("OpenClaw 内容导入当前不可用");
      const imported = await this.options.selectOpenClawContent();
      if (imported) {
        this.contentSkills.push(parseUserContentSkill(imported));
        this.persist();
      }
    } else if (input.action === "workflow.create") {
      const workflow = parseBoundedWorkflow({
        schemaVersion: "longhub/workflow/v1",
        workflowId: `user.workflow.${randomUUID()}`,
        name: input.name,
        steps: input.steps,
      });
      this.assertWorkflowSkillsExist(workflow);
      this.workflows.push(workflow);
      this.persist();
    } else if (input.action === "workflow.run") {
      this.assertAgent(input.agentId);
      const workflow = this.workflows.find((item) => item.workflowId === input.workflowId);
      if (!workflow) throw new Error("Workflow 不存在");
      const allowed = new Set([
        ...this.options.authorizedSkillIds(input.agentId),
        ...this.contentSkills.map((item) => item.skill.id),
      ]);
      for (const skillId of this.workflowSkillIds(workflow.steps)) {
        if (!allowed.has(skillId)) throw new Error("Workflow Skill 未授权给目标 Agent");
      }
      this.lastWorkflowRun = await this.options.runWorkflow(workflow, input.agentId);
    } else if (input.action === "agent.create") {
      const base = this.options.agents().find((agent) =>
        agent.agentId === input.targetAgentId && agent.profileId === input.baseProfileId);
      if (!base) throw new Error("无代码 Agent 基础签名 Profile 无效");
      const personal = new Set(this.options.personalEntryIds(input.targetAgentId));
      if (input.personalEntryIds.some((id) => !personal.has(id))) throw new Error("无代码 Agent 引用了跨 Agent 个人资料");
      const skills = new Set([
        ...this.options.authorizedSkillIds(input.targetAgentId),
        ...this.contentSkills.map((item) => item.skill.id),
      ]);
      if (input.skillIds.some((id) => !skills.has(id))) throw new Error("无代码 Agent 引用了未授权 Skill");
      this.overlays.push(createNoCodeAgentOverlay({
        baseProfileId: input.baseProfileId,
        targetAgentId: input.targetAgentId,
        name: input.name,
        description: input.description,
        preferences: { language: input.language, tone: input.tone },
        personalEntryIds: [...input.personalEntryIds],
        skillIds: [...input.skillIds],
      }));
      this.persist();
    } else if (input.action === "handoff.preview") {
      this.assertAgent(input.sourceAgentId);
      this.assertAgent(input.targetAgentId);
      this.pendingHandoff = this.handoffs.preview(input.sourceAgentId, input.targetAgentId, input.summary);
    } else if (input.action === "handoff.confirm") {
      this.assertAgent(input.targetAgentId);
      this.completedHandoff = this.handoffs.confirm(input.handoffId, input.targetAgentId, input.confirmationToken);
      this.pendingHandoff = undefined;
    } else {
      this.handoffs.cancel(input.handoffId);
      if (this.pendingHandoff?.handoffId === input.handoffId) this.pendingHandoff = undefined;
    }
    return this.read();
  }

  contentSkillInstructions(skillId: string): string {
    return this.contentSkill(skillId).instructions;
  }

  private clearTransient(action: NoCodeWorkspaceAction["action"]): void {
    if (action !== "content.export") this.exportedContent = undefined;
    if (action !== "workflow.run") this.lastWorkflowRun = undefined;
    if (action !== "handoff.confirm") this.completedHandoff = undefined;
  }

  private assertAgent(agentId: string): void {
    if (!ID.test(agentId) || !this.options.agents().some((agent) => agent.agentId === agentId)) {
      throw new Error("无代码工作台目标 Agent 无效");
    }
  }

  private contentSkill(skillId: string): UserContentSkill {
    const value = this.contentSkills.find((item) => item.skill.id === skillId);
    if (!value) throw new Error("用户 Content Skill 不存在");
    return value;
  }

  private workflowSkillIds(steps: readonly WorkflowStep[]): readonly string[] {
    return steps.flatMap((step): readonly string[] => {
      if (step.kind === "skill") return [step.skillId];
      if (step.kind === "branch") return [...this.workflowSkillIds(step.then), ...this.workflowSkillIds(step.else)];
      if (step.kind === "loop") return this.workflowSkillIds(step.steps);
      return [];
    });
  }

  private assertWorkflowSkillsExist(workflow: BoundedWorkflow): void {
    const known = new Set([
      ...this.options.agents().flatMap((agent) => this.options.authorizedSkillIds(agent.agentId)),
      ...this.contentSkills.map((item) => item.skill.id),
    ]);
    if (this.workflowSkillIds(workflow.steps).some((skillId) => !known.has(skillId))) {
      throw new Error("Workflow 引用了未知或未安装 Skill");
    }
  }

  private load(): { contentSkills: UserContentSkill[]; workflows: BoundedWorkflow[]; overlays: NoCodeAgentOverlay[] } {
    if (!existsSync(this.options.stateFile)) return { contentSkills: [], workflows: [], overlays: [] };
    const stat = lstatSync(this.options.stateFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error("无代码工作台状态无效");
    const state = JSON.parse(readFileSync(this.options.stateFile, "utf8")) as NoCodeWorkspaceState;
    if (!exactKeys(state, ["schemaVersion", "ownerHash", "contentSkills", "workflows", "overlays"]) ||
      state.schemaVersion !== "longhub/nocode-workspace/v1" || state.ownerHash !== this.ownerHash ||
      !Array.isArray(state.contentSkills) || !Array.isArray(state.workflows) || !Array.isArray(state.overlays) ||
      state.contentSkills.length > 256 || state.workflows.length > 256 || state.overlays.length > 256) {
      throw new Error("无代码工作台 owner 或格式无效");
    }
    return {
      contentSkills: state.contentSkills.map(parseUserContentSkill),
      workflows: state.workflows.map(parseBoundedWorkflow),
      overlays: state.overlays.map(parseNoCodeAgentOverlay),
    };
  }

  private persist(): void {
    mkdirSync(dirname(this.options.stateFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.options.stateFile}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({
      schemaVersion: "longhub/nocode-workspace/v1",
      ownerHash: this.ownerHash,
      contentSkills: this.contentSkills,
      workflows: this.workflows,
      overlays: this.overlays,
    }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.options.stateFile);
  }
}
