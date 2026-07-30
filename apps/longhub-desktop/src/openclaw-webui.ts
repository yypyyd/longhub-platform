/**
 * 把 OpenClaw Gateway 的 WebSocket 地址转换为同端口的 Control UI 地址。
 *
 * OpenClaw 官方约定：Control UI 与 Gateway 共用端口，令牌通过 URL fragment
 * 一次性导入 sessionStorage；fragment 不会被发送到 HTTP 服务端。产品入口固定为
 * `/chat`，并显式携带 gatewayUrl，避免落到 Gateway Access 面板。
 */
export function openClawControlUiUrl(
  gatewayUrl: string,
  options: { explicitUrl?: string; token?: string } = {},
): string {
  const gateway = new URL(gatewayUrl);
  if (gateway.protocol === "ws:") gateway.protocol = "http:";
  else if (gateway.protocol === "wss:") gateway.protocol = "https:";
  else throw new Error(`不支持的 OpenClaw Gateway 协议: ${gateway.protocol}`);

  const url = options.explicitUrl ? new URL(options.explicitUrl) : gateway;

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`不支持的 OpenClaw WebUI 协议: ${url.protocol}`);
  }
  if (options.explicitUrl && url.origin !== gateway.origin) {
    throw new Error("OpenClaw WebUI 必须与 Gateway 同源，避免泄露本机管理令牌");
  }

  const prefix = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = `${prefix}${OPENCLAW_COMPAT_CONTRACT.routes.chatPath}`.replace(/\/+/g, "/");
  url.searchParams.set("gatewayUrl", gatewayUrl);

  if (options.token) {
    const fragment = new URLSearchParams(url.hash.slice(1));
    fragment.set("token", options.token);
    url.hash = fragment.toString();
  }

  return url.toString();
}

/** 构造绑定到指定 Agent 的主会话 URL；Agent 被移除时用于显式回退，绝不迁移原会话。 */
export function openClawAgentSessionUrl(controlUiUrl: string, agentId: string): string {
  const normalized = agentId.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw new Error(`无效的 OpenClaw agentId: ${agentId}`);
  }
  const url = new URL(controlUiUrl);
  url.searchParams.set("session", `agent:${normalized}:main`);
  return url.toString();
}
import { OPENCLAW_COMPAT_CONTRACT } from "@longhub/openclaw-compat";
