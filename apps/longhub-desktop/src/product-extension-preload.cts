import { contextBridge, ipcRenderer } from "electron";

// Sandbox preload 不能 require 第三方模块；这些常量是 V2 契约的构建期镜像，
// product-extension-preload.test.ts 会与 @longhub/openclaw-compat 逐项核对。
const SCHEMA = "longhub/product-extension-surface/v2";
const CONTEXT_CHANNEL = "longhub:extension:context-read";
const CLOSE_CHANNEL = "longhub:extension:window-close";
const CONFIRMATION_READ_CHANNEL = "longhub:extension:confirmation-read";
const CONFIRMATION_APPROVE_CHANNEL = "longhub:extension:confirmation-approve";
const CONFIRMATION_DENY_CHANNEL = "longhub:extension:confirmation-deny";
const AGENTS_READ_CHANNEL = "longhub:extension:agents-read";
const AGENTS_ACTION_CHANNEL = "longhub:extension:agents-action";
const SKILLS_READ_CHANNEL = "longhub:extension:skills-read";
const SKILLS_ACTION_CHANNEL = "longhub:extension:skills-action";
const ACCOUNT_READ_CHANNEL = "longhub:extension:account-read";
const ACCOUNT_ACTION_CHANNEL = "longhub:extension:account-action";
type ProductExtensionAction =
  | "context.read"
  | "window.close"
  | "confirmation.read"
  | "confirmation.approve"
  | "confirmation.deny"
  | "agents.read"
  | "agents.select"
  | "agents.install"
  | "agents.enable"
  | "agents.disable"
  | "agents.content.create"
  | "agents.content.import"
  | "agents.content.export"
  | "agents.openclaw.import"
  | "agents.workflow.create"
  | "agents.workflow.run"
  | "agents.overlay.create"
  | "agents.handoff.preview"
  | "agents.handoff.confirm"
  | "agents.handoff.cancel"
  | "skills.read"
  | "skills.install"
  | "skills.enable"
  | "skills.disable"
  | "skills.upgrade"
  | "skills.rollback"
  | "skills.uninstall"
  | "account.read"
  | "account.select"
  | "account.session.rename"
  | "account.session.archive"
  | "account.session.pin"
  | "account.session.search"
  | "account.session.export"
  | "account.session.trash"
  | "account.session.restore"
  | "account.session.delete.request"
  | "account.session.delete.confirm"
  | "account.profile.add"
  | "account.profile.trash"
  | "account.profile.restore"
  | "account.knowledge.query"
  | "account.file.select"
  | "account.file.send";
type ProductExtensionRouteId = "agents" | "skills" | "account" | "confirmations";

function argument(name: string, pattern: RegExp): string {
  const prefix = "--longhub-extension-" + name + "=";
  const value = process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
  if (!value || !pattern.test(value)) throw new Error("产品扩展 preload 参数无效");
  return value;
}

const windowId = argument(
  "window-id",
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
);
const entry = argument("entry", /^(?:agents|skills|account|confirmations)$/) as ProductExtensionRouteId;
const contextNonce = argument("context-nonce", /^[A-Za-z0-9_-]{43}$/);
const closeNonce = argument("close-nonce", /^[A-Za-z0-9_-]{43}$/);
const confirmationReadNonce = argument("confirmation-read-nonce", /^[A-Za-z0-9_-]{43}$/);
const confirmationApproveNonce = argument("confirmation-approve-nonce", /^[A-Za-z0-9_-]{43}$/);
const confirmationDenyNonce = argument("confirmation-deny-nonce", /^[A-Za-z0-9_-]{43}$/);
const agentsReadNonce = argument("agents-read-nonce", /^[A-Za-z0-9_-]{43}$/);
const skillsReadNonce = argument("skills-read-nonce", /^[A-Za-z0-9_-]{43}$/);
const accountReadNonce = argument("account-read-nonce", /^[A-Za-z0-9_-]{43}$/);
const skillActionNonces = {
  "skills.install": argument("skills-install-nonce", /^[A-Za-z0-9_-]{43}$/),
  "skills.enable": argument("skills-enable-nonce", /^[A-Za-z0-9_-]{43}$/),
  "skills.disable": argument("skills-disable-nonce", /^[A-Za-z0-9_-]{43}$/),
  "skills.upgrade": argument("skills-upgrade-nonce", /^[A-Za-z0-9_-]{43}$/),
  "skills.rollback": argument("skills-rollback-nonce", /^[A-Za-z0-9_-]{43}$/),
  "skills.uninstall": argument("skills-uninstall-nonce", /^[A-Za-z0-9_-]{43}$/),
} as const;
const agentActionNonces = {
  "agents.select": argument("agents-select-nonce", /^[A-Za-z0-9_-]{43}$/),
  "agents.install": argument("agents-install-nonce", /^[A-Za-z0-9_-]{43}$/),
  "agents.enable": argument("agents-enable-nonce", /^[A-Za-z0-9_-]{43}$/),
  "agents.disable": argument("agents-disable-nonce", /^[A-Za-z0-9_-]{43}$/),
  "agents.content.create": argument("agents-content-create-nonce", /^[A-Za-z0-9_-]{43}$/),
  "agents.content.import": argument("agents-content-import-nonce", /^[A-Za-z0-9_-]{43}$/),
  "agents.content.export": argument("agents-content-export-nonce", /^[A-Za-z0-9_-]{43}$/),
  "agents.openclaw.import": argument("agents-openclaw-import-nonce", /^[A-Za-z0-9_-]{43}$/),
  "agents.workflow.create": argument("agents-workflow-create-nonce", /^[A-Za-z0-9_-]{43}$/),
  "agents.workflow.run": argument("agents-workflow-run-nonce", /^[A-Za-z0-9_-]{43}$/),
  "agents.overlay.create": argument("agents-overlay-create-nonce", /^[A-Za-z0-9_-]{43}$/),
  "agents.handoff.preview": argument("agents-handoff-preview-nonce", /^[A-Za-z0-9_-]{43}$/),
  "agents.handoff.confirm": argument("agents-handoff-confirm-nonce", /^[A-Za-z0-9_-]{43}$/),
  "agents.handoff.cancel": argument("agents-handoff-cancel-nonce", /^[A-Za-z0-9_-]{43}$/),
} as const;
const accountActionNonces = {
  "account.select": argument("account-select-nonce", /^[A-Za-z0-9_-]{43}$/),
  "account.session.rename": argument("account-session-rename-nonce", /^[A-Za-z0-9_-]{43}$/),
  "account.session.archive": argument("account-session-archive-nonce", /^[A-Za-z0-9_-]{43}$/),
  "account.session.pin": argument("account-session-pin-nonce", /^[A-Za-z0-9_-]{43}$/),
  "account.session.search": argument("account-session-search-nonce", /^[A-Za-z0-9_-]{43}$/),
  "account.session.export": argument("account-session-export-nonce", /^[A-Za-z0-9_-]{43}$/),
  "account.session.trash": argument("account-session-trash-nonce", /^[A-Za-z0-9_-]{43}$/),
  "account.session.restore": argument("account-session-restore-nonce", /^[A-Za-z0-9_-]{43}$/),
  "account.session.delete.request": argument("account-session-delete-request-nonce", /^[A-Za-z0-9_-]{43}$/),
  "account.session.delete.confirm": argument("account-session-delete-confirm-nonce", /^[A-Za-z0-9_-]{43}$/),
  "account.profile.add": argument("account-profile-add-nonce", /^[A-Za-z0-9_-]{43}$/),
  "account.profile.trash": argument("account-profile-trash-nonce", /^[A-Za-z0-9_-]{43}$/),
  "account.profile.restore": argument("account-profile-restore-nonce", /^[A-Za-z0-9_-]{43}$/),
  "account.knowledge.query": argument("account-knowledge-query-nonce", /^[A-Za-z0-9_-]{43}$/),
  "account.file.select": argument("account-file-select-nonce", /^[A-Za-z0-9_-]{43}$/),
  "account.file.send": argument("account-file-send-nonce", /^[A-Za-z0-9_-]{43}$/),
} as const;

function request(action: ProductExtensionAction, nonce: string) {
  return {
    schema_version: SCHEMA,
    window_id: windowId,
    entry,
    action,
    nonce,
  };
}

const common = {
  close: () => ipcRenderer.invoke(
    CLOSE_CHANNEL,
    request("window.close", closeNonce),
  ),
};
function skillAction(
  action: keyof typeof skillActionNonces,
  skillId: string,
  agentId?: string,
) {
  return ipcRenderer.invoke(SKILLS_ACTION_CHANNEL, {
    ...request(action, skillActionNonces[action]),
    payload: { skillId, ...(agentId ? { agentId } : {}) },
  });
}
function accountAction(action: keyof typeof accountActionNonces, payload: Record<string, unknown>) {
  return ipcRenderer.invoke(ACCOUNT_ACTION_CHANNEL, {
    ...request(action, accountActionNonces[action]),
    payload,
  });
}
function agentAction(action: keyof typeof agentActionNonces, payload: Record<string, unknown>) {
  return ipcRenderer.invoke(AGENTS_ACTION_CHANNEL, {
    ...request(action, agentActionNonces[action]),
    payload,
  });
}
const bridge = entry === "confirmations" ? {
  ...common,
  confirmation: () => ipcRenderer.invoke(
    CONFIRMATION_READ_CHANNEL,
    request("confirmation.read", confirmationReadNonce),
  ),
  approve: () => ipcRenderer.invoke(
    CONFIRMATION_APPROVE_CHANNEL,
    request("confirmation.approve", confirmationApproveNonce),
  ),
  deny: () => ipcRenderer.invoke(
    CONFIRMATION_DENY_CHANNEL,
    request("confirmation.deny", confirmationDenyNonce),
  ),
} : entry === "agents" ? {
  ...common,
  workspace: () => ipcRenderer.invoke(AGENTS_READ_CHANNEL, request("agents.read", agentsReadNonce)),
  selectAgent: (agentId: string) => agentAction("agents.select", { agentId }),
  installAgent: (packId: string) => agentAction("agents.install", { packId }),
  enableAgent: (packId: string) => agentAction("agents.enable", { packId }),
  disableAgent: (packId: string) => agentAction("agents.disable", { packId }),
  createContent: (name: string, description: string, instructions: string) => agentAction("agents.content.create", { name, description, instructions }),
  importContent: (serialized: string) => agentAction("agents.content.import", { serialized }),
  exportContent: (skillId: string) => agentAction("agents.content.export", { skillId }),
  importOpenClawContent: () => agentAction("agents.openclaw.import", {}),
  createWorkflow: (name: string, steps: unknown[]) => agentAction("agents.workflow.create", { name, steps }),
  runWorkflow: (workflowId: string, agentId: string) => agentAction("agents.workflow.run", { workflowId, agentId }),
  createOverlay: (payload: Record<string, unknown>) => agentAction("agents.overlay.create", payload),
  previewHandoff: (sourceAgentId: string, targetAgentId: string, summary: string) => agentAction("agents.handoff.preview", { sourceAgentId, targetAgentId, summary }),
  confirmHandoff: (handoffId: string, targetAgentId: string, confirmationToken: string) => agentAction("agents.handoff.confirm", { handoffId, targetAgentId, confirmationToken }),
  cancelHandoff: (handoffId: string) => agentAction("agents.handoff.cancel", { handoffId }),
} : entry === "skills" ? {
  ...common,
  skills: () => ipcRenderer.invoke(SKILLS_READ_CHANNEL, request("skills.read", skillsReadNonce)),
  install: (skillId: string, agentId: string) => skillAction("skills.install", skillId, agentId),
  enable: (skillId: string, agentId: string) => skillAction("skills.enable", skillId, agentId),
  disable: (skillId: string, agentId: string) => skillAction("skills.disable", skillId, agentId),
  upgrade: (skillId: string) => skillAction("skills.upgrade", skillId),
  rollback: (skillId: string) => skillAction("skills.rollback", skillId),
  uninstall: (skillId: string) => skillAction("skills.uninstall", skillId),
} : entry === "account" ? {
  ...common,
  account: () => ipcRenderer.invoke(ACCOUNT_READ_CHANNEL, request("account.read", accountReadNonce)),
  selectAgent: (agentId: string) => accountAction("account.select", { agentId }),
  renameSession: (agentId: string, key: string, label: string) => accountAction("account.session.rename", { agentId, key, label }),
  archiveSession: (agentId: string, key: string, archived: boolean) => accountAction("account.session.archive", { agentId, key, archived }),
  pinSession: (agentId: string, key: string, pinned: boolean) => accountAction("account.session.pin", { agentId, key, pinned }),
  searchSessions: (agentId: string, query: string) => accountAction("account.session.search", { agentId, query }),
  exportSession: (agentId: string, key: string) => accountAction("account.session.export", { agentId, key }),
  trashSession: (agentId: string, key: string) => accountAction("account.session.trash", { agentId, key }),
  restoreSession: (agentId: string, key: string) => accountAction("account.session.restore", { agentId, key }),
  requestPermanentDelete: (agentId: string, key: string) => accountAction("account.session.delete.request", { agentId, key }),
  confirmPermanentDelete: (agentId: string, key: string, confirmation: string) => accountAction("account.session.delete.confirm", { agentId, key, confirmation }),
  addProfile: (agentId: string, title: string, content: string) => accountAction("account.profile.add", { agentId, title, content }),
  trashProfile: (agentId: string, entryId: string) => accountAction("account.profile.trash", { agentId, entryId }),
  restoreProfile: (agentId: string, entryId: string) => accountAction("account.profile.restore", { agentId, entryId }),
  queryKnowledge: (agentId: string, query: string) => accountAction("account.knowledge.query", { agentId, query }),
  selectFile: (agentId: string, sessionId: string) => accountAction("account.file.select", { agentId, sessionId }),
  sendFiles: (agentId: string, sessionId: string) => accountAction("account.file.send", { agentId, sessionId }),
} : {
  ...common,
  context: () => ipcRenderer.invoke(
    CONTEXT_CHANNEL,
    request("context.read", contextNonce),
  ),
};
contextBridge.exposeInMainWorld("longhubProduct", Object.freeze(bridge));
