import { OPENCLAW_COMPAT_CONTRACT } from "@longhub/openclaw-compat";
import type { OpenClawWebContents } from "./openclaw-selector-policy.js";

const PRODUCT = OPENCLAW_COMPAT_CONTRACT.productUi;
const SELECTORS = OPENCLAW_COMPAT_CONTRACT.selectors;

/**
 * 注入到锁定版 Control UI 页面世界的产品化薄层。
 * 只处理已登记的 UI chrome、精确属性与欢迎按钮，不读取或改写聊天消息。
 */
export interface OpenClawProductRuntimePolicy {
  assistant_name: string;
  welcome_message: string;
  assistant_avatar_data_url?: string;
}

export function openClawProductUiScript(runtime?: OpenClawProductRuntimePolicy): string {
  const assistantName = runtime?.assistant_name ?? PRODUCT.assistantName;
  const translations = {
    ...PRODUCT.textTranslations,
    "Main Session": `${assistantName}会话`,
    "Ready to chat": runtime?.welcome_message ?? PRODUCT.textTranslations["Ready to chat"],
    "OpenClaw is working...": `${assistantName}正在处理…`,
    "OpenClaw is responding...": `${assistantName}正在回复…`,
  };
  const payload = JSON.stringify({
    ...PRODUCT,
    assistantName,
    logoUrl: runtime?.assistant_avatar_data_url,
    textTranslations: translations,
    selectors: {
      policyKey: SELECTORS.productUiPolicyKey,
      brandText: SELECTORS.brandText,
      brandImages: SELECTORS.brandImages,
      sessionNames: SELECTORS.sessionNames,
      sessionLinks: SELECTORS.sessionLinks,
      runStatusLabels: SELECTORS.runStatusLabels,
      productTextRoots: SELECTORS.productTextRoots,
    },
  }).replace(/</g, "\\u003c");

  return `(() => {
    const config = ${payload};
    const root = window;
    const existing = root[config.selectors.policyKey];
    if (existing) {
      existing.apply();
      return existing.snapshot();
    }

    const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
    const translations = config.textTranslations;
    const hiddenSuggestions = new Set(config.hiddenWelcomeSuggestions);
    const logoUrl = config.logoUrl;
    let applying = false;
    let scheduled = false;
    let observer;

    const translateValue = (raw) => {
      const value = normalize(raw);
      if (!value) return raw;
      if (translations[value]) return translations[value];
      let match = /^(.+) is working\\.\\.\\.$/.exec(value);
      if (match) return match[1] + "正在处理…";
      match = /^(.+) is responding\\.\\.\\.$/.exec(value);
      if (match) return match[1] + "正在回复…";
      match = /^Run status: (.+)$/.exec(value);
      if (match) return "运行状态：" + (translations[match[1]] || match[1]);
      match = /^Message (.+)$/.exec(value);
      if (match) return "给" + match[1] + "发送消息";
      match = /^Gateway status: (.+)$/.exec(value);
      if (match) return "连接状态：" + (match[1].toLowerCase() === "online" ? "在线" : "离线");
      return raw;
    };

    const translateTextNode = (node) => {
      const translated = translateValue(node.nodeValue);
      if (translated !== node.nodeValue) node.nodeValue = translated;
    };
    const translateTree = (element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) translateTextNode(node);
    };
    const setAttributeIfChanged = (element, name, value) => {
      if (element.getAttribute(name) !== value) element.setAttribute(name, value);
    };

    const apply = () => {
      if (applying) return;
      applying = true;
      try {
        document.documentElement.lang = config.locale;
        document.documentElement.dataset.longhubProductUi = "v1";
        document.title = config.documentTitle;

        for (const query of config.selectors.brandText) {
          for (const element of document.querySelectorAll(query)) {
            if (element.textContent !== config.productName) element.textContent = config.productName;
            element.dataset.longhubBrand = "v1";
          }
        }
        for (const query of config.selectors.brandImages) {
          for (const image of document.querySelectorAll(query)) {
            if (image instanceof HTMLImageElement && logoUrl && image.src !== logoUrl) image.src = logoUrl;
            image.dataset.longhubBrand = "v1";
            if (image.hasAttribute("alt")) setAttributeIfChanged(image, "alt", config.productName);
          }
        }
        for (const element of document.querySelectorAll('[aria-label="OpenClaw"]')) {
          setAttributeIfChanged(element, "aria-label", config.productName);
        }

        for (const button of document.querySelectorAll(".agent-chat__suggestion")) {
          const label = normalize(button.textContent);
          if (hiddenSuggestions.has(label)) {
            button.dataset.longhubHidden = "true";
            button.setAttribute("aria-hidden", "true");
            button.tabIndex = -1;
          }
        }

        for (const query of config.selectors.productTextRoots) {
          for (const element of document.querySelectorAll(query)) translateTree(element);
        }
        for (const query of config.selectors.runStatusLabels) {
          for (const element of document.querySelectorAll(query)) translateTree(element);
        }
        for (const query of config.selectors.sessionNames) {
          for (const element of document.querySelectorAll(query)) {
            const value = normalize(element.textContent);
            if (/^agent:/i.test(value)) element.textContent = "智能体会话";
            else translateTree(element);
          }
        }
        for (const query of config.selectors.sessionLinks) {
          for (const link of document.querySelectorAll(query)) {
            const label = normalize(link.querySelector(".sidebar-recent-session__name")?.textContent);
            if (label) setAttributeIfChanged(link, "title", label);
          }
        }

        for (const element of document.querySelectorAll("[aria-label], [title], [placeholder], img[alt]")) {
          for (const name of ["aria-label", "title", "placeholder", "alt"]) {
            if (!element.hasAttribute(name)) continue;
            const current = element.getAttribute(name) || "";
            const translated = translateValue(current);
            if (translated !== current) setAttributeIfChanged(element, name, translated);
          }
        }
      } finally {
        applying = false;
        // 丢弃本次产品化改写产生的记录，只响应上游后续真正的渲染变化。
        observer?.takeRecords();
      }
    };

    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        apply();
      });
    };
    observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    const policy = {
      apply,
      snapshot() {
        return {
          locale: document.documentElement.lang,
          title: document.title,
          brandCount: document.querySelectorAll('[data-longhub-brand="v1"]').length,
          hiddenWelcomeCount: document.querySelectorAll('[data-longhub-hidden="true"]').length,
        };
      },
    };
    Object.defineProperty(root, config.selectors.policyKey, {
      value: policy,
      configurable: false,
      enumerable: false,
    });
    apply();
    return policy.snapshot();
  })()`;
}

export async function installOpenClawProductUi(
  webContents: OpenClawWebContents,
  runtime?: OpenClawProductRuntimePolicy,
): Promise<void> {
  await webContents.executeJavaScript(openClawProductUiScript(runtime));
}

export const OPENCLAW_PRODUCT_UI_CONTRACT = {
  policyKey: SELECTORS.productUiPolicyKey,
  locale: PRODUCT.locale,
  productName: PRODUCT.productName,
  assistantName: PRODUCT.assistantName,
} as const;
