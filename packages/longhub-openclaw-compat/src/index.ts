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
    ],
  },
  selectors: {
    agentSelector: 'select[data-chat-agent-filter="true"]',
    selectorMounts: [".sidebar-brand", ".sidebar"],
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
      ".sidebar-nav",
      ".sidebar-footer-icon",
      "openclaw-tooltip:has(> .sidebar-footer-icon)",
      ".sidebar-search",
      "openclaw-tooltip:has(.sidebar-search)",
      ".topbar-search",
      "openclaw-tooltip:has(.topbar-search)",
      ".topnav-shell__actions",
      ".dashboard-header__actions",
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
    ],
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
    ...OPENCLAW_COMPAT_CONTRACT.selectors.ordinaryUserHidden,
  ];
  return `\n  ${selectors.join(",\n  ")} { display: none !important; }\n`;
}
