/**
 * 控制台套装发布器：读取构建产物（manifest + files），上传到云台管理面签名发布；
 * 支持吊销已发布版本。发布私钥只存在于云端，控制台不接触。
 */
import { readFileSync } from "node:fs";

export interface PackSource {
  manifest: unknown;
  files: Record<string, string>;
}

export interface PublishedRelease {
  pack_id: string;
  version: string;
  status: "active" | "revoked";
  digest?: string;
  signature_key_id?: string;
  created_at?: string;
}

export type PublishResult =
  | { ok: true; release: PublishedRelease }
  | { ok: false; code: string; message: string };

interface ApiErrorBody {
  code?: string;
  message?: string;
}

export class PackPublisher {
  constructor(
    private readonly baseUrl: string,
    private readonly adminToken: string,
  ) {}

  /** 从 pack.json 构建产物文件读取上传源 */
  static loadPackSource(filePath: string): PackSource {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as PackSource;
    return { manifest: parsed.manifest, files: parsed.files };
  }

  async publish(source: PackSource): Promise<PublishResult> {
    const res = await fetch(`${this.baseUrl}/v1/admin/packs`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ manifest: source.manifest, files: source.files }),
    });
    if (!res.ok) {
      const body = (await res.json()) as ApiErrorBody;
      return { ok: false, code: body.code ?? `HTTP_${res.status}`, message: body.message ?? "发布失败" };
    }
    return { ok: true, release: (await res.json()) as PublishedRelease };
  }

  async revoke(packId: string, version: string): Promise<PublishResult> {
    const res = await fetch(
      `${this.baseUrl}/v1/admin/packs/${encodeURIComponent(packId)}/${encodeURIComponent(version)}/revoke`,
      { method: "POST", headers: { authorization: `Bearer ${this.adminToken}` } },
    );
    if (!res.ok) {
      const body = (await res.json()) as ApiErrorBody;
      return { ok: false, code: body.code ?? `HTTP_${res.status}`, message: body.message ?? "吊销失败" };
    }
    return { ok: true, release: (await res.json()) as PublishedRelease };
  }
}
