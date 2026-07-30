const { app, BrowserWindow } = require("electron");
const { pathToFileURL } = require("node:url");
const { readFileSync, writeFileSync } = require("node:fs");

app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-software-rasterizer");
app.commandLine.appendSwitch("no-sandbox");

const inputPath = process.argv[2];
if (!inputPath) throw new Error("缺少激活窗口 E2E 输入文件");
const input = JSON.parse(readFileSync(inputPath, "utf8"));

async function waitUntil(expression, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const activationWindow = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
    if (activationWindow && await expression(activationWindow)) return activationWindow;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("等待激活窗口状态超时");
}

async function submitCode(window, code) {
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#activation-code');
    input.value = ${JSON.stringify(code)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#activation-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  })()`);
}

async function readPageState(window) {
  return window.webContents.executeJavaScript(`(() => ({
    title: document.title,
    heading: document.querySelector('h1')?.textContent,
    device: document.querySelector('#device')?.textContent,
    message: document.querySelector('#message')?.textContent,
    button: document.querySelector('#submit')?.textContent,
    buttonDisabled: document.querySelector('#submit')?.disabled,
    bridgeKeys: Object.keys(window.longhubActivation || {}),
    hasNode: typeof window.process !== 'undefined' || typeof window.require !== 'undefined',
  }))()`);
}

app.whenReady().then(async () => {
  let attacker;
  const activateCalls = [];
  try {
    const { showActivationWindow } = await import(pathToFileURL(input.activationWindowModule).href);
    const activation = showActivationWindow({
      htmlPath: input.htmlPath,
      preloadPath: input.preloadPath,
      deviceId: input.deviceId,
      async activate(code) {
        activateCalls.push(code);
        if (code !== input.correctCode) throw new Error("授权码无效或已失效");
      },
    });
    const activationWindow = await waitUntil(async (window) => {
      if (window.webContents.isLoading()) return false;
      return window.webContents.executeJavaScript("Boolean(window.longhubActivation && document.querySelector('#activation-code'))");
    });
    const initial = await readPageState(activationWindow);
    const screenshot = await activationWindow.webContents.capturePage();
    writeFileSync(input.screenshotPath, screenshot.toPNG());
    const visual = {
      windowBounds: activationWindow.getBounds(),
      contentBounds: activationWindow.getContentBounds(),
      screenshotSize: screenshot.getSize(),
    };

    attacker = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: input.attackerPreloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    await attacker.loadURL("data:text/html;charset=utf-8,%3Chtml%3E%3Cbody%3Eattacker%3C%2Fbody%3E%3C%2Fhtml%3E");
    const attackerResult = await attacker.webContents.executeJavaScript(
      `window.activationAttacker(${JSON.stringify(input.correctCode)})`,
    );
    attacker.destroy();
    attacker = undefined;

    await submitCode(activationWindow, "not-a-code");
    await waitUntil(async (window) => (await readPageState(window)).message === "请输入正确格式的授权码");
    const malformed = await readPageState(activationWindow);

    await submitCode(activationWindow, input.wrongCode);
    await waitUntil(async (window) => (await readPageState(window)).message === "授权码无效或已失效");
    const rejected = await readPageState(activationWindow);

    await submitCode(activationWindow, input.correctCode);
    const activated = await activation;
    writeFileSync(input.resultPath, JSON.stringify({
      initial,
      visual,
      attackerResult,
      malformed,
      rejected,
      activated,
      activateCalls,
      remainingWindows: BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed()).length,
    }, null, 2));
  } catch (error) {
    writeFileSync(input.resultPath, JSON.stringify({
      error: error instanceof Error ? error.stack : String(error),
      activateCalls,
    }, null, 2));
    process.exitCode = 1;
  } finally {
    if (attacker && !attacker.isDestroyed()) attacker.destroy();
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.destroy();
    }
    app.quit();
  }
});
