import { packIdSchema } from "@longhub/pack-schema";

const INSTALL_PROTOCOL = "longhub-agent:";

export function agentPackInstallUrl(packId: string): string {
  if (!packIdSchema.safeParse(packId).success) throw new Error(`Pack ID 无效: ${packId}`);
  const url = new URL(`${INSTALL_PROTOCOL}//install/`);
  url.searchParams.set("packId", packId);
  return url.toString();
}

/** 只接受固定 scheme/host/path 和唯一 packId 参数，避免把导航通道扩成通用本机命令。 */
export function parseAgentPackInstallUrl(target: string): { packId: string } | undefined {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== INSTALL_PROTOCOL ||
    url.hostname !== "install" ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    [...url.searchParams.keys()].some((key) => key !== "packId")
  ) return undefined;
  const packId = url.searchParams.get("packId");
  return packId && packIdSchema.safeParse(packId).success ? { packId } : undefined;
}

