import { buildOpenClawProductCss, OPENCLAW_COMPAT_CONTRACT } from "@longhub/openclaw-compat";

/** 龙枢成品客户端不向终端用户暴露 Gateway/模型配置入口。 */
const ROUTES = OPENCLAW_COMPAT_CONTRACT.routes;

export function isForbiddenOpenClawRoute(target: string, controlUiUrl: string): boolean {
  try {
    const url = new URL(target);
    const product = new URL(controlUiUrl);
    if (url.origin !== product.origin) return false;
    const path = url.pathname.replace(/\/$/, "");
    return ROUTES.forbiddenPathFragments.some((fragment) => path.includes(fragment)) ||
      ROUTES.forbiddenSuffixes.some((suffix) => path.endsWith(suffix));
  } catch {
    return false;
  }
}

/** 主窗口只允许留在当前 Gateway 的产品聊天页；自定义安装 scheme 由 Main 在调用前单独解析。 */
export function isAllowedOpenClawNavigation(target: string, controlUiUrl: string): boolean {
  try {
    const url = new URL(target);
    const product = new URL(controlUiUrl);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin === product.origin &&
      url.pathname.replace(/\/$/, "") === product.pathname.replace(/\/$/, "") &&
      !isForbiddenOpenClawRoute(target, controlUiUrl)
    );
  } catch {
    return false;
  }
}

export const OPENCLAW_PRODUCT_CSS = buildOpenClawProductCss();
