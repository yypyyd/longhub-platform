import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

function parseCli(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error(`无效参数: ${key ?? "missing"}`);
    options[key.slice(2)] = resolve(value);
  }
  for (const key of ["node", "electron", "asar", "openclaw", "bridge"]) {
    if (!options[key]) throw new Error(`缺少 --${key}`);
  }
  return options;
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

async function requestLine(child, request, timeoutMs = 20_000) {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.stdin.write(`${JSON.stringify(request)}\n`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const line = stdout.split(/\r?\n/).find((item) => item.trim());
    if (line) return JSON.parse(line);
    if (child.exitCode !== null) throw new Error(`打包子进程提前退出 (${child.exitCode}): ${stderr}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`打包子进程响应超时: ${stderr}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([once(child, "exit"), new Promise((resolveWait) => setTimeout(resolveWait, 5_000))]);
}

async function verifyAsarNodeProcesses(options) {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  const core = spawn(options.electron, [join(options.asar, "dist", "core-process.js")], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  try {
    const hello = await requestLine(core, { rpc: "1.0", id: "release-core", method: "core.hello", params: {} });
    if (hello.id !== "release-core" || hello.error || !hello.result) throw new Error("ASAR Core hello 响应无效");
  } finally {
    await stopChild(core);
  }

  const worker = spawn(options.electron, [join(options.asar, "dist", "skill-worker.js")], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  try {
    const echo = await requestLine(worker, {
      rpc: "1.0",
      id: "release-worker",
      method: "skill.execute",
      params: {
        skillId: "longhub.skill.echo-upper",
        input: { text: "asar" },
        grantedPermissions: [],
        taskId: "release-worker",
      },
    });
    if (echo.error || echo.result?.text !== "ASAR") throw new Error("ASAR Skill Worker 执行结果无效");
  } finally {
    await stopChild(worker);
  }
}

async function verifyExternalOpenClaw(options, stateDir) {
  const version = spawnSync(options.node, [options.openclaw, "--version"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (version.status !== 0 || !version.stdout.includes("2026.7.1-2")) {
    throw new Error(`打包 OpenClaw 版本检查失败: ${version.stderr || version.stdout}`);
  }

  const workspace = join(stateDir, "workspace");
  const agentDir = join(stateDir, "agents", "main", "agent");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  const configPath = join(stateDir, "openclaw.json");
  writeFileSync(configPath, JSON.stringify({
    gateway: { mode: "local" },
    agents: {
      defaults: {
        workspace,
        skipBootstrap: true,
        model: { primary: "longhub/longhub-default" },
        models: { "longhub/longhub-default": { alias: "龙枢默认模型" } },
      },
      list: [{
        id: "main",
        default: true,
        name: "龙枢助手",
        workspace,
        agentDir,
        model: { primary: "longhub/longhub-default" },
        identity: { name: "龙枢助手", emoji: "🐉" },
        memorySearch: { enabled: true, sources: ["memory"] },
        subagents: { allowAgents: [], requireAgentId: true },
        tools: {
          deny: ["agents_list", "sessions_history", "sessions_list", "sessions_send", "sessions_spawn"],
          elevated: { enabled: false },
        },
      }],
    },
    models: {
      mode: "replace",
      providers: {
        longhub: {
          baseUrl: "https://cloud.invalid/v1/model",
          apiKey: "${LONGHUB_MODEL_TOKEN}",
          api: "openai-completions",
          models: [{
            id: "longhub-default",
            name: "龙枢默认模型",
            reasoning: false,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          }],
        },
      },
    },
    plugins: {
      enabled: true,
      allow: ["longhub-tool-bridge"],
      load: { paths: [options.bridge] },
      entries: { "longhub-tool-bridge": { enabled: true } },
    },
    tools: { agentToAgent: { enabled: false, allow: [] } },
  }), "utf8");

  const token = randomBytes(32).toString("hex");
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_GATEWAY_TOKEN: token,
    LONGHUB_MODEL_TOKEN: "release-device-token",
    LONGHUB_BRIDGE_URL: "http://127.0.0.1:9",
    LONGHUB_BRIDGE_TOKEN: randomBytes(32).toString("hex"),
    OPENCLAW_DISABLE_BONJOUR: "1",
    OPENCLAW_EXEC_SHELL_SNAPSHOT: "0",
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_SKIP_CHANNELS: "1",
  };
  const inspect = spawnSync(options.node, [
    options.openclaw,
    "plugins",
    "inspect",
    "longhub-tool-bridge",
    "--runtime",
    "--json",
  ], { env, encoding: "utf8", windowsHide: true, timeout: 120_000 });
  let inspected;
  try {
    inspected = JSON.parse(inspect.stdout);
  } catch {
    // 统一在下方输出可诊断结果。
  }
  if (
    inspect.status !== 0 ||
    inspected?.plugin?.id !== "longhub-tool-bridge" ||
    inspected?.plugin?.status !== "loaded" ||
    inspected?.plugin?.activated !== true ||
    !inspected?.plugin?.toolNames?.includes("longhub_resume_screen")
  ) {
    throw new Error(
      `打包 Bridge 插件加载失败: ${inspect.error?.message ?? inspect.stderr ?? ""}\n${inspect.stdout ?? ""}`,
    );
  }

  const port = await freePort();
  const gateway = spawn(options.node, [
    options.openclaw,
    "gateway",
    "--port",
    String(port),
    "--auth",
    "token",
  ], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stderr = "";
  gateway.stderr.on("data", (chunk) => { stderr += String(chunk); });
  try {
    const deadline = Date.now() + 120_000;
    let body = "";
    while (Date.now() < deadline) {
      if (gateway.exitCode !== null) throw new Error(`打包 Gateway 提前退出 (${gateway.exitCode}): ${stderr}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/chat`);
        if (response.ok) {
          body = await response.text();
          break;
        }
      } catch {
        // 首次迁移尚未完成。
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
    if (!body.toLowerCase().includes("openclaw")) throw new Error(`打包 Gateway /chat 未就绪: ${stderr}`);
  } finally {
    await stopChild(gateway);
  }
  return version.stdout.trim();
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const stateDir = mkdtempSync(join(tmpdir(), "longhub-packaged-runtime-"));
  try {
    await verifyAsarNodeProcesses(options);
    const openclawVersion = await verifyExternalOpenClaw(options, stateDir);
    process.stdout.write(`${JSON.stringify({ core: true, worker: true, bridge: true, gateway: true, openclawVersion })}\n`);
  } finally {
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
