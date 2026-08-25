import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const OPENCLAW_COMPAT_SCHEMA_VERSION = "longhub/openclaw-compat/v1";
export const BUNDLED_OPENCLAW_VERSION = "2026.7.1-2";

/** LongHub 实际依赖的上游契约；字段变化必须伴随真实 Gateway/UI 回归和基线审查。 */
export const OPENCLAW_COMPAT_CONTRACT = {
  schemaVersion: OPENCLAW_COMPAT_SCHEMA_VERSION,
  openclawVersion: BUNDLED_OPENCLAW_VERSION,
  routes: {
    chatPath: "/chat",
    ordinaryUserPathSuffixes: [
      "/chat",
      "/activity",
      "/agents",
      "/sessions",
      "/usage",
      "/tasks",
      "/skills",
    ],
    forbiddenPathFragments: ["/settings/"],
    forbiddenSuffixes: [
      "/overview",
      "/settings",
      "/config",
      "/channels",
      "/communications",
      "/appearance",
      "/automation",
      "/mcp",
      "/infrastructure",
      "/workboard",
      "/worktrees",
      "/instances",
      "/cron",
      "/nodes",
      "/dreaming",
      "/dreams",
      "/skills/workshop",
      "/plugin",
      "/debug",
      "/logs",
    ],
  },
  selectors: {
    agentSelector: 'select[data-chat-agent-filter="true"]',
    selectorMounts: [".sidebar", ".sidebar-brand"],
    activeRunButton: "button.chat-send-btn--stop",
    selectorPolicyKey: "__longhubSelectorPolicyV1",
    selectAgentMethod: "selectAgent",
    sessionRowsProperty: "sessionRowsByAgent",
    productUiPolicyKey: "__longhubProductUiV1",
    brandText: [
      ".sidebar-brand__title",
      ".topbar-brand__title",
      ".dashboard-header__breadcrumb-link",
      ".login-gate__title",
    ],
    brandImages: [
      ".sidebar-brand__logo",
      ".topbar-brand__logo",
      ".sidebar-native-brand",
      ".login-gate__logo",
    ],
    sessionNames: [".sidebar-recent-session__name"],
    sessionLinks: [".sidebar-recent-session__link"],
    runStatusLabels: [".agent-chat__run-status-label"],
    productTextRoots: [
      ".sidebar-brand",
      ".topbar",
      ".dashboard-header",
      ".sidebar-sessions",
      ".agent-chat__welcome",
      ".agent-chat__run-status",
    ],
    ordinaryUserHidden: [
      ".sidebar-footer-icon",
      "openclaw-tooltip:has(> .sidebar-footer-icon)",
      ".sidebar-search",
      "openclaw-tooltip:has(.sidebar-search)",
      ".topbar-search",
      "openclaw-tooltip:has(.topbar-search)",
      '.agent-chat__suggestion[data-longhub-hidden="true"]',
    ],
    modelControls: [
      'details:has(> summary[data-chat-model-select="true"])',
      '[data-chat-model-select="true"]',
      "[data-chat-model-provider]",
      "[data-chat-model-provider-group]",
      "[data-chat-model-option]",
      ".chat-controls__inline-select-menu--combined",
      ".chat-controls__model-browser",
      ".chat-controls__use-default-model",
      ".chat-settings-chip",
    ],
    restrictedNavigationLinks: [
      'a[href$="/overview"]',
      'a[href*="/settings/"]',
      'a[href$="/settings"]',
      'a[href$="/config"]',
      'a[href$="/channels"]',
      'a[href$="/communications"]',
      'a[href$="/appearance"]',
      'a[href$="/automation"]',
      'a[href$="/mcp"]',
      'a[href$="/infrastructure"]',
      'a[href$="/workboard"]',
      'a[href$="/worktrees"]',
      'a[href$="/instances"]',
      'a[href$="/cron"]',
      'a[href$="/nodes"]',
      'a[href$="/dreaming"]',
      'a[href$="/dreams"]',
      'a[href$="/skills/workshop"]',
      'a[href^="/plugin"]',
      'a[href$="/debug"]',
      'a[href$="/logs"]',
    ],
    ordinaryUserRestrictedControls: [
      "openclaw-agents-page .agent-tabs > .agent-tab:nth-child(2)",
      "openclaw-agents-page .agent-tabs > .agent-tab:nth-child(6)",
      "openclaw-agents-page .workspace-link",
      "openclaw-agents-page .agent-model-select",
      "openclaw-agents-page .agents-toolbar-actions .btn--ghost:nth-of-type(2)",
      "openclaw-agents-page .agent-tools-header__actions",
      "openclaw-agents-page .agent-tools-buttons",
      "openclaw-agents-page .agent-tool-toggle",
      "openclaw-agents-page .agent-skills-groups .cfg-toggle",
      'openclaw-agents-page .card:has(input[name="agent-skills-filter"]) > .row:first-child > .row',
      'openclaw-skills-page .card:has(input[name="clawhub-search"])',
      "openclaw-skills-page .skill-toggle-wrap",
      'openclaw-skills-page .md-preview-dialog div:has(> .field > input[type="password"])',
      "openclaw-skills-page .md-preview-dialog .row:has(> .skill-toggle-wrap) > .btn",
    ],
    agentsPage: "openclaw-agents-page",
    agentsPanelProperty: "agentsPanel",
    agentsSelectPanelMethod: "selectPanel",
    ordinaryUserAgentPanels: ["overview", "tools", "skills", "channels"],
  },
  gatewayRpc: {
    configGet: "config.get",
    configPatch: "config.patch",
    agentsList: "agents.list",
    replacePaths: ["agents.list"],
    patchNote: "LongHub Pack lifecycle sync",
  },
  productUi: {
    locale: "zh-CN",
    productName: "龙枢",
    assistantName: "龙枢助手",
    documentTitle: "龙枢",
    hiddenWelcomeSuggestions: ["Help me configure a channel", "Check system health"],
    textTranslations: {
      OpenClaw: "龙枢",
      "Main Session": "龙枢助手会话",
      "New session": "新建会话",
      Chat: "对话",
      Sessions: "会话",
      "All sessions": "全部会话",
      Done: "已完成",
      Interrupted: "已中断",
      "Ready to chat": "随时可以开始",
      "Type a message below ·": "在下方输入消息 ·",
      "for commands": "查看快捷命令",
      "What can you do?": "你能帮我做什么？",
      "Summarize my recent sessions": "总结我最近的会话",
      "Preparing model...": "正在准备…",
      "Sending message...": "正在发送…",
      "OpenClaw is working...": "龙枢助手正在处理…",
      "OpenClaw is responding...": "龙枢助手正在回复…",
      "New Session": "新建会话",
      "Send message": "发送消息",
      "Stop generating": "停止生成",
    },
  },
  visual: {
    viewport: { width: 1200, height: 800 },
    stableCaptureRect: { x: 0, y: 0, width: 420, height: 220 },
    criticalRegions: ["sidebar", "agent-selector", "chat-header", "composer"],
  },
} as const;

export const PRODUCT_EXTENSION_SURFACE_SCHEMA = "longhub/product-extension-surface/v2" as const;
export const PRODUCT_EXTENSION_ENTRY_IDS = ["agents", "skills", "account"] as const;
export const PRODUCT_EXTENSION_ROUTE_IDS = [
  ...PRODUCT_EXTENSION_ENTRY_IDS,
  "confirmations",
] as const;
export const PRODUCT_EXTENSION_ACTIONS = [
  "context.read",
  "window.close",
  "confirmation.read",
  "confirmation.approve",
  "confirmation.deny",
  "agents.read",
  "agents.select",
  "agents.install",
  "agents.enable",
  "agents.disable",
  "agents.content.create",
  "agents.content.import",
  "agents.content.export",
  "agents.openclaw.import",
  "agents.workflow.create",
  "agents.workflow.run",
  "agents.overlay.create",
  "agents.handoff.preview",
  "agents.handoff.confirm",
  "agents.handoff.cancel",
  "skills.read",
  "skills.install",
  "skills.enable",
  "skills.disable",
  "skills.upgrade",
  "skills.rollback",
  "skills.uninstall",
  "account.read",
  "account.select",
  "account.session.rename",
  "account.session.archive",
  "account.session.pin",
  "account.session.search",
  "account.session.export",
  "account.session.trash",
  "account.session.restore",
  "account.session.delete.request",
  "account.session.delete.confirm",
  "account.profile.add",
  "account.profile.trash",
  "account.profile.restore",
  "account.knowledge.query",
  "account.file.select",
  "account.file.send",
] as const;
export const PRODUCT_EXTENSION_AGENT_ACTIONS = [
  "agents.select",
  "agents.install",
  "agents.enable",
  "agents.disable",
  "agents.content.create",
  "agents.content.import",
  "agents.content.export",
  "agents.openclaw.import",
  "agents.workflow.create",
  "agents.workflow.run",
  "agents.overlay.create",
  "agents.handoff.preview",
  "agents.handoff.confirm",
  "agents.handoff.cancel",
] as const;
export const PRODUCT_EXTENSION_SKILL_ACTIONS = [
  "skills.install",
  "skills.enable",
  "skills.disable",
  "skills.upgrade",
  "skills.rollback",
  "skills.uninstall",
] as const;
export const PRODUCT_EXTENSION_ACCOUNT_ACTIONS = [
  "account.select",
  "account.session.rename",
  "account.session.archive",
  "account.session.pin",
  "account.session.search",
  "account.session.export",
  "account.session.trash",
  "account.session.restore",
  "account.session.delete.request",
  "account.session.delete.confirm",
  "account.profile.add",
  "account.profile.trash",
  "account.profile.restore",
  "account.knowledge.query",
  "account.file.select",
  "account.file.send",
] as const;

export type ProductExtensionEntryId = (typeof PRODUCT_EXTENSION_ENTRY_IDS)[number];
export type ProductExtensionRouteId = (typeof PRODUCT_EXTENSION_ROUTE_IDS)[number];
export type ProductExtensionAction = (typeof PRODUCT_EXTENSION_ACTIONS)[number];
export type ProductExtensionAgentAction = (typeof PRODUCT_EXTENSION_AGENT_ACTIONS)[number];
export type ProductExtensionSkillAction = (typeof PRODUCT_EXTENSION_SKILL_ACTIONS)[number];
export type ProductExtensionAccountAction = (typeof PRODUCT_EXTENSION_ACCOUNT_ACTIONS)[number];

/**
 * 产品扩展面与 OpenClaw DOM 契约同包锁定，但使用独立摘要和升级纪律。
 * 005 实现窗口时必须逐项使用本对象，不能在 Desktop 复制字符串或放宽 webPreferences。
 */
export const PRODUCT_EXTENSION_SURFACE_CONTRACT = {
  schemaVersion: PRODUCT_EXTENSION_SURFACE_SCHEMA,
  entryNavigation: {
    scheme: "longhub-extension:",
    host: "open",
    policyKey: "__longhubProductNativeShellV2",
    entries: PRODUCT_EXTENSION_ENTRY_IDS,
    selector: '[data-longhub-extension-nav="v2"]',
    mountCandidates: [".sidebar-brand", ".sidebar"],
    labels: {
      agents: "智能体",
      skills: "能力",
      account: "我的",
    },
  },
  resourceOrigin: {
    scheme: "longhub-product:",
    host: "app",
    origin: "longhub-product://app",
    routes: {
      agents: "/agents",
      skills: "/skills",
      account: "/account",
      confirmations: "/confirmations",
    },
  },
  window: {
    width: 820,
    height: 720,
    minWidth: 640,
    minHeight: 560,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  },
  ipc: {
    channels: {
      contextRead: "longhub:extension:context-read",
      windowClose: "longhub:extension:window-close",
      confirmationRead: "longhub:extension:confirmation-read",
      confirmationApprove: "longhub:extension:confirmation-approve",
      confirmationDeny: "longhub:extension:confirmation-deny",
      agentsRead: "longhub:extension:agents-read",
      agentsAction: "longhub:extension:agents-action",
      skillsRead: "longhub:extension:skills-read",
      skillsAction: "longhub:extension:skills-action",
      accountRead: "longhub:extension:account-read",
      accountAction: "longhub:extension:account-action",
    },
    actions: PRODUCT_EXTENSION_ACTIONS,
    nonceBytes: 32,
  },
  visual: {
    viewport: { width: 820, height: 720 },
    criticalRegions: ["native-navigation", "drawer-header", "agent-management", "content", "status", "primary-action"],
  },
} as const;

export class ProductExtensionContractError extends Error {
  readonly code = "PRODUCT_EXTENSION_CONTRACT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ProductExtensionContractError";
  }
}

function isProductEntry(value: string): value is ProductExtensionEntryId {
  return (PRODUCT_EXTENSION_ENTRY_IDS as readonly string[]).includes(value);
}

function isProductRoute(value: string): value is ProductExtensionRouteId {
  return (PRODUCT_EXTENSION_ROUTE_IDS as readonly string[]).includes(value);
}

export function parseProductExtensionEntryUrl(target: string): ProductExtensionEntryId {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new ProductExtensionContractError("产品扩展入口 URL 无效");
  }
  const entry = url.pathname.replace(/^\//, "");
  if (
    url.protocol !== PRODUCT_EXTENSION_SURFACE_CONTRACT.entryNavigation.scheme
    || url.hostname !== PRODUCT_EXTENSION_SURFACE_CONTRACT.entryNavigation.host
    || url.username
    || url.password
    || url.port
    || url.search
    || url.hash
    || !isProductEntry(entry)
  ) {
    throw new ProductExtensionContractError("产品扩展入口不在白名单");
  }
  return entry;
}

export function productExtensionRoute(route: ProductExtensionRouteId): string {
  return PRODUCT_EXTENSION_SURFACE_CONTRACT.resourceOrigin.origin
    + PRODUCT_EXTENSION_SURFACE_CONTRACT.resourceOrigin.routes[route];
}

export function isAllowedProductExtensionNavigation(target: string): boolean {
  try {
    const url = new URL(target);
    const path = url.pathname.replace(/\/$/, "") || "/";
    return url.protocol === PRODUCT_EXTENSION_SURFACE_CONTRACT.resourceOrigin.scheme
      && url.hostname === PRODUCT_EXTENSION_SURFACE_CONTRACT.resourceOrigin.host
      && !url.username
      && !url.password
      && !url.port
      && !url.search
      && !url.hash
      && Object.values(PRODUCT_EXTENSION_SURFACE_CONTRACT.resourceOrigin.routes).includes(
        path as "/agents" | "/skills" | "/account" | "/confirmations",
      );
  } catch {
    return false;
  }
}

export interface ProductExtensionActionRequest {
  readonly schema_version: typeof PRODUCT_EXTENSION_SURFACE_SCHEMA;
  readonly window_id: string;
  readonly entry: ProductExtensionRouteId;
  readonly action: ProductExtensionAction;
  readonly nonce: string;
}

export interface ProductExtensionSkillActionRequest extends ProductExtensionActionRequest {
  readonly action: ProductExtensionSkillAction;
  readonly payload: {
    readonly skillId: string;
    readonly agentId?: string;
  };
}

export function parseProductExtensionActionRequest(
  input: unknown,
  expected: {
    readonly windowId: string;
    readonly entry: ProductExtensionRouteId;
    readonly action: ProductExtensionAction;
    readonly consumeNonce: (nonce: string) => boolean;
  },
): ProductExtensionActionRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ProductExtensionContractError("产品扩展动作请求必须是对象");
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record).sort().join("|");
  if (keys !== "action|entry|nonce|schema_version|window_id") {
    throw new ProductExtensionContractError("产品扩展动作请求字段无效");
  }
  if (
    record.schema_version !== PRODUCT_EXTENSION_SURFACE_SCHEMA
    || typeof record.window_id !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      record.window_id,
    )
    || record.window_id !== expected.windowId
    || typeof record.entry !== "string"
    || !isProductRoute(record.entry)
    || record.entry !== expected.entry
    || typeof record.action !== "string"
    || !(PRODUCT_EXTENSION_ACTIONS as readonly string[]).includes(record.action)
    || record.action !== expected.action
    || typeof record.nonce !== "string"
    || !/^[A-Za-z0-9_-]{43}$/.test(record.nonce)
    || !expected.consumeNonce(record.nonce)
  ) {
    throw new ProductExtensionContractError("产品扩展动作绑定或 nonce 无效");
  }
  return record as unknown as ProductExtensionActionRequest;
}

export function parseProductExtensionSkillActionRequest(
  input: unknown,
  expected: {
    readonly windowId: string;
    readonly entry: "skills";
    readonly action: ProductExtensionSkillAction;
    readonly consumeNonce: (nonce: string) => boolean;
  },
): ProductExtensionSkillActionRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ProductExtensionContractError("能力动作请求必须是对象");
  }
  const record = input as Record<string, unknown>;
  const payload = record.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ProductExtensionContractError("能力动作载荷无效");
  }
  const value = payload as Record<string, unknown>;
  const payloadKeys = Object.keys(value).sort().join("|");
  if (
    Object.keys(record).sort().join("|") !== "action|entry|nonce|payload|schema_version|window_id" ||
    (payloadKeys !== "skillId" && payloadKeys !== "agentId|skillId") ||
    record.schema_version !== PRODUCT_EXTENSION_SURFACE_SCHEMA ||
    record.window_id !== expected.windowId ||
    record.entry !== "skills" ||
    record.action !== expected.action ||
    !(PRODUCT_EXTENSION_SKILL_ACTIONS as readonly string[]).includes(String(record.action)) ||
    typeof record.nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(record.nonce) ||
    typeof value.skillId !== "string" || !/^[a-z][a-z0-9.-]{1,127}$/.test(value.skillId) ||
    (value.agentId !== undefined &&
      (typeof value.agentId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.agentId))) ||
    !expected.consumeNonce(record.nonce)
  ) throw new ProductExtensionContractError("能力动作绑定、值或 nonce 无效");
  return record as unknown as ProductExtensionSkillActionRequest;
}

export function productExtensionSurfaceDigest(): string {
  return createHash("sha256")
    .update(JSON.stringify(PRODUCT_EXTENSION_SURFACE_CONTRACT))
    .digest("hex")
    .toUpperCase();
}

export interface OpenClawInstallationInfo {
  entryScript: string;
  packageJsonPath: string;
  actualVersion: string;
  expectedVersion: string;
  contractDigest: string;
}

export class OpenClawCompatibilityError extends Error {
  readonly code = "OPENCLAW_VERSION_MISMATCH";

  constructor(readonly expectedVersion: string, readonly actualVersion: string) {
    super(`内置 OpenClaw 版本不兼容：需要 ${expectedVersion}，实际 ${actualVersion}`);
    this.name = "OpenClawCompatibilityError";
  }
}

export function openClawCompatibilityDigest(): string {
  return createHash("sha256").update(JSON.stringify(OPENCLAW_COMPAT_CONTRACT)).digest("hex").toUpperCase();
}

export function assertCompatibleOpenClawVersion(actualVersion: string): void {
  if (actualVersion !== BUNDLED_OPENCLAW_VERSION) {
    throw new OpenClawCompatibilityError(BUNDLED_OPENCLAW_VERSION, actualVersion || "unknown");
  }
}

/** 从 openclaw.mjs 同目录回读 package.json；不根据 PATH 或用户安装猜测版本。 */
export function inspectOpenClawInstallation(entryScript: string): OpenClawInstallationInfo {
  const normalizedEntry = resolve(entryScript);
  const packageJsonPath = join(dirname(normalizedEntry), "package.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch (error) {
    throw new Error(
      `无法读取内置 OpenClaw 版本 ${packageJsonPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const actualVersion = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>).version
    : undefined;
  if (typeof actualVersion !== "string") throw new Error("内置 OpenClaw package.json 缺少 version");
  assertCompatibleOpenClawVersion(actualVersion);
  return {
    entryScript: normalizedEntry,
    packageJsonPath,
    actualVersion,
    expectedVersion: BUNDLED_OPENCLAW_VERSION,
    contractDigest: openClawCompatibilityDigest(),
  };
}

export function buildOpenClawProductCss(): string {
  const selectors = [
    ...OPENCLAW_COMPAT_CONTRACT.selectors.modelControls,
    ...OPENCLAW_COMPAT_CONTRACT.selectors.restrictedNavigationLinks,
    ...OPENCLAW_COMPAT_CONTRACT.selectors.ordinaryUserRestrictedControls,
    ...OPENCLAW_COMPAT_CONTRACT.selectors.ordinaryUserHidden,
  ];
  return `\n  ${selectors.join(",\n  ")} { display: none !important; }\n`;
}
