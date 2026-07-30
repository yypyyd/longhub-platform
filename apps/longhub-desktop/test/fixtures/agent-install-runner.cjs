const { app, BrowserWindow } = require("electron");
const { readFileSync, writeFileSync } = require("node:fs");

app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-software-rasterizer");
app.commandLine.appendSwitch("no-sandbox");

const inputPath = process.argv[2];
if (!inputPath) throw new Error("缺少 Agent 安装 E2E 输入文件");
const input = JSON.parse(readFileSync(inputPath, "utf8"));

async function waitUntil(webContents, expression, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await webContents.executeJavaScript(`Boolean(${expression})`)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等待 UI 状态超时: ${expression}`);
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 900,
    height: 640,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  let requestedUrl = null;
  let requestCount = 0;
  window.webContents.on("will-navigate", (event, target) => {
    if (!target.startsWith("longhub-agent://")) return;
    event.preventDefault();
    requestedUrl = target;
    requestCount += 1;
    void (async () => {
      await window.webContents.executeJavaScript(input.installedPolicyScript);
      await window.webContents.executeJavaScript(`(() => {
        const select = document.querySelector('select[data-chat-agent-filter="true"]');
        select.focus();
        select.value = ${JSON.stringify(input.agentId)};
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
    })();
  });
  try {
    await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(
      "<!doctype html><html><body><div class='sidebar'><div class='sidebar-brand'>龙枢</div></div></body></html>",
    ));
    await window.webContents.executeJavaScript(`(() => {
      document.body.selectAgent = (agentId) => {
        document.documentElement.dataset.selectedAgent = agentId;
      };
      document.body.sessionRowsByAgent = {};
    })()`);
    await window.webContents.executeJavaScript(input.installPolicyScript);
    await waitUntil(
      window.webContents,
      `document.querySelector('option[data-longhub-install-pack=${JSON.stringify(input.packId)}]')`,
    );
    const before = await window.webContents.executeJavaScript(`(() => {
      const select = document.querySelector('select[data-chat-agent-filter="true"]');
      return Array.from(select.options).map((option) => ({
        value: option.value,
        label: option.textContent,
        installPack: option.dataset.longhubInstallPack || null,
      }));
    })()`);
    await window.webContents.executeJavaScript(input.installingPolicyScript);
    const installing = await window.webContents.executeJavaScript(`(() => {
      const option = document.querySelector('option[data-longhub-install-pack=${JSON.stringify(input.packId)}]');
      return { label: option.textContent, disabled: option.disabled };
    })()`);
    await window.webContents.executeJavaScript(input.errorPolicyScript);
    const failed = await window.webContents.executeJavaScript(`(() => {
      const option = document.querySelector('option[data-longhub-install-pack=${JSON.stringify(input.packId)}]');
      return { label: option.textContent, disabled: option.disabled, title: option.title };
    })()`);
    await window.webContents.executeJavaScript(input.installPolicyScript);
    await window.webContents.executeJavaScript(`(() => {
      const select = document.querySelector('select[data-chat-agent-filter="true"]');
      const option = Array.from(select.options).find(
        (item) => item.dataset.longhubInstallPack === ${JSON.stringify(input.packId)},
      );
      select.focus();
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitUntil(
      window.webContents,
      `document.documentElement.dataset.selectedAgent === ${JSON.stringify(input.agentId)}`,
    );
    const after = await window.webContents.executeJavaScript(`(() => {
      const select = document.querySelector('select[data-chat-agent-filter="true"]');
      return {
        value: select.value,
        options: Array.from(select.options).map((option) => option.value),
        selectedAgent: document.documentElement.dataset.selectedAgent,
        hasNode: typeof window.process !== 'undefined' || typeof window.require !== 'undefined',
      };
    })()`);
    writeFileSync(input.resultPath, JSON.stringify({ before, installing, failed, requestedUrl, requestCount, after }, null, 2));
  } catch (error) {
    let diagnostic = null;
    try {
      diagnostic = await window.webContents.executeJavaScript(`(() => {
        const select = document.querySelector('select[data-chat-agent-filter="true"]');
        return {
          selectedAgent: document.documentElement.dataset.selectedAgent,
          selectValue: select?.value,
          options: Array.from(select?.options || []).map((option) => ({ value: option.value, disabled: option.disabled })),
          hostCount: Array.from(document.querySelectorAll('*')).filter((element) => typeof element.selectAgent === 'function').length,
          policy: window.__longhubSelectorPolicyV1?.snapshot?.(),
        };
      })()`);
    } catch {}
    writeFileSync(input.resultPath, JSON.stringify({
      error: error instanceof Error ? error.stack : String(error),
      requestedUrl,
      requestCount,
      diagnostic,
    }));
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
