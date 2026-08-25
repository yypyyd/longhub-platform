import {
  PRODUCT_EXTENSION_ENTRY_IDS,
  PRODUCT_EXTENSION_SURFACE_CONTRACT,
  type ProductExtensionEntryId,
} from "@longhub/openclaw-compat";
import type { OpenClawWebContents } from "./openclaw-selector-policy.js";

export function productExtensionEntryScript(
  enabledEntries: readonly ProductExtensionEntryId[],
): string {
  const allowed = PRODUCT_EXTENSION_ENTRY_IDS.filter((entry) => enabledEntries.includes(entry));
  const payload = JSON.stringify({
    ...PRODUCT_EXTENSION_SURFACE_CONTRACT.entryNavigation,
    enabledEntries: allowed,
  }).replace(/</g, "\\u003c");
  return `(() => {
    const config = ${payload};
    const root = window;
    const existingPolicy = root[config.policyKey];
    if (existingPolicy) {
      existingPolicy.update(config.enabledEntries);
      return existingPolicy.snapshot();
    }

    let allowed = config.enabledEntries;
    let applying = false;
    let scheduled = false;
    let observer;
    const expectedHref = (entry) => config.scheme + "//" + config.host + "/" + entry;
    const ensureStyle = () => {
      let style = document.querySelector("style[data-longhub-native-shell-style='v2']");
      if (style) return style;
      style = document.createElement("style");
      style.dataset.longhubNativeShellStyle = "v2";
      style.textContent = \
        "[data-longhub-extension-nav='v2']{display:grid;gap:3px;padding:8px 12px 10px;border-bottom:1px solid rgba(87,78,72,.10)}" +
        "[data-longhub-extension-entry]{display:flex;align-items:center;gap:10px;min-height:38px;padding:8px 10px;border-radius:9px;color:#4c4642!important;text-decoration:none!important;font-size:14px;font-weight:550;line-height:20px;transition:background .12s ease,color .12s ease}" +
        "[data-longhub-extension-entry]:hover,[data-longhub-extension-entry]:focus-visible{background:#f1eeea;color:#211d1a!important;outline:none}" +
        "[data-longhub-extension-entry][data-active='true']{background:#f5e9e6;color:#b93429!important}" +
        ".longhub-entry-icon{display:grid;place-items:center;width:20px;height:20px;border:1px solid currentColor;border-radius:6px;font-size:12px;line-height:1}" +
        ".longhub-agent-scope{display:flex!important;align-items:center;gap:6px;margin:5px 10px 1px;padding:7px 9px;border:1px solid #ded8d2;border-radius:9px;background:#fff}" +
        ".longhub-agent-scope select{min-width:0;flex:1;border:0;background:transparent;color:#342e2a;font:inherit;outline:none}" +
        ".longhub-agent-scope[data-longhub-single-agent='true'] select{cursor:pointer}";
      document.head.append(style);
      return style;
    };
    const isCurrent = (nav, mount) => {
      if (!nav || nav.previousElementSibling !== mount) return false;
      const links = Array.from(nav.querySelectorAll("[data-longhub-extension-entry]"));
      return links.length === allowed.length && links.every((link, index) => {
        const entry = allowed[index];
        return link.dataset.longhubExtensionEntry === entry
          && link.getAttribute("aria-label") === config.labels[entry]
          && link.getAttribute("href") === expectedHref(entry);
      });
    };
    const apply = () => {
      if (applying) return;
      applying = true;
      try {
        const current = document.querySelector(config.selector);
        if (allowed.length === 0) {
          current?.remove();
          return;
        }
        const mount = config.mountCandidates
          .map((selector) => document.querySelector(selector))
          .find(Boolean);
        if (!mount) {
          current?.remove();
          return;
        }
        if (isCurrent(current, mount)) return;
        current?.remove();
        const nav = document.createElement("nav");
        ensureStyle();
        nav.dataset.longhubExtensionNav = "v2";
        nav.setAttribute("aria-label", "龙枢产品功能");
        const icons = { agents: "智", skills: "能", account: "我" };
        for (const entry of allowed) {
          const link = document.createElement("a");
          link.href = expectedHref(entry);
          link.dataset.longhubExtensionEntry = entry;
          link.setAttribute("aria-label", config.labels[entry]);
          const icon = document.createElement("span");
          icon.className = "longhub-entry-icon";
          icon.setAttribute("aria-hidden", "true");
          icon.textContent = icons[entry];
          const text = document.createElement("span");
          text.textContent = config.labels[entry];
          link.append(icon, text);
          link.addEventListener("click", () => {
            for (const item of nav.querySelectorAll("[data-longhub-extension-entry]")) {
              const active = item === link;
              item.dataset.active = active ? "true" : "false";
              if (active) item.setAttribute("aria-current", "page");
              else item.removeAttribute("aria-current");
            }
          });
          nav.appendChild(link);
        }
        mount.insertAdjacentElement("afterend", nav);
      } finally {
        applying = false;
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
    observer.observe(document.documentElement, { childList: true, subtree: true });
    const policy = {
      update(entries) {
        allowed = config.entries.filter((entry) => entries.includes(entry));
        apply();
      },
      snapshot() {
        return { count: document.querySelectorAll(config.selector + " [data-longhub-extension-entry]").length };
      },
    };
    Object.defineProperty(root, config.policyKey, {
      value: policy,
      configurable: false,
      enumerable: false,
    });
    apply();
    return policy.snapshot();
  })()`;
}

export async function installProductExtensionEntries(
  webContents: OpenClawWebContents,
  enabledEntries: readonly ProductExtensionEntryId[],
): Promise<void> {
  await webContents.executeJavaScript(productExtensionEntryScript(enabledEntries));
}
