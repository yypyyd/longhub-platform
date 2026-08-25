import { agentPackInstallUrl } from "./agent-install-navigation.js";
import type { AgentPackInstallState } from "./agent-pack-catalog.js";
import { OPENCLAW_COMPAT_CONTRACT } from "@longhub/openclaw-compat";

const COMPAT_SELECTORS = OPENCLAW_COMPAT_CONTRACT.selectors;
const SELECTOR = COMPAT_SELECTORS.agentSelector;
const ACTIVE_RUN_BUTTON = COMPAT_SELECTORS.activeRunButton;
const POLICY_KEY = COMPAT_SELECTORS.selectorPolicyKey;

export interface OpenClawSelectorScriptOptions {
  allowedAgentIds: readonly string[];
  agentLabels?: Readonly<Record<string, string>>;
  installableAgents?: readonly {
    packId: string;
    agentId: string;
    label: string;
    state: AgentPackInstallState;
    error?: string;
  }[];
  confirmMessage?: string;
  stopTimeoutMs?: number;
}

export interface OpenClawWebContents {
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
}

function normalizedAgentIds(agentIds: readonly string[]): string[] {
  const normalized = agentIds
    .map((agentId) => agentId.trim().toLowerCase())
    .filter((agentId) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(agentId));
  return [
    "main",
    ...[...new Set(normalized.filter((agentId) => agentId !== "main"))]
      .sort((left, right) => left.localeCompare(right, "en")),
  ];
}

/**
 * 注入到 OpenClaw 页面世界的薄适配层：不获得 Node/IPC 权限，只约束原生 Selector。
 * 重复执行只更新允许列表，不会重复注册事件或 MutationObserver。
 */
export function openClawSelectorPolicyScript(options: OpenClawSelectorScriptOptions): string {
  const allowedAgentIds = normalizedAgentIds(options.allowedAgentIds);
  const installableAgents = (options.installableAgents ?? [])
    .filter(
      (agent) =>
        /^[a-z0-9][a-z0-9._-]{0,127}$/.test(agent.packId) &&
        /^[a-z0-9][a-z0-9_-]{0,63}$/.test(agent.agentId) &&
        !allowedAgentIds.includes(agent.agentId),
    )
    .filter((agent, index, all) => all.findIndex((item) => item.packId === agent.packId) === index)
    .map((agent) => ({
      packId: agent.packId,
      agentId: agent.agentId,
      label: agent.label.trim() || agent.agentId,
      state: agent.state,
      error: agent.error?.slice(0, 200),
      installUrl: agentPackInstallUrl(agent.packId),
    }))
    .sort((left, right) => left.agentId.localeCompare(right.agentId, "en"));
  const payload = JSON.stringify({
    allowedAgentIds,
    agentLabels: Object.fromEntries(
      allowedAgentIds.map((agentId) => [
        agentId,
        options.agentLabels?.[agentId]?.trim() || (agentId === "main" ? "龙枢助手" : agentId),
      ]),
    ),
    installableAgents,
    confirmMessage: options.confirmMessage ?? "当前智能体仍在生成或执行任务。要先停止，再切换智能体吗？",
    stopTimeoutMs: Math.max(1_000, Math.min(options.stopTimeoutMs ?? 15_000, 60_000)),
  }).replace(/</g, "\\u003c");

  return `(() => {
    const incoming = ${payload};
    const key = ${JSON.stringify(POLICY_KEY)};
    const selectorQuery = ${JSON.stringify(SELECTOR)};
    const activeRunQuery = ${JSON.stringify(ACTIVE_RUN_BUTTON)};
    const selectorMountQueries = ${JSON.stringify(COMPAT_SELECTORS.selectorMounts)};
    const selectAgentMethod = ${JSON.stringify(COMPAT_SELECTORS.selectAgentMethod)};
    const sessionRowsProperty = ${JSON.stringify(COMPAT_SELECTORS.sessionRowsProperty)};
    const root = window;
    const existing = root[key];
    if (existing) {
      existing.update(incoming);
      return existing.snapshot();
    }

    const previousValues = new WeakMap();
    let allowed = new Set(incoming.allowedAgentIds);
    let agentLabels = incoming.agentLabels;
    let installableAgents = incoming.installableAgents;
    let confirmMessage = incoming.confirmMessage;
    let stopTimeoutMs = incoming.stopTimeoutMs;
    let bypass = false;
    let applying = false;

    const selectors = () => Array.from(document.querySelectorAll(selectorQuery));
    const remember = (select) => previousValues.set(select, select.value || "main");
    const isVisible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
    };
    const findSelectorHost = () => Array.from(document.querySelectorAll("*")).find(
      (element) => typeof element[selectAgentMethod] === "function",
    );
    const createSelector = () => {
      const currentSelectors = selectors();
      const nativeSelector = currentSelectors.find((select) => select.dataset.longhubInjected !== "true");
      if (currentSelectors.some((select) => select.dataset.longhubInjected === "true") || isVisible(nativeSelector)) return;
      const host = findSelectorHost();
      const mount = selectorMountQueries.map((query) => document.querySelector(query)).find(Boolean);
      if (!host || !mount) return;
      const label = document.createElement("label");
      label.className = "sidebar-agent-scope longhub-agent-scope";
      label.dataset.longhubInjected = "true";
      label.setAttribute("aria-label", "当前智能体");
      const select = document.createElement("select");
      select.dataset.chatAgentFilter = "true";
      select.dataset.longhubInjected = "true";
      select.setAttribute("aria-label", "切换智能体");
      for (const agentId of allowed) {
        const option = document.createElement("option");
        option.value = agentId;
        option.textContent = agentLabels[agentId] || agentId;
        select.append(option);
      }
      const session = new URL(location.href).searchParams.get("session") || "";
      const matched = /^agent:([^:]+):/i.exec(session)?.[1]?.toLowerCase();
      select.value = matched && allowed.has(matched) ? matched : "main";
      const chevron = document.createElement("span");
      chevron.className = "sidebar-agent-scope__chevron";
      chevron.setAttribute("aria-hidden", "true");
      chevron.textContent = "⌄";
      label.append(select, chevron);
      mount.append(label);
    };
    const installLabel = (agent) => {
      if (agent.state === "installing") return agent.label + "（安装中…）";
      if (agent.state === "error") return agent.label + "（安装失败，点击重试）";
      return agent.label + "（点击安装）";
    };
    const syncInjectedAllowedOptions = (select) => {
      if (select.dataset.longhubInjected !== "true") return;
      const existing = Array.from(select.options)
        .filter((option) => !option.dataset.longhubInstallPack)
        .map((option) => ({ value: option.value, label: option.textContent }));
      const expected = Array.from(allowed).map((agentId) => ({
        value: agentId,
        label: agentLabels[agentId] || agentId,
      }));
      if (JSON.stringify(existing) === JSON.stringify(expected)) return;
      const selected = select.value;
      for (const option of Array.from(select.options)) {
        if (!option.dataset.longhubInstallPack) option.remove();
      }
      for (const agent of expected.reverse()) {
        const option = document.createElement("option");
        option.value = agent.value;
        option.textContent = agent.label;
        select.prepend(option);
      }
      select.value = allowed.has(selected) ? selected : "main";
    };
    const syncInstallOptions = (select) => {
      const existing = Array.from(select.options)
        .filter((option) => option.dataset.longhubInstallPack)
        .map((option) => ({
          packId: option.dataset.longhubInstallPack,
          agentId: option.dataset.longhubAgentId,
          label: option.textContent,
          state: option.dataset.longhubInstallState,
          error: option.title,
        }));
      const expected = installableAgents.map((agent) => ({
        packId: agent.packId,
        agentId: agent.agentId,
        label: installLabel(agent),
        state: agent.state,
        error: agent.error || "",
      }));
      if (JSON.stringify(existing) === JSON.stringify(expected)) return;
      for (const option of Array.from(select.options)) {
        if (option.dataset.longhubInstallPack) option.remove();
      }
      for (const agent of installableAgents) {
        const option = document.createElement("option");
        option.value = "__longhub_install__:" + agent.packId;
        option.textContent = installLabel(agent);
        option.dataset.longhubInstallPack = agent.packId;
        option.dataset.longhubAgentId = agent.agentId;
        option.dataset.longhubInstallState = agent.state;
        option.title = agent.error || "";
        option.disabled = agent.state === "installing";
        select.append(option);
      }
    };
    const applyAllowed = () => {
      if (applying) return;
      applying = true;
      try {
        createSelector();
        const nativeSelector = document.querySelector(selectorQuery + ":not([data-longhub-injected='true'])");
        if (isVisible(nativeSelector)) document.querySelector("label[data-longhub-injected='true']")?.remove();
        for (const select of selectors()) {
          for (const option of Array.from(select.options)) {
            if (!option.dataset.longhubInstallPack && !allowed.has(String(option.value).toLowerCase())) option.remove();
          }
          syncInjectedAllowedOptions(select);
          syncInstallOptions(select);
          if (!allowed.has(String(select.value).toLowerCase())) {
            select.value = "main";
            previousValues.set(select, "main");
          } else if (!previousValues.has(select)) {
            remember(select);
          }
          select.dataset.longhubSelectorPolicy = "v1";
          const label = select.closest("label.sidebar-agent-scope");
          if (label) {
            label.style.display = "";
            label.dataset.longhubSingleAgent = allowed.size + installableAgents.length === 1 ? "true" : "false";
            label.title = allowed.size + installableAgents.length === 1
              ? "当前智能体；可从智能体中心添加更多"
              : "切换智能体";
          }
        }
      } finally {
        applying = false;
      }
    };

    const restoreRecentSession = (host, targetAgentId, startedAt) => {
      const rowsByAgent = host[sessionRowsProperty];
      const rows = Array.isArray(rowsByAgent?.[targetAgentId])
        ? rowsByAgent[targetAgentId]
        : [];
      const prefix = "agent:" + targetAgentId + ":";
      const recent = rows
        .filter((row) => typeof row?.key === "string" && row.key.toLowerCase().startsWith(prefix))
        .filter((row) => row.key.slice(prefix.length).toLowerCase() !== "main")
        .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))[0];
      if (recent?.key && typeof host.selectSession === "function") {
        host.selectSession(recent.key);
        return;
      }
      if (Date.now() - startedAt < 5_000) {
        window.setTimeout(() => restoreRecentSession(host, targetAgentId, startedAt), 100);
      }
    };
    const dispatchSwitch = (select, targetAgentId) => {
      previousValues.set(select, targetAgentId);
      if (select.dataset.longhubInjected === "true") {
        const host = findSelectorHost();
        if (!host) {
          select.dataset.longhubSwitchBlocked = "true";
          return;
        }
        host[selectAgentMethod](targetAgentId);
        window.setTimeout(() => restoreRecentSession(host, targetAgentId, Date.now()), 0);
        return;
      }
      bypass = true;
      try {
        select.dispatchEvent(new Event("change", { bubbles: true }));
      } finally {
        bypass = false;
      }
    };
    const continueSwitch = (targetAgentId, startedAt) => {
      const activeRun = document.querySelector(activeRunQuery);
      if (activeRun && Date.now() - startedAt < stopTimeoutMs) {
        window.setTimeout(() => continueSwitch(targetAgentId, startedAt), 100);
        return;
      }
      const select = document.querySelector(selectorQuery);
      if (!select || activeRun || !allowed.has(targetAgentId)) {
        if (select) {
          select.disabled = false;
          select.dataset.longhubSwitchBlocked = "true";
        }
        return;
      }
      select.disabled = false;
      select.value = targetAgentId;
      dispatchSwitch(select, targetAgentId);
    };

    document.addEventListener("focusin", (event) => {
      const select = event.target instanceof HTMLSelectElement && event.target.matches(selectorQuery)
        ? event.target
        : null;
      if (select) remember(select);
    }, true);

    document.addEventListener("change", (event) => {
      const select = event.target instanceof HTMLSelectElement && event.target.matches(selectorQuery)
        ? event.target
        : null;
      if (!select || bypass) return;
      const previousAgentId = previousValues.get(select) || "main";
      const installPackId = select.selectedOptions[0]?.dataset.longhubInstallPack;
      if (installPackId) {
        event.preventDefault();
        event.stopImmediatePropagation();
        select.value = allowed.has(previousAgentId) ? previousAgentId : "main";
        const target = installableAgents.find((agent) => agent.packId === installPackId);
        if (target && target.state !== "installing") window.location.assign(target.installUrl);
        return;
      }
      const targetAgentId = String(select.value).toLowerCase();
      if (!allowed.has(targetAgentId)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        select.value = allowed.has(previousAgentId) ? previousAgentId : "main";
        return;
      }
      const stopButton = document.querySelector(activeRunQuery);
      if (!stopButton) {
        if (select.dataset.longhubInjected === "true") {
          event.preventDefault();
          event.stopImmediatePropagation();
          dispatchSwitch(select, targetAgentId);
        } else {
          previousValues.set(select, targetAgentId);
        }
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      select.value = allowed.has(previousAgentId) ? previousAgentId : "main";
      if (!window.confirm(confirmMessage)) return;
      select.disabled = true;
      delete select.dataset.longhubSwitchBlocked;
      stopButton.click();
      window.setTimeout(() => continueSwitch(targetAgentId, Date.now()), 0);
    }, true);

    const observer = new MutationObserver(applyAllowed);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    const policy = {
      update(next) {
        allowed = new Set(next.allowedAgentIds);
        agentLabels = next.agentLabels;
        installableAgents = next.installableAgents;
        confirmMessage = next.confirmMessage;
        stopTimeoutMs = next.stopTimeoutMs;
        applyAllowed();
      },
      select(agentId) {
        const targetAgentId = String(agentId || "").toLowerCase();
        if (!allowed.has(targetAgentId)) return false;
        applyAllowed();
        const select = document.querySelector(selectorQuery);
        if (!select) return false;
        select.value = targetAgentId;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      },
      snapshot() {
        return {
          allowedAgentIds: Array.from(allowed).sort(),
          installablePackIds: installableAgents.map((agent) => agent.packId),
          selectorCount: selectors().length,
          currentAgentId: document.querySelector(selectorQuery)?.value || "main",
        };
      },
    };
    Object.defineProperty(root, key, { value: policy, configurable: false, enumerable: false });
    applyAllowed();
    return policy.snapshot();
  })()`;
}

export async function installOpenClawSelectorPolicy(
  webContents: OpenClawWebContents,
  options: OpenClawSelectorScriptOptions,
): Promise<void> {
  await webContents.executeJavaScript(openClawSelectorPolicyScript(options));
}

/** 通过已安装的页面策略触发真实 OpenClaw Selector；不会给主 WebUI 增加 IPC。 */
export async function selectOpenClawAgent(
  webContents: OpenClawWebContents,
  agentId: string,
): Promise<boolean> {
  const normalized = agentId.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) return false;
  const result = await webContents.executeJavaScript(`(() => {
    const policy = window[${JSON.stringify(POLICY_KEY)}];
    return policy && typeof policy.select === "function"
      ? policy.select(${JSON.stringify(normalized)})
      : false;
  })()`);
  return result === true;
}

export const OPENCLAW_SELECTOR_CONTRACT = {
  selector: SELECTOR,
  activeRunButton: ACTIVE_RUN_BUTTON,
  policyKey: POLICY_KEY,
} as const;
