import {
  validateSkillPackage,
  verifySkillPackageSignature,
  type SkillPackage,
} from "@longhub/pack-schema";

export interface SkillCatalogItem {
  readonly skillId: string;
  readonly publisher: { readonly namespace: string; readonly displayName: string };
  readonly display: {
    readonly name: string;
    readonly description: string;
    readonly category: string;
    readonly examples: readonly string[];
  };
  readonly type: "content" | "workflow" | "tool";
  readonly latestVersion: string;
  readonly versions: readonly string[];
  readonly runtimeKind: "builtin" | "declarative" | "cloudRef";
  readonly compatibility: SkillPackage["compatibility"];
  readonly permissions: SkillPackage["permissions"];
  readonly limits: SkillPackage["limits"];
  readonly entitled: boolean;
}

export class SkillCatalogClientError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SkillCatalogClientError";
  }
}

export interface SkillCatalogClientOptions {
  readonly baseUrl: string;
  readonly deviceToken: string;
  readonly openclawVersion: string;
  readonly trustedKeys: ReadonlyMap<string, string>;
  readonly fetchImpl?: typeof fetch;
}

function exactKeys(input: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(input).sort().join("|") === [...expected].sort().join("|");
}

function object(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new SkillCatalogClientError("SKILL_CATALOG_INVALID", `${label} 不是对象`);
  }
  return input as Record<string, unknown>;
}

function parseCatalogItem(input: unknown): SkillCatalogItem {
  const item = object(input, "Skill 目录项");
  if (!exactKeys(item, [
    "compatibility", "display", "entitled", "latest_version", "permissions",
    "limits", "publisher", "runtime_kind", "skill_id", "type", "versions",
  ])) throw new SkillCatalogClientError("SKILL_CATALOG_INVALID", "Skill 目录项字段无效");
  const publisher = object(item.publisher, "publisher");
  const display = object(item.display, "display");
  const compatibility = object(item.compatibility, "compatibility");
  const permissions = object(item.permissions, "permissions");
  const limits = object(item.limits, "limits");
  if (
    !exactKeys(publisher, ["displayName", "namespace"]) ||
    !exactKeys(display, ["category", "description", "examples", "name"]) ||
    !exactKeys(compatibility, ["minManagerVersion", "openclawVersion", "runtimeApiVersion"]) ||
    !exactKeys(permissions, ["confirmationClass", "requested"]) ||
    !exactKeys(limits, ["maxConcurrency", "maxCostMicros", "maxDurationMs", "maxPackageBytes", "maxSteps"]) ||
    typeof item.skill_id !== "string" || typeof item.latest_version !== "string" ||
    !Array.isArray(item.versions) || !item.versions.every((value) => typeof value === "string") ||
    !["content", "workflow", "tool"].includes(String(item.type)) ||
    !["builtin", "declarative", "cloudRef"].includes(String(item.runtime_kind)) ||
    typeof item.entitled !== "boolean" ||
    typeof publisher.namespace !== "string" || typeof publisher.displayName !== "string" ||
    typeof display.name !== "string" || typeof display.description !== "string" ||
    typeof display.category !== "string" || !Array.isArray(display.examples) ||
    !display.examples.every((value) => typeof value === "string") ||
    ![compatibility.minManagerVersion, compatibility.openclawVersion, compatibility.runtimeApiVersion]
      .every((value) => typeof value === "string") ||
    !Array.isArray(permissions.requested) || !permissions.requested.every((value) => typeof value === "string") ||
    !["none", "per_execution"].includes(String(permissions.confirmationClass))
    || !Object.values(limits).every((value) => Number.isSafeInteger(value) && (value as number) >= 0)
  ) throw new SkillCatalogClientError("SKILL_CATALOG_INVALID", "Skill 目录项值无效");
  return {
    skillId: item.skill_id,
    publisher: publisher as unknown as SkillCatalogItem["publisher"],
    display: display as unknown as SkillCatalogItem["display"],
    type: item.type as SkillCatalogItem["type"],
    latestVersion: item.latest_version,
    versions: [...item.versions] as string[],
    runtimeKind: item.runtime_kind as SkillCatalogItem["runtimeKind"],
    compatibility: compatibility as unknown as SkillPackage["compatibility"],
    permissions: permissions as unknown as SkillPackage["permissions"],
    limits: limits as unknown as SkillPackage["limits"],
    entitled: item.entitled,
  };
}

export class SkillCatalogClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: SkillCatalogClientOptions) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      throw new SkillCatalogClientError("SKILL_CLOUD_ORIGIN_INVALID", "Skill Cloud 必须使用 HTTPS 或回环地址");
    }
    if (!options.deviceToken) throw new SkillCatalogClientError("SKILL_DEVICE_TOKEN_MISSING", "缺少设备凭据");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async list(): Promise<readonly SkillCatalogItem[]> {
    const url = new URL("/v1/catalog/skills", this.options.baseUrl);
    url.searchParams.set("openclaw_version", this.options.openclawVersion);
    const response = await this.fetchImpl(url, { headers: this.headers() });
    if (!response.ok) throw await this.responseError(response);
    const body = object(await response.json(), "Skill Catalog 响应");
    if (!exactKeys(body, ["filters", "skills"]) || !Array.isArray(body.skills)) {
      throw new SkillCatalogClientError("SKILL_CATALOG_INVALID", "Skill Catalog 响应字段无效");
    }
    return body.skills.map(parseCatalogItem);
  }

  async reference(skillId: string, version: string): Promise<SkillPackage> {
    const url = new URL(`/v1/skills/${encodeURIComponent(skillId)}/reference`, this.options.baseUrl);
    url.searchParams.set("version", version);
    url.searchParams.set("openclaw_version", this.options.openclawVersion);
    const response = await this.fetchImpl(url, { headers: this.headers() });
    if (!response.ok) throw await this.responseError(response);
    const body = object(await response.json(), "Skill 引用响应");
    if (!exactKeys(body, ["digest", "package", "signature_key_id"]) ||
      typeof body.digest !== "string" || typeof body.signature_key_id !== "string") {
      throw new SkillCatalogClientError("SKILL_REFERENCE_INVALID", "Skill 引用响应字段无效");
    }
    const parsed = validateSkillPackage(body.package);
    if (!parsed.ok || parsed.manifest.skill.id !== skillId || parsed.manifest.skill.version !== version ||
      parsed.manifest.integrity.digest !== body.digest ||
      parsed.manifest.integrity.signatureKeyId !== body.signature_key_id) {
      throw new SkillCatalogClientError("SKILL_REFERENCE_INVALID", "Skill 引用身份、版本或摘要不一致");
    }
    const publicKey = this.options.trustedKeys.get(body.signature_key_id);
    if (!publicKey || !verifySkillPackageSignature(parsed.manifest, publicKey)) {
      throw new SkillCatalogClientError("SKILL_SIGNATURE_INVALID", "Skill 引用签名未知或无效");
    }
    return parsed.manifest;
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.options.deviceToken}` };
  }

  private async responseError(response: Response): Promise<SkillCatalogClientError> {
    let code = `HTTP_${response.status}`;
    try {
      const body = await response.json() as { code?: unknown };
      if (typeof body.code === "string") code = body.code;
    } catch {
      // 固定 HTTP code 足以安全展示，不向 UI 透传自由文本响应。
    }
    return new SkillCatalogClientError(code, `Skill Cloud 请求失败 (${response.status})`);
  }
}
