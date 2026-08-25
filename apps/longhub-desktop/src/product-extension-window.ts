import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { BrowserWindow, ipcMain, protocol } from "electron";
import {
  PRODUCT_EXTENSION_SURFACE_CONTRACT,
  PRODUCT_EXTENSION_SURFACE_SCHEMA,
  PRODUCT_EXTENSION_AGENT_ACTIONS,
  PRODUCT_EXTENSION_SKILL_ACTIONS,
  PRODUCT_EXTENSION_ACCOUNT_ACTIONS,
  isAllowedProductExtensionNavigation,
  parseProductExtensionActionRequest,
  parseProductExtensionSkillActionRequest,
  productExtensionRoute,
  type ProductExtensionAction,
  type ProductExtensionEntryId,
  type ProductExtensionRouteId,
  type ProductExtensionSkillAction,
  type ProductExtensionAgentAction,
  type ProductExtensionAccountAction,
} from "@longhub/openclaw-compat";
import {
  parseBridgeConfirmationRequest,
  type BridgeConfirmationRequest,
} from "@longhub/core";
import type { SkillCenterService, SkillCenterSnapshot } from "./skill-center-service.js";
import type { UserDataCenterService, UserDataCenterSnapshot } from "./user-data-center-service.js";
import type { NoCodeWorkspaceService, NoCodeWorkspaceSnapshot } from "./nocode-workspace-service.js";
import type {
  AgentManagementAction,
  AgentManagementService,
  AgentManagementSnapshot,
} from "./agent-management-service.js";

const SCHEME = "longhub-product";
let schemeRegistered = false;

export function registerProductExtensionScheme(): void {
  if (schemeRegistered) return;
  protocol.registerSchemesAsPrivileged([{
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: false,
      corsEnabled: false,
      stream: true,
    },
  }]);
  schemeRegistered = true;
}

export interface ProductExtensionWindowContext {
  readonly schema_version: typeof PRODUCT_EXTENSION_SURFACE_SCHEMA;
  readonly entry: ProductExtensionEntryId;
  readonly title: string;
}

export interface ProductExtensionWindowCoordinatorOptions {
  readonly assetsDir: string;
  readonly preloadPath: string;
  readonly iconPath: string;
  readonly parentWindow?: () => BrowserWindow | undefined;
  readonly isEntryAllowed: (entry: ProductExtensionEntryId) => boolean;
  readonly onDenied?: (entry: ProductExtensionEntryId) => void;
  readonly respondConfirmation?: (
    request: BridgeConfirmationRequest,
    approved: boolean,
  ) => Promise<void>;
  readonly skillCenter?: Pick<SkillCenterService, "read" | "perform">;
  readonly dataCenter?: Pick<UserDataCenterService, "read" | "perform">;
  readonly noCodeCenter?: Pick<NoCodeWorkspaceService, "read" | "perform">;
  readonly agentCenter?: Pick<AgentManagementService, "read" | "perform">;
}

export interface ProductAgentsSnapshot {
  readonly management: AgentManagementSnapshot;
  readonly workspace: NoCodeWorkspaceSnapshot;
}

type WindowSession = {
  readonly windowId: string;
  readonly entry: ProductExtensionRouteId;
  readonly window: BrowserWindow;
  readonly nonces: Map<ProductExtensionAction, string>;
  readonly confirmation?: BridgeConfirmationRequest;
  expiryTimer?: NodeJS.Timeout;
  responded: boolean;
  parent?: BrowserWindow;
  alignWithParent?: () => void;
};

const TITLES: Readonly<Record<ProductExtensionRouteId, string>> = {
  agents: "智能体",
  skills: "能力",
  account: "我的",
  confirmations: "操作确认",
};

const STATIC_ASSETS: Readonly<Record<string, { file: string; contentType: string }>> = {
  "/product-extension.css": { file: "product-extension.css", contentType: "text/css; charset=utf-8" },
  "/product-extension.js": { file: "product-extension.js", contentType: "text/javascript; charset=utf-8" },
  "/longhub-avatar.png": { file: "longhub-avatar.png", contentType: "image/png" },
};

export class ProductExtensionWindowCoordinator {
  private readonly sessions = new Map<number, WindowSession>();
  private started = false;

  constructor(private readonly options: ProductExtensionWindowCoordinatorOptions) {
    if (!isAbsolute(options.assetsDir) || !isAbsolute(options.preloadPath) || !isAbsolute(options.iconPath)) {
      throw new Error("产品扩展资源必须使用绝对路径");
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    await protocol.handle(SCHEME, (request) => this.serve(request));
    ipcMain.handle(
      PRODUCT_EXTENSION_SURFACE_CONTRACT.ipc.channels.contextRead,
      (event, input: unknown) => this.handleContextRead(event.sender.id, event.sender.getURL(), input),
    );
    ipcMain.handle(
      PRODUCT_EXTENSION_SURFACE_CONTRACT.ipc.channels.confirmationRead,
      (event, input: unknown) => this.handleConfirmationRead(event.sender.id, event.sender.getURL(), input),
    );
    ipcMain.handle(
      PRODUCT_EXTENSION_SURFACE_CONTRACT.ipc.channels.confirmationApprove,
      (event, input: unknown) =>
        this.handleConfirmationResponse(event.sender.id, event.sender.getURL(), input, true),
    );
    ipcMain.handle(
      PRODUCT_EXTENSION_SURFACE_CONTRACT.ipc.channels.confirmationDeny,
      (event, input: unknown) =>
        this.handleConfirmationResponse(event.sender.id, event.sender.getURL(), input, false),
    );
    ipcMain.handle(
      PRODUCT_EXTENSION_SURFACE_CONTRACT.ipc.channels.agentsRead,
      (event, input: unknown) => this.handleAgentsRead(event.sender.id, event.sender.getURL(), input),
    );
    ipcMain.handle(
      PRODUCT_EXTENSION_SURFACE_CONTRACT.ipc.channels.agentsAction,
      (event, input: unknown) => this.handleAgentAction(event.sender.id, event.sender.getURL(), input),
    );
    ipcMain.handle(
      PRODUCT_EXTENSION_SURFACE_CONTRACT.ipc.channels.skillsRead,
      (event, input: unknown) => this.handleSkillsRead(event.sender.id, event.sender.getURL(), input),
    );
    ipcMain.handle(
      PRODUCT_EXTENSION_SURFACE_CONTRACT.ipc.channels.skillsAction,
      (event, input: unknown) => this.handleSkillAction(event.sender.id, event.sender.getURL(), input),
    );
    ipcMain.handle(
      PRODUCT_EXTENSION_SURFACE_CONTRACT.ipc.channels.accountRead,
      (event, input: unknown) => this.handleAccountRead(event.sender.id, event.sender.getURL(), input),
    );
    ipcMain.handle(
      PRODUCT_EXTENSION_SURFACE_CONTRACT.ipc.channels.accountAction,
      (event, input: unknown) => this.handleAccountAction(event.sender.id, event.sender.getURL(), input),
    );
    ipcMain.handle(
      PRODUCT_EXTENSION_SURFACE_CONTRACT.ipc.channels.windowClose,
      (event, input: unknown) => this.handleWindowClose(event.sender.id, event.sender.getURL(), input),
    );
    this.started = true;
  }

  async open(entry: ProductExtensionEntryId): Promise<boolean> {
    if (!this.started) throw new Error("产品扩展窗口协调器尚未启动");
    if (!this.options.isEntryAllowed(entry)) {
      this.options.onDenied?.(entry);
      return false;
    }
    return this.openRoute(entry);
  }

  async openConfirmation(input: BridgeConfirmationRequest): Promise<boolean> {
    if (!this.started) throw new Error("产品扩展窗口协调器尚未启动");
    const request = parseBridgeConfirmationRequest(input);
    const expiresAt = Date.parse(request.expiresAt);
    const now = Date.now();
    if (expiresAt <= now || expiresAt - now > 5 * 60_000) {
      return false;
    }
    const active = [...this.sessions.values()].find(
      (session) => session.entry === "confirmations" && !session.window.isDestroyed(),
    );
    if (active && active.confirmation?.confirmationId !== request.confirmationId) return false;
    return this.openRoute("confirmations", request);
  }

  private async openRoute(
    entry: ProductExtensionRouteId,
    confirmation?: BridgeConfirmationRequest,
  ): Promise<boolean> {
    const existing = [...this.sessions.values()].find(
      (session) => session.entry === entry && !session.window.isDestroyed(),
    );
    if (existing) {
      existing.window.show();
      existing.window.focus();
      return true;
    }
    const staleSessions = entry === "confirmations"
      ? []
      : [...this.sessions.values()].filter((session) =>
          session.entry !== "confirmations" && session.entry !== entry && !session.window.isDestroyed());
    const windowId = randomUUID();
    const contextNonce = randomBytes(PRODUCT_EXTENSION_SURFACE_CONTRACT.ipc.nonceBytes)
      .toString("base64url");
    const closeNonce = randomBytes(PRODUCT_EXTENSION_SURFACE_CONTRACT.ipc.nonceBytes)
      .toString("base64url");
    const confirmationReadNonce = randomBytes(PRODUCT_EXTENSION_SURFACE_CONTRACT.ipc.nonceBytes)
      .toString("base64url");
    const confirmationApproveNonce = randomBytes(PRODUCT_EXTENSION_SURFACE_CONTRACT.ipc.nonceBytes)
      .toString("base64url");
    const confirmationDenyNonce = randomBytes(PRODUCT_EXTENSION_SURFACE_CONTRACT.ipc.nonceBytes)
      .toString("base64url");
    const skillsReadNonce = randomBytes(PRODUCT_EXTENSION_SURFACE_CONTRACT.ipc.nonceBytes).toString("base64url");
    const agentsReadNonce = randomBytes(PRODUCT_EXTENSION_SURFACE_CONTRACT.ipc.nonceBytes).toString("base64url");
    const accountReadNonce = randomBytes(PRODUCT_EXTENSION_SURFACE_CONTRACT.ipc.nonceBytes).toString("base64url");
    const skillActionNonces = new Map<ProductExtensionSkillAction, string>(
      PRODUCT_EXTENSION_SKILL_ACTIONS.map((action) => [
        action,
        randomBytes(PRODUCT_EXTENSION_SURFACE_CONTRACT.ipc.nonceBytes).toString("base64url"),
      ]),
    );
    const agentActionNonces = new Map<ProductExtensionAgentAction, string>(
      PRODUCT_EXTENSION_AGENT_ACTIONS.map((action) => [
        action,
        randomBytes(PRODUCT_EXTENSION_SURFACE_CONTRACT.ipc.nonceBytes).toString("base64url"),
      ]),
    );
    const accountActionNonces = new Map<ProductExtensionAccountAction, string>(
      PRODUCT_EXTENSION_ACCOUNT_ACTIONS.map((action) => [
        action,
        randomBytes(PRODUCT_EXTENSION_SURFACE_CONTRACT.ipc.nonceBytes).toString("base64url"),
      ]),
    );
    const contractWindow = PRODUCT_EXTENSION_SURFACE_CONTRACT.window;
    const parent = this.options.parentWindow?.();
    const extensionWindow = new BrowserWindow({
      width: contractWindow.width,
      height: contractWindow.height,
      minWidth: contractWindow.minWidth,
      minHeight: contractWindow.minHeight,
      title: TITLES[entry] + " - 龙枢",
      icon: this.options.iconPath,
      show: false,
      frame: false,
      skipTaskbar: true,
      backgroundColor: "#f8f6f3",
      ...(parent && !parent.isDestroyed() ? { parent } : {}),
      webPreferences: {
        ...contractWindow.webPreferences,
        preload: this.options.preloadPath,
        additionalArguments: [
          "--longhub-extension-window-id=" + windowId,
          "--longhub-extension-entry=" + entry,
          "--longhub-extension-context-nonce=" + contextNonce,
          "--longhub-extension-close-nonce=" + closeNonce,
          "--longhub-extension-confirmation-read-nonce=" + confirmationReadNonce,
          "--longhub-extension-confirmation-approve-nonce=" + confirmationApproveNonce,
          "--longhub-extension-confirmation-deny-nonce=" + confirmationDenyNonce,
          "--longhub-extension-skills-read-nonce=" + skillsReadNonce,
          "--longhub-extension-agents-read-nonce=" + agentsReadNonce,
          "--longhub-extension-account-read-nonce=" + accountReadNonce,
          ...[...skillActionNonces].map(([action, nonce]) =>
            `--longhub-extension-${action.replace(".", "-")}-nonce=${nonce}`),
          ...[...agentActionNonces].map(([action, nonce]) =>
            `--longhub-extension-${action.replaceAll(".", "-")}-nonce=${nonce}`),
          ...[...accountActionNonces].map(([action, nonce]) =>
            `--longhub-extension-${action.replaceAll(".", "-")}-nonce=${nonce}`),
        ],
      },
    });
    let alignWithParent: (() => void) | undefined;
    if (parent && !parent.isDestroyed()) {
      alignWithParent = () => {
        if (parent.isDestroyed() || extensionWindow.isDestroyed()) return;
        const bounds = parent.getContentBounds();
        const width = Math.min(contractWindow.width, Math.max(contractWindow.minWidth, bounds.width - 300));
        extensionWindow.setBounds({
          x: bounds.x + bounds.width - width,
          y: bounds.y,
          width,
          height: bounds.height,
        });
      };
      alignWithParent();
      parent.on("move", alignWithParent);
      parent.on("resize", alignWithParent);
    }
    extensionWindow.removeMenu();
    const session: WindowSession = {
      windowId,
      entry,
      window: extensionWindow,
      nonces: new Map([
        ["context.read", contextNonce],
        ["window.close", closeNonce],
        ["confirmation.read", confirmationReadNonce],
        ["confirmation.approve", confirmationApproveNonce],
        ["confirmation.deny", confirmationDenyNonce],
        ["skills.read", skillsReadNonce],
        ["agents.read", agentsReadNonce],
        ...agentActionNonces,
        ["account.read", accountReadNonce],
        ...skillActionNonces,
        ...accountActionNonces,
      ]),
      ...(confirmation ? { confirmation } : {}),
      responded: false,
      ...(parent && !parent.isDestroyed() ? { parent } : {}),
      ...(alignWithParent ? { alignWithParent } : {}),
    };
    const webContentsId = extensionWindow.webContents.id;
    this.sessions.set(webContentsId, session);
    extensionWindow.webContents.on("will-navigate", (event, target) => {
      if (!isAllowedProductExtensionNavigation(target) || target !== productExtensionRoute(entry)) {
        event.preventDefault();
      }
    });
    extensionWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    extensionWindow.once("ready-to-show", () => extensionWindow.show());
    extensionWindow.on("closed", () => {
      if (session.parent && session.alignWithParent && !session.parent.isDestroyed()) {
        session.parent.off("move", session.alignWithParent);
        session.parent.off("resize", session.alignWithParent);
      }
      this.sessions.delete(webContentsId);
      if (session.expiryTimer) clearTimeout(session.expiryTimer);
      if (session.confirmation && !session.responded) {
        session.responded = true;
        void this.options.respondConfirmation?.(session.confirmation, false).catch(() => undefined);
      }
    });
    if (confirmation) {
      session.expiryTimer = setTimeout(() => {
        if (!extensionWindow.isDestroyed()) extensionWindow.close();
      }, Math.max(1, Date.parse(confirmation.expiresAt) - Date.now()));
      session.expiryTimer.unref();
    }
    await extensionWindow.loadURL(productExtensionRoute(entry));
    for (const stale of staleSessions) {
      if (!stale.window.isDestroyed()) stale.window.close();
    }
    return true;
  }

  closeDisabledEntries(): void {
    for (const session of this.sessions.values()) {
      if (
        session.entry !== "confirmations"
        && !this.options.isEntryAllowed(session.entry)
      ) session.window.close();
    }
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      if (!session.window.isDestroyed()) session.window.destroy();
    }
    this.sessions.clear();
    if (this.started) {
      ipcMain.removeHandler(PRODUCT_EXTENSION_SURFACE_CONTRACT.ipc.channels.contextRead);
      ipcMain.removeHandler(PRODUCT_EXTENSION_SURFACE_CONTRACT.ipc.channels.windowClose);
      ipcMain.removeHandler(PRODUCT_EXTENSION_SURFACE_CONTRACT.ipc.channels.confirmationRead);
      ipcMain.removeHandler(PRODUCT_EXTENSION_SURFACE_CONTRACT.ipc.channels.confirmationApprove);
      ipcMain.removeHandler(PRODUCT_EXTENSION_SURFACE_CONTRACT.ipc.channels.confirmationDeny);
      ipcMain.removeHandler(PRODUCT_EXTENSION_SURFACE_CONTRACT.ipc.channels.skillsRead);
      ipcMain.removeHandler(PRODUCT_EXTENSION_SURFACE_CONTRACT.ipc.channels.skillsAction);
      ipcMain.removeHandler(PRODUCT_EXTENSION_SURFACE_CONTRACT.ipc.channels.agentsRead);
      ipcMain.removeHandler(PRODUCT_EXTENSION_SURFACE_CONTRACT.ipc.channels.agentsAction);
      ipcMain.removeHandler(PRODUCT_EXTENSION_SURFACE_CONTRACT.ipc.channels.accountRead);
      ipcMain.removeHandler(PRODUCT_EXTENSION_SURFACE_CONTRACT.ipc.channels.accountAction);
      protocol.unhandle(SCHEME);
    }
    this.started = false;
  }

  private consumeNonce(
    session: WindowSession,
    action: ProductExtensionAction,
    nonce: string,
  ): boolean {
    if (session.nonces.get(action) !== nonce) return false;
    session.nonces.delete(action);
    return true;
  }

  private validate(
    senderId: number,
    senderUrl: string,
    action: ProductExtensionAction,
    input: unknown,
  ): WindowSession {
    const session = this.sessions.get(senderId);
    if (
      !session
      || senderUrl !== productExtensionRoute(session.entry)
      || !isAllowedProductExtensionNavigation(senderUrl)
    ) {
      throw new Error("产品扩展 IPC 来源无效");
    }
    parseProductExtensionActionRequest(input, {
      windowId: session.windowId,
      entry: session.entry,
      action,
      consumeNonce: (nonce) => this.consumeNonce(session, action, nonce),
    });
    return session;
  }

  private handleContextRead(senderId: number, senderUrl: string, input: unknown): ProductExtensionWindowContext {
    const session = this.validate(senderId, senderUrl, "context.read", input);
    if (session.entry === "confirmations") throw new Error("确认窗口不能读取普通入口上下文");
    if (!this.options.isEntryAllowed(session.entry)) {
      session.window.close();
      throw new Error("产品扩展功能已停用");
    }
    return {
      schema_version: PRODUCT_EXTENSION_SURFACE_SCHEMA,
      entry: session.entry,
      title: TITLES[session.entry],
    };
  }

  private handleWindowClose(senderId: number, senderUrl: string, input: unknown): true {
    const session = this.validate(senderId, senderUrl, "window.close", input);
    if (session.confirmation && !session.responded) {
      session.responded = true;
      void this.options.respondConfirmation?.(session.confirmation, false).catch(() => undefined);
    }
    setImmediate(() => {
      if (!session.window.isDestroyed()) session.window.close();
    });
    return true;
  }

  private handleConfirmationRead(senderId: number, senderUrl: string, input: unknown) {
    const session = this.validate(senderId, senderUrl, "confirmation.read", input);
    if (!session.confirmation) throw new Error("当前窗口没有确认请求");
    const request = session.confirmation;
    return {
      confirmationId: request.confirmationId,
      skillId: request.skillId,
      agentId: request.agentId,
      profileVersion: request.profileVersion,
      permissions: [...request.permissions],
      display: { ...request.display, dataScope: [...request.display.dataScope] },
      expiresAt: request.expiresAt,
    };
  }

  private handleSkillsRead(senderId: number, senderUrl: string, input: unknown): Promise<SkillCenterSnapshot> {
    const session = this.validate(senderId, senderUrl, "skills.read", input);
    if (session.entry !== "skills" || !this.options.isEntryAllowed("skills") || !this.options.skillCenter) {
      throw new Error("能力中心当前不可用");
    }
    return this.options.skillCenter.read();
  }

  private handleAgentsRead(senderId: number, senderUrl: string, input: unknown): ProductAgentsSnapshot {
    const session = this.validate(senderId, senderUrl, "agents.read", input);
    if (session.entry !== "agents" || !this.options.isEntryAllowed("agents") ||
      !this.options.noCodeCenter || !this.options.agentCenter) {
      throw new Error("智能体中心当前不可用");
    }
    return {
      management: this.options.agentCenter.read(),
      workspace: this.options.noCodeCenter.read(),
    };
  }

  private async handleAgentAction(senderId: number, senderUrl: string, input: unknown): Promise<ProductAgentsSnapshot> {
    const session = this.sessions.get(senderId);
    if (!session || session.entry !== "agents" || senderUrl !== productExtensionRoute("agents") ||
      !isAllowedProductExtensionNavigation(senderUrl) || !this.options.isEntryAllowed("agents") ||
      !input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("智能体中心 IPC 来源或策略无效");
    }
    const raw = input as Record<string, unknown>;
    const action = raw.action;
    if (typeof action !== "string" || !(PRODUCT_EXTENSION_AGENT_ACTIONS as readonly string[]).includes(action) ||
      !raw.payload || typeof raw.payload !== "object" || Array.isArray(raw.payload)) throw new Error("无代码工作台动作无效");
    const payload = raw.payload as Record<string, unknown>;
    const base = { ...raw };
    delete base.payload;
    parseProductExtensionActionRequest(base, {
      windowId: session.windowId,
      entry: "agents",
      action: action as ProductExtensionAgentAction,
      consumeNonce: (nonce) => this.consumeNonce(session, action as ProductExtensionAgentAction, nonce),
    });
    if (["agents.select", "agents.install", "agents.enable", "agents.disable"].includes(action)) {
      if (!this.options.agentCenter || !this.options.noCodeCenter) throw new Error("智能体中心当前不可用");
      const key = action === "agents.select" ? "agentId" : "packId";
      if (Object.keys(payload).sort().join("|") !== key || typeof payload[key] !== "string") {
        throw new Error("智能体管理动作字段无效");
      }
      const managementAction: AgentManagementAction = action === "agents.select"
        ? { action: "select", agentId: payload.agentId as string }
        : { action: action.slice("agents.".length) as "install" | "enable" | "disable", packId: payload.packId as string };
      const management = await this.options.agentCenter.perform(managementAction);
      return { management, workspace: this.options.noCodeCenter.read() };
    }
    if (!this.options.noCodeCenter || !this.options.agentCenter) throw new Error("创建与编排当前不可用");
    const text = (key: string, max = 512, allowEmpty = false): string => {
      const value = payload[key];
      if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > max) {
        throw new Error("无代码工作台动作字段无效");
      }
      return value;
    };
    const exact = (keys: readonly string[]): void => {
      if (Object.keys(payload).sort().join("|") !== [...keys].sort().join("|")) throw new Error("无代码工作台动作字段无效");
    };
    const withWorkspace = async (promise: Promise<NoCodeWorkspaceSnapshot>): Promise<ProductAgentsSnapshot> => ({
      management: this.options.agentCenter!.read(),
      workspace: await promise,
    });
    if (action === "agents.content.create") {
      exact(["name", "description", "instructions"]);
      return withWorkspace(this.options.noCodeCenter.perform({ action: "content.create", name: text("name", 80), description: text("description", 500, true), instructions: text("instructions", 262_144) }));
    }
    if (action === "agents.content.import") {
      exact(["serialized"]);
      return withWorkspace(this.options.noCodeCenter.perform({ action: "content.import", serialized: text("serialized", 524_288) }));
    }
    if (action === "agents.content.export") {
      exact(["skillId"]);
      return withWorkspace(this.options.noCodeCenter.perform({ action: "content.export", skillId: text("skillId", 160) }));
    }
    if (action === "agents.openclaw.import") {
      exact([]);
      return withWorkspace(this.options.noCodeCenter.perform({ action: "openclaw.import" }));
    }
    if (action === "agents.workflow.create") {
      exact(["name", "steps"]);
      if (!Array.isArray(payload.steps)) throw new Error("Workflow 步骤字段无效");
      return withWorkspace(this.options.noCodeCenter.perform({ action: "workflow.create", name: text("name", 80), steps: payload.steps as never[] }));
    }
    if (action === "agents.workflow.run") {
      exact(["workflowId", "agentId"]);
      return withWorkspace(this.options.noCodeCenter.perform({ action: "workflow.run", workflowId: text("workflowId", 160), agentId: text("agentId", 160) }));
    }
    if (action === "agents.overlay.create") {
      exact(["baseProfileId", "targetAgentId", "name", "description", "language", "tone", "personalEntryIds", "skillIds"]);
      if (!Array.isArray(payload.personalEntryIds) || !Array.isArray(payload.skillIds) ||
        payload.personalEntryIds.some((value) => typeof value !== "string") || payload.skillIds.some((value) => typeof value !== "string") ||
        !["zh-CN", "en-US"].includes(String(payload.language)) || !["concise", "balanced", "detailed"].includes(String(payload.tone))) {
        throw new Error("无代码 Agent 字段无效");
      }
      return withWorkspace(this.options.noCodeCenter.perform({
        action: "agent.create", baseProfileId: text("baseProfileId", 160), targetAgentId: text("targetAgentId", 160),
        name: text("name", 80), description: text("description", 500, true),
        language: payload.language as "zh-CN" | "en-US", tone: payload.tone as "concise" | "balanced" | "detailed",
        personalEntryIds: payload.personalEntryIds as string[], skillIds: payload.skillIds as string[],
      }));
    }
    if (action === "agents.handoff.preview") {
      exact(["sourceAgentId", "targetAgentId", "summary"]);
      return withWorkspace(this.options.noCodeCenter.perform({ action: "handoff.preview", sourceAgentId: text("sourceAgentId", 160), targetAgentId: text("targetAgentId", 160), summary: text("summary", 4_000) }));
    }
    if (action === "agents.handoff.confirm") {
      exact(["handoffId", "targetAgentId", "confirmationToken"]);
      return withWorkspace(this.options.noCodeCenter.perform({ action: "handoff.confirm", handoffId: text("handoffId", 160), targetAgentId: text("targetAgentId", 160), confirmationToken: text("confirmationToken", 160) }));
    }
    exact(["handoffId"]);
    return withWorkspace(this.options.noCodeCenter.perform({ action: "handoff.cancel", handoffId: text("handoffId", 160) }));
  }

  private handleSkillAction(senderId: number, senderUrl: string, input: unknown): Promise<SkillCenterSnapshot> {
    const session = this.sessions.get(senderId);
    if (!session || session.entry !== "skills" || senderUrl !== productExtensionRoute("skills") ||
      !isAllowedProductExtensionNavigation(senderUrl) || !this.options.isEntryAllowed("skills") ||
      !this.options.skillCenter) {
      throw new Error("能力中心 IPC 来源或策略无效");
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("能力动作无效");
    const action = (input as { action?: unknown }).action;
    if (typeof action !== "string" || !(PRODUCT_EXTENSION_SKILL_ACTIONS as readonly string[]).includes(action)) {
      throw new Error("能力动作不在白名单");
    }
    const request = parseProductExtensionSkillActionRequest(input, {
      windowId: session.windowId,
      entry: "skills",
      action: action as ProductExtensionSkillAction,
      consumeNonce: (nonce) => this.consumeNonce(session, action as ProductExtensionSkillAction, nonce),
    });
    return this.options.skillCenter.perform({
      action: request.action.slice("skills.".length) as Parameters<SkillCenterService["perform"]>[0]["action"],
      skillId: request.payload.skillId,
      ...(request.payload.agentId ? { agentId: request.payload.agentId } : {}),
    });
  }

  private handleAccountRead(senderId: number, senderUrl: string, input: unknown): Promise<UserDataCenterSnapshot> {
    const session = this.validate(senderId, senderUrl, "account.read", input);
    if (session.entry !== "account" || !this.options.isEntryAllowed("account") || !this.options.dataCenter) {
      throw new Error("用户数据中心当前不可用");
    }
    return this.options.dataCenter.read();
  }

  private handleAccountAction(senderId: number, senderUrl: string, input: unknown): Promise<UserDataCenterSnapshot> {
    const session = this.sessions.get(senderId);
    if (!session || session.entry !== "account" || senderUrl !== productExtensionRoute("account") ||
      !isAllowedProductExtensionNavigation(senderUrl) || !this.options.isEntryAllowed("account") ||
      !this.options.dataCenter || !input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("用户数据中心 IPC 来源或策略无效");
    }
    const raw = input as Record<string, unknown>;
    const action = raw.action;
    if (typeof action !== "string" || !(PRODUCT_EXTENSION_ACCOUNT_ACTIONS as readonly string[]).includes(action) ||
      !raw.payload || typeof raw.payload !== "object" || Array.isArray(raw.payload)) throw new Error("用户数据动作无效");
    const payload = raw.payload as Record<string, unknown>;
    const base = { ...raw };
    delete base.payload;
    parseProductExtensionActionRequest(base, {
      windowId: session.windowId,
      entry: "account",
      action: action as ProductExtensionAccountAction,
      consumeNonce: (nonce) => this.consumeNonce(session, action as ProductExtensionAccountAction, nonce),
    });
    const text = (key: string, max = 512, allowEmpty = false): string => {
      const value = payload[key];
      if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > max) throw new Error("用户数据动作字段无效");
      return value;
    };
    const agentId = text("agentId", 160);
    if (action === "account.select") {
      if (Object.keys(payload).sort().join("|") !== "agentId") throw new Error("Agent 选择字段无效");
      return this.options.dataCenter.read(agentId);
    }
    let request: Parameters<UserDataCenterService["perform"]>[0];
    if (action === "account.session.rename") {
      if (Object.keys(payload).sort().join("|") !== "agentId|key|label") throw new Error("会话重命名字段无效");
      request = { action: "session.rename", agentId, key: text("key"), label: text("label", 120) };
    } else if (action === "account.session.archive") {
      if (Object.keys(payload).sort().join("|") !== "agentId|archived|key" || typeof payload.archived !== "boolean") throw new Error("会话归档字段无效");
      request = { action: "session.archive", agentId, key: text("key"), archived: payload.archived };
    } else if (action === "account.session.pin") {
      if (Object.keys(payload).sort().join("|") !== "agentId|key|pinned" || typeof payload.pinned !== "boolean") throw new Error("会话置顶字段无效");
      request = { action: "session.pin", agentId, key: text("key"), pinned: payload.pinned };
    } else if (action === "account.session.search") {
      if (Object.keys(payload).sort().join("|") !== "agentId|query") throw new Error("会话搜索字段无效");
      request = { action: "session.search", agentId, query: text("query", 200, true) };
    } else if (action === "account.session.export") {
      if (Object.keys(payload).sort().join("|") !== "agentId|key") throw new Error("会话导出字段无效");
      request = { action: "session.export", agentId, key: text("key") };
    } else if (action === "account.session.trash" || action === "account.session.restore") {
      if (Object.keys(payload).sort().join("|") !== "agentId|key") throw new Error("会话回收字段无效");
      request = { action: action.endsWith("trash") ? "session.trash" : "session.restore", agentId, key: text("key") };
    } else if (action === "account.session.delete.request") {
      if (Object.keys(payload).sort().join("|") !== "agentId|key") throw new Error("永久删除请求字段无效");
      request = { action: "session.delete.request", agentId, key: text("key") };
    } else if (action === "account.session.delete.confirm") {
      if (Object.keys(payload).sort().join("|") !== "agentId|confirmation|key") throw new Error("永久删除确认字段无效");
      request = { action: "session.delete.confirm", agentId, key: text("key"), confirmation: text("confirmation", 200) };
    } else if (action === "account.profile.add") {
      if (Object.keys(payload).sort().join("|") !== "agentId|content|title") throw new Error("个人资料新增字段无效");
      request = { action: "profile.add", agentId, title: text("title", 120), content: text("content", 200_000) };
    } else if (action === "account.profile.trash" || action === "account.profile.restore") {
      if (Object.keys(payload).sort().join("|") !== "agentId|entryId") throw new Error("个人资料回收字段无效");
      request = { action: action.endsWith("trash") ? "profile.trash" : "profile.restore", agentId, entryId: text("entryId", 160) };
    } else if (action === "account.knowledge.query") {
      if (Object.keys(payload).sort().join("|") !== "agentId|query") throw new Error("知识查询字段无效");
      request = { action: "knowledge.query", agentId, query: text("query", 500) };
    } else if (action === "account.file.select") {
      if (Object.keys(payload).sort().join("|") !== "agentId|sessionId") throw new Error("附件选择字段无效");
      request = { action: "file.select", agentId, sessionId: text("sessionId", 512) };
    } else {
      if (Object.keys(payload).sort().join("|") !== "agentId|sessionId") throw new Error("附件发送字段无效");
      request = { action: "file.send", agentId, sessionId: text("sessionId", 512) };
    }
    return this.options.dataCenter.perform(request);
  }

  private async handleConfirmationResponse(
    senderId: number,
    senderUrl: string,
    input: unknown,
    approved: boolean,
  ): Promise<true> {
    const action = approved ? "confirmation.approve" : "confirmation.deny";
    const session = this.validate(senderId, senderUrl, action, input);
    if (!session.confirmation || session.responded || !this.options.respondConfirmation) {
      throw new Error("确认请求不存在或已经处理");
    }
    session.responded = true;
    await this.options.respondConfirmation(session.confirmation, approved);
    setImmediate(() => {
      if (!session.window.isDestroyed()) session.window.close();
    });
    return true;
  }

  private serve(request: Request): Response {
    if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
    if (
      url.protocol !== PRODUCT_EXTENSION_SURFACE_CONTRACT.resourceOrigin.scheme
      || url.hostname !== PRODUCT_EXTENSION_SURFACE_CONTRACT.resourceOrigin.host
      || url.username
      || url.password
      || url.port
      || url.search
      || url.hash
    ) {
      return new Response("Not Found", { status: 404 });
    }
    const route = Object.values(PRODUCT_EXTENSION_SURFACE_CONTRACT.resourceOrigin.routes)
      .includes(url.pathname as "/agents" | "/skills" | "/account" | "/confirmations");
    const asset = STATIC_ASSETS[url.pathname];
    if (!route && !asset) return new Response("Not Found", { status: 404 });
    const file = route ? "product-extension.html" : asset!.file;
    const contentType = route ? "text/html; charset=utf-8" : asset!.contentType;
    try {
      return new Response(readFileSync(this.options.assetsDir + "/" + file), {
        status: 200,
        headers: {
          "content-type": contentType,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "content-security-policy":
            "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        },
      });
    } catch {
      return new Response("Not Found", { status: 404 });
    }
  }
}
