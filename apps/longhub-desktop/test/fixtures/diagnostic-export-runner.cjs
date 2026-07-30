const { app, BrowserWindow } = require("electron");
const { readFileSync, writeFileSync } = require("node:fs");

app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-software-rasterizer");
app.commandLine.appendSwitch("no-sandbox");

const inputPath = process.argv[2];
if (!inputPath) throw new Error("缺少诊断导出 E2E 输入文件");
const input = JSON.parse(readFileSync(inputPath, "utf8"));

async function waitUntil(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("等待诊断导出导航超时");
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
    event.preventDefault();
    if (target !== input.expectedUrl) return;
    requestedUrl = target;
    requestCount += 1;
  });
  try {
    await window.loadURL(input.pageUrl);
    const before = await window.webContents.executeJavaScript(`(() => ({
      title: document.title,
      linkText: document.querySelector('a.diagnostic')?.textContent,
      linkHref: document.querySelector('a.diagnostic')?.href,
      csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content,
      hasNode: typeof window.process !== 'undefined' || typeof window.require !== 'undefined',
    }))()`);
    await window.webContents.executeJavaScript("document.querySelector('a.diagnostic').click()");
    await waitUntil(() => requestCount === 1);
    writeFileSync(input.resultPath, JSON.stringify({ before, requestedUrl, requestCount }, null, 2));
  } catch (error) {
    writeFileSync(input.resultPath, JSON.stringify({
      error: error instanceof Error ? error.stack : String(error),
      requestedUrl,
      requestCount,
    }));
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
