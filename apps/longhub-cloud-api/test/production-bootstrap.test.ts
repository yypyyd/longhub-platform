import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCloudApiBindHost,
  parseCloudApiEnvironment,
  parseAdminSeedCredentials,
  parseExecutorUrl,
} from "../src/index.js";
import { generateSigningKey } from "../src/server.js";

const MODEL_CONFIG_KEY = Buffer.alloc(32, 7).toString("base64url");
const EXECUTOR_CREDENTIAL_SECRET = Buffer.alloc(32, 9).toString("base64url");

function productionEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://longhub@example.invalid/longhub",
    ADMIN_TOKEN: "longhub-prod-admin-0123456789abcdef",
    MODEL_CONFIG_KEY,
    EXECUTOR_CREDENTIAL_KEY_ID: "executor-current",
    EXECUTOR_CREDENTIAL_SECRET,
    CLIENT_UPDATE_SIGNING_KEY_ID: "client-update-current",
    CLIENT_UPDATE_SIGNING_PRIVATE_KEY_PEM: "update-private-pem",
    CLIENT_UPDATE_SIGNING_PUBLIC_KEY_PEM: "update-public-pem",
    SKILL_SIGNING_KEY_ID: "skill-current",
    SKILL_SIGNING_PRIVATE_KEY_PEM: "skill-private-pem",
    SKILL_SIGNING_PUBLIC_KEY_PEM: "skill-public-pem",
    CLOUD_PLUGIN_SIGNING_KEY_ID: "cloud-plugin-current",
    CLOUD_PLUGIN_SIGNING_PRIVATE_KEY_PEM: "cloud-plugin-private-pem",
    CLOUD_PLUGIN_SIGNING_PUBLIC_KEY_PEM: "cloud-plugin-public-pem",
    CLOUD_CLI_SIGNING_KEY_ID: "cloud-cli-current",
    CLOUD_CLI_SIGNING_PRIVATE_KEY_PEM: "cloud-cli-private-pem",
    CLOUD_CLI_SIGNING_PUBLIC_KEY_PEM: "cloud-cli-public-pem",
    CLOUD_PLUGIN_RELEASE_DIR: join(tmpdir(), "longhub-cloud-plugin-releases"),
    CLOUD_CLI_RELEASE_DIR: join(tmpdir(), "longhub-cloud-cli-releases"),
  };
}

describe("Cloud API production bootstrap gates", () => {
  it("parses defaults without touching a database or network", () => {
    const env: NodeJS.ProcessEnv = { EXECUTOR_CREDENTIAL_SECRET };
    const before = { ...env };
    const parsed = parseCloudApiEnvironment(env);

    expect(env).toEqual(before);
    expect(parsed).toMatchObject({
      port: 8081,
      bindHost: "127.0.0.1",
      executorUrl: "http://127.0.0.1:8082",
      productionMode: false,
      allowInsecureModelUpstream: false,
    });
  });

  it("requires PostgreSQL for NODE_ENV=production", () => {
    const env = productionEnvironment();
    delete env.DATABASE_URL;
    expect(() => parseCloudApiEnvironment(env)).toThrow("必须配置 DATABASE_URL");
  });

  it("rejects the documented replacement marker as a production admin token", () => {
    expect(() => parseCloudApiEnvironment({
      ...productionEnvironment(),
      ADMIN_TOKEN: "CHANGE_ME_HIGH_ENTROPY_ADMIN_TOKEN",
    })).toThrow(/非占位高熵/u);
  });

  it("requires one-time administrator seed credentials as a pair", () => {
    expect(() => parseAdminSeedCredentials("bootstrap-admin", undefined, false)).toThrow("必须同时配置");
    expect(() => parseAdminSeedCredentials(undefined, "Local-only-pass1!", false)).toThrow("必须同时配置");
  });

  it("rejects malformed, oversized, placeholder, and weak administrator seeds", () => {
    expect(() => parseAdminSeedCredentials("x".repeat(129), "Local-only-pass1!", false)).toThrow("1-128");
    expect(() => parseAdminSeedCredentials("bootstrap-admin", "x".repeat(257), false)).toThrow("1-256");
    expect(() => parseAdminSeedCredentials(
      "CHANGE_ME_INITIAL_ADMIN_USERNAME",
      "Strong-Random-Seed-9!",
      true,
    )).toThrow("非占位用户名");
    for (const password of ["123456", "admin-password-123", "onlylowercasepassword"]) {
      expect(() => parseAdminSeedCredentials("bootstrap-admin", password, true)).toThrow("随机强密码");
    }
  });

  it("accepts a bounded random one-time production administrator seed", () => {
    expect(parseAdminSeedCredentials("bootstrap-admin", "r4Ndom-Seed!2026-LongHub", true)).toEqual({
      username: "bootstrap-admin",
      password: "r4Ndom-Seed!2026-LongHub",
    });
  });

  it.each([
    ["NODE_ENV=production", { NODE_ENV: "production", DATABASE_URL: "postgres://example.invalid/longhub" }],
    ["DATABASE_URL mode", { DATABASE_URL: "postgres://example.invalid/longhub" }],
  ])("requires MODEL_CONFIG_KEY in %s", (_label, env) => {
    expect(() => parseCloudApiEnvironment(env)).toThrow("必须配置 MODEL_CONFIG_KEY");
  });

  it("rejects insecure model upstreams in every production bootstrap", () => {
    for (const nodeEnvironment of ["production", "development"]) {
      const env = {
        ...productionEnvironment(),
        NODE_ENV: nodeEnvironment,
        MODEL_ALLOW_INSECURE_UPSTREAM: "true",
      };
      expect(() => parseCloudApiEnvironment(env)).toThrow("不允许启用 MODEL_ALLOW_INSECURE_UPSTREAM");
    }
    expect(parseCloudApiEnvironment({
      EXECUTOR_CREDENTIAL_SECRET,
      MODEL_ALLOW_INSECURE_UPSTREAM: "true",
    }).allowInsecureModelUpstream).toBe(true);
  });

  it("accepts a complete production configuration as a pure value", () => {
    const env = productionEnvironment();
    env.CLOUD_API_BIND_HOST = "10.42.0.10";
    env.EXECUTOR_URL = "https://executor.internal/api/";
    const parsed = parseCloudApiEnvironment(env);
    expect(parsed).toMatchObject({
      productionMode: true,
      bindHost: "10.42.0.10",
      executorUrl: "https://executor.internal/api",
      databaseUrl: env.DATABASE_URL,
    });
    expect(parsed.modelEncryptionKey).toEqual(Buffer.from(MODEL_CONFIG_KEY, "base64url"));
  });

  it("accepts production signing keys delivered only through systemd credentials", () => {
    const root = mkdtempSync(join(tmpdir(), "longhub-production-credentials-"));
    try {
      const updateKey = generateSigningKey("client-update-current");
      const skillKey = generateSigningKey("skill-current");
      const pluginKey = generateSigningKey("cloud-plugin-current");
      const cliKey = generateSigningKey("cloud-cli-current");
      writeFileSync(join(root, "client-update-private.pem"), updateKey.privateKeyPem, "utf8");
      writeFileSync(join(root, "client-update-public.pem"), updateKey.publicKeyPem, "utf8");
      writeFileSync(join(root, "cloud-skill-private.pem"), skillKey.privateKeyPem, "utf8");
      writeFileSync(join(root, "cloud-skill-public.pem"), skillKey.publicKeyPem, "utf8");
      writeFileSync(join(root, "cloud-plugin-private.pem"), pluginKey.privateKeyPem, "utf8");
      writeFileSync(join(root, "cloud-plugin-public.pem"), pluginKey.publicKeyPem, "utf8");
      writeFileSync(join(root, "cloud-cli-private.pem"), cliKey.privateKeyPem, "utf8");
      writeFileSync(join(root, "cloud-cli-public.pem"), cliKey.publicKeyPem, "utf8");
      const env = productionEnvironment();
      delete env.CLIENT_UPDATE_SIGNING_PRIVATE_KEY_PEM;
      delete env.CLIENT_UPDATE_SIGNING_PUBLIC_KEY_PEM;
      delete env.SKILL_SIGNING_PRIVATE_KEY_PEM;
      delete env.SKILL_SIGNING_PUBLIC_KEY_PEM;
      delete env.CLOUD_PLUGIN_SIGNING_PRIVATE_KEY_PEM;
      delete env.CLOUD_PLUGIN_SIGNING_PUBLIC_KEY_PEM;
      delete env.CLOUD_CLI_SIGNING_PRIVATE_KEY_PEM;
      delete env.CLOUD_CLI_SIGNING_PUBLIC_KEY_PEM;
      env.CREDENTIALS_DIRECTORY = root;

      const parsed = parseCloudApiEnvironment(env);
      expect(parsed.updateSigningKey).toEqual(updateKey);
      expect(parsed.skillSigningKey).toEqual(skillKey);
      expect(parsed.cloudPluginSigningKey).toEqual(pluginKey);
      expect(parsed.cloudCliSigningKey).toEqual(cliKey);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["0", "-1", "65536", "1.5", "NaN", "Infinity", "1e3", " 8081", "8081 "])(
    "rejects unsafe production PORT=%s",
    (port) => {
      expect(() => parseCloudApiEnvironment({ ...productionEnvironment(), PORT: port }))
        .toThrow("PORT 必须是 1-65535 的十进制整数");
    },
  );

  it.each([0, -1, 65_536, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects unsafe explicit startup port %s",
    (port) => {
      expect(() => parseCloudApiEnvironment(productionEnvironment(), { port }))
        .toThrow("PORT 必须是 1-65535 的十进制整数");
    },
  );

  it.each([1, 8081, 65_535])("accepts production PORT=%s", (port) => {
    expect(parseCloudApiEnvironment({ ...productionEnvironment(), PORT: String(port) }).port).toBe(port);
    expect(parseCloudApiEnvironment(productionEnvironment(), { port }).port).toBe(port);
  });
});

describe("EXECUTOR_URL validation", () => {
  it.each([
    ["http://localhost:8082/", "http://localhost:8082"],
    ["http://127.0.0.42:8082", "http://127.0.0.42:8082"],
    ["http://[::1]:8082/", "http://[::1]:8082"],
    ["https://executor.example.com/", "https://executor.example.com"],
    ["https://10.42.0.8/internal/", "https://10.42.0.8/internal"],
  ])("accepts %s", (input, expected) => {
    expect(parseExecutorUrl(input)).toBe(expected);
  });

  it.each([
    "http://10.42.0.8:8082",
    "http://169.254.2.3:8082",
    "http://executor.internal:8082",
    "http://8.8.8.8:8082",
  ])("rejects non-loopback cleartext endpoint %s", (input) => {
    expect(() => parseExecutorUrl(input)).toThrow("必须使用 HTTPS");
  });

  it.each([
    "https://user:password@executor.example.com",
    "https://@executor.example.com",
    "https://executor.example.com?tenant=one",
    "https://executor.example.com?",
    "https://executor.example.com#internal",
    "https://executor.example.com#",
  ])("rejects credentials, query or fragment in %s", (input) => {
    expect(() => parseExecutorUrl(input)).toThrow("不能包含凭据、查询参数或 fragment");
  });

  it.each([
    "ftp://executor.example.com",
    " https://executor.example.com",
    "https://executor.example.com\n",
  ])("rejects malformed or unsafe endpoint %s", (input) => {
    expect(() => parseExecutorUrl(input)).toThrow();
  });
});

describe("CLOUD_API_BIND_HOST validation", () => {
  it.each([
    "127.0.0.1",
    "127.42.0.5",
    "10.0.0.5",
    "172.16.0.5",
    "172.31.255.254",
    "192.168.50.2",
    "169.254.10.4",
    "::1",
    "fd12:3456::8",
    "fe80::1234",
  ])("allows production loopback/private address %s", (host) => {
    expect(parseCloudApiBindHost(host, true)).toBe(host);
  });

  it.each([
    "0.0.0.0",
    "::",
    "8.8.8.8",
    "2001:4860:4860::8888",
    "localhost",
    "127.0.0.1\n",
    "10.0.0.1\u0000example",
  ])("rejects unsafe production bind host %s", (host) => {
    expect(() => parseCloudApiBindHost(host, true)).toThrow();
  });

  it("keeps deliberate non-production hostname/public bindings available", () => {
    expect(parseCloudApiBindHost("localhost", false)).toBe("localhost");
    expect(parseCloudApiBindHost("203.0.113.10", false)).toBe("203.0.113.10");
    expect(() => parseCloudApiBindHost("0.0.0.0", false)).toThrow("unspecified");
  });
});
