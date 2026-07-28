/**
 * 云端套装分发客户端：设备注册→获取签名公钥→目录/升级检查→下载制品。
 * 只依赖云台 REST 契约（contracts/openapi/longhub-cloud-v1.yaml），不依赖云端实现。
 */
import type { PackFile } from "@longhub/pack-schema";

export interface DeviceCredentials {
  deviceId: string;
  deviceToken: string;
}

export interface SigningKeyInfo {
  keyId: string;
  publicKeyPem: string;
}

export interface CatalogPack {
  pack_id: string;
  name: string;
  latest_version: string;
  min_desktop_version: string;
}

export type DownloadResult =
  | { ok: true; pack: PackFile; digest: string; signatureKeyId: string }
  | { ok: false; code: string; message: string };

interface ApiErrorBody {
  code?: string;
  message?: string;
}

export class CloudPackClient {
  constructor(private readonly baseUrl: string) {}

  async registerDevice(params: {
    appVersion: string;
    deviceFingerprint: string;
    displayName?: string;
  }): Promise<DeviceCredentials> {
    const res = await fetch(`${this.baseUrl}/v1/devices/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        platform: "windows",
        app_version: params.appVersion,
        device_fingerprint: params.deviceFingerprint,
        display_name: params.displayName,
      }),
    });
    if (!res.ok) {
      const body = (await res.json()) as ApiErrorBody;
      throw new Error(`设备注册失败 [${body.code ?? res.status}] ${body.message ?? ""}`);
    }
    const device = (await res.json()) as { device_id: string; device_token: string };
    return { deviceId: device.device_id, deviceToken: device.device_token };
  }

  async fetchSigningKey(): Promise<SigningKeyInfo> {
    const res = await fetch(`${this.baseUrl}/v1/packs/signing-key`);
    if (!res.ok) throw new Error(`获取签名公钥失败: HTTP ${res.status}`);
    const body = (await res.json()) as { key_id: string; public_key_pem: string };
    return { keyId: body.key_id, publicKeyPem: body.public_key_pem };
  }

  async listCatalog(deviceToken: string): Promise<CatalogPack[]> {
    const res = await fetch(`${this.baseUrl}/v1/catalog/packs`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    if (!res.ok) {
      const body = (await res.json()) as ApiErrorBody;
      throw new Error(`获取套装目录失败 [${body.code ?? res.status}] ${body.message ?? ""}`);
    }
    return ((await res.json()) as { packs: CatalogPack[] }).packs;
  }

  async downloadPack(deviceToken: string, packId: string, version?: string): Promise<DownloadResult> {
    const query = version ? `?version=${encodeURIComponent(version)}` : "";
    const res = await fetch(`${this.baseUrl}/v1/packs/${encodeURIComponent(packId)}/download${query}`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    if (!res.ok) {
      const body = (await res.json()) as ApiErrorBody;
      return { ok: false, code: body.code ?? `HTTP_${res.status}`, message: body.message ?? "下载失败" };
    }
    const body = (await res.json()) as { pack: PackFile; digest: string; signature_key_id: string };
    return { ok: true, pack: body.pack, digest: body.digest, signatureKeyId: body.signature_key_id };
  }
}
