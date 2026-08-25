import type { AgentKnowledgeClient, AgentKnowledgeCitation } from "./knowledge-client.js";
import type { LocalPersonalProfileStore, PersonalProfileEntry } from "./local-personal-profile.js";
import type { RecoverableSessionTrash, SessionManagementService, ManagedSession, SessionExport } from "./session-management.js";

export interface UserDataAgent {
  readonly agentId: string;
  readonly name: string;
}

export interface UserDataCenterSnapshot {
  readonly agents: readonly UserDataAgent[];
  readonly selectedAgentId?: string;
  readonly sessions: readonly ManagedSession[];
  readonly trashedSessions: readonly { key: string; deleteAfter: string }[];
  readonly personalEntries: readonly Omit<PersonalProfileEntry, "content">[];
  readonly citations: readonly AgentKnowledgeCitation[];
  readonly attachments: readonly { filename: string; kind: string; text: string; truncated: boolean }[];
  readonly attachmentSessionId?: string;
  readonly searchQuery: string;
  readonly lastExport?: SessionExport;
  readonly pendingPermanentDelete?: { key: string; confirmation: string };
}

export type UserDataCenterAction =
  | { action: "session.rename"; agentId: string; key: string; label: string }
  | { action: "session.archive"; agentId: string; key: string; archived: boolean }
  | { action: "session.pin"; agentId: string; key: string; pinned: boolean }
  | { action: "session.search"; agentId: string; query: string }
  | { action: "session.export"; agentId: string; key: string }
  | { action: "session.trash"; agentId: string; key: string }
  | { action: "session.restore"; agentId: string; key: string }
  | { action: "session.delete.request"; agentId: string; key: string }
  | { action: "session.delete.confirm"; agentId: string; key: string; confirmation: string }
  | { action: "profile.add"; agentId: string; title: string; content: string }
  | { action: "profile.trash"; agentId: string; entryId: string }
  | { action: "profile.restore"; agentId: string; entryId: string }
  | { action: "knowledge.query"; agentId: string; query: string }
  | { action: "file.select"; agentId: string; sessionId: string }
  | { action: "file.send"; agentId: string; sessionId: string };

/** “我的”入口的应用服务；所有动作显式带 Agent，且返回值不包含个人资料正文。 */
export class UserDataCenterService {
  private citations: readonly AgentKnowledgeCitation[] = [];
  private attachments?: { agentId: string; sessionId: string; values: UserDataCenterSnapshot["attachments"] };
  private readonly searchQueries = new Map<string, string>();
  private lastExport?: { agentId: string; value: SessionExport };
  private pendingPermanentDelete?: { agentId: string; key: string; confirmation: string };

  constructor(private readonly options: {
    agents: () => readonly UserDataAgent[];
    sessions: Pick<SessionManagementService, "list" | "rename" | "setArchived" | "setPinned" | "export" | "sendMessage">;
    trash: Pick<RecoverableSessionTrash, "list" | "trash" | "restore" | "requestPermanentDelete" | "permanentlyDelete">;
    personal: Pick<LocalPersonalProfileStore, "list" | "add" | "trash" | "restore">;
    knowledge: Pick<AgentKnowledgeClient, "query">;
    attachments?: {
      selectAndParse(agentId: string, sessionId: string): Promise<UserDataCenterSnapshot["attachments"]>;
    };
  }) {}

  async read(agentId?: string): Promise<UserDataCenterSnapshot> {
    const agents = this.options.agents().map((agent) => ({ ...agent }));
    const selected = agentId ?? agents[0]?.agentId;
    if (!selected) return { agents, sessions: [], trashedSessions: [], personalEntries: [], citations: [], attachments: [], searchQuery: "" };
    if (!agents.some((agent) => agent.agentId === selected)) throw new Error("数据中心目标 Agent 无效");
    const searchQuery = this.searchQueries.get(selected) ?? "";
    const sessions = await this.options.sessions.list(selected, { limit: 100, ...(searchQuery ? { search: searchQuery } : {}) });
    return {
      agents,
      selectedAgentId: selected,
      sessions,
      trashedSessions: this.options.trash.list(selected).map((item) => ({ key: item.key, deleteAfter: item.deleteAfter })),
      personalEntries: this.options.personal.list(selected, true).map(({ content: _hidden, ...entry }) => ({ ...entry })),
      citations: this.citations.filter((citation) => citation.agentId === selected).map((citation) => ({ ...citation })),
      attachments: this.attachments?.agentId === selected
        ? this.attachments.values.map((attachment) => ({ ...attachment }))
        : [],
      ...(this.attachments?.agentId === selected ? { attachmentSessionId: this.attachments.sessionId } : {}),
      searchQuery,
      ...(this.lastExport?.agentId === selected ? { lastExport: structuredClone(this.lastExport.value) } : {}),
      ...(this.pendingPermanentDelete?.agentId === selected
        ? { pendingPermanentDelete: { key: this.pendingPermanentDelete.key, confirmation: this.pendingPermanentDelete.confirmation } }
        : {}),
    };
  }

  async perform(input: UserDataCenterAction): Promise<UserDataCenterSnapshot> {
    this.assertAgent(input.agentId);
    if (input.action === "session.rename") await this.options.sessions.rename(input.agentId, input.key, input.label);
    else if (input.action === "session.archive") await this.options.sessions.setArchived(input.agentId, input.key, input.archived);
    else if (input.action === "session.pin") await this.options.sessions.setPinned(input.agentId, input.key, input.pinned);
    else if (input.action === "session.search") this.searchQueries.set(input.agentId, input.query.trim());
    else if (input.action === "session.export") this.lastExport = { agentId: input.agentId, value: await this.options.sessions.export(input.agentId, input.key) };
    else if (input.action === "session.trash") await this.options.trash.trash(input.agentId, input.key);
    else if (input.action === "session.restore") await this.options.trash.restore(input.agentId, input.key);
    else if (input.action === "session.delete.request") {
      this.pendingPermanentDelete = { agentId: input.agentId, key: input.key, confirmation: this.options.trash.requestPermanentDelete(input.agentId, input.key) };
    } else if (input.action === "session.delete.confirm") {
      await this.options.trash.permanentlyDelete(input.agentId, input.key, input.confirmation);
      this.pendingPermanentDelete = undefined;
    }
    else if (input.action === "profile.add") this.options.personal.add(input.agentId, input.title, input.content);
    else if (input.action === "profile.trash") this.options.personal.trash(input.agentId, input.entryId);
    else if (input.action === "profile.restore") this.options.personal.restore(input.agentId, input.entryId);
    else if (input.action === "knowledge.query") this.citations = await this.options.knowledge.query(input.agentId, input.query);
    else if (input.action === "file.select") {
      if (!this.options.attachments) throw new Error("附件能力当前不可用");
      this.attachments = {
        agentId: input.agentId,
        sessionId: input.sessionId,
        values: await this.options.attachments.selectAndParse(input.agentId, input.sessionId),
      };
    } else {
      const attachment = this.attachments;
      if (!attachment || attachment.agentId !== input.agentId || attachment.sessionId !== input.sessionId || attachment.values.length === 0) {
        throw new Error("附件预览不存在或不属于目标 Agent/会话");
      }
      const message = [
        "请处理以下由龙枢隔离解析的本机附件内容：",
        ...attachment.values.map((item) => `\n## ${item.filename} (${item.kind}${item.truncated ? "，已截断" : ""})\n${item.text}`),
      ].join("\n");
      await this.options.sessions.sendMessage(input.agentId, input.sessionId, message);
      this.attachments = undefined;
    }
    return this.read(input.agentId);
  }

  private assertAgent(agentId: string): void {
    if (!this.options.agents().some((agent) => agent.agentId === agentId)) throw new Error("数据中心目标 Agent 无效");
  }
}
