const { app, BrowserWindow } = require("electron");
const { readFileSync, writeFileSync } = require("node:fs");

app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-software-rasterizer");
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("force-device-scale-factor", "1");

const inputPath = process.argv[2];
if (!inputPath) throw new Error("缺少 Selector E2E 输入文件");
const input = JSON.parse(readFileSync(inputPath, "utf8"));

async function waitUntil(webContents, expression, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await webContents.executeJavaScript(`Boolean(${expression})`)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待 UI 状态超时: ${expression}`);
}

async function selectorSnapshot(webContents) {
  return webContents.executeJavaScript(`(() => {
    const select = document.querySelector('select[data-chat-agent-filter="true"]');
    return select ? {
      value: select.value,
      options: Array.from(select.options).map((option) => ({ value: option.value, label: option.textContent.trim() })),
      session: new URL(location.href).searchParams.get('session'),
      policy: select.dataset.longhubSelectorPolicy || null,
    } : null;
  })()`);
}

async function selectAgent(webContents, agentId) {
  await webContents.executeJavaScript(`(() => {
    const select = document.querySelector('select[data-chat-agent-filter="true"]');
    select.focus();
    select.value = ${JSON.stringify(agentId)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: input.viewport.width,
    height: input.viewport.height,
    useContentSize: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  try {
    await window.loadURL(input.controlUiUrl);
    await waitUntil(window.webContents, `Array.from(document.querySelectorAll('*')).some((element) => typeof element.selectAgent === 'function')`);
    await window.webContents.insertCSS(input.productCss + `
      *, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }
    `);
    await window.webContents.executeJavaScript(input.productUiScript);
    await window.webContents.executeJavaScript(input.policyScript);
    await waitUntil(window.webContents, `document.documentElement.dataset.longhubProductUi === 'v1'`);
    await waitUntil(window.webContents, `document.querySelectorAll('select[data-chat-agent-filter="true"] option').length >= 2`);
    await waitUntil(window.webContents, `document.querySelector('select[data-chat-agent-filter="true"]')?.dataset.longhubSelectorPolicy === 'v1'`);
    const initial = await selectorSnapshot(window.webContents);
    const uiContract = await window.webContents.executeJavaScript(`(() => {
      const visible = (element) => {
        if (!element) return false;
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden';
      };
      const modelSelectors = ${JSON.stringify(input.modelControlSelectors)};
      const restrictedSelectors = ${JSON.stringify(input.restrictedNavigationSelectors)};
      const ordinaryUserHiddenSelectors = ${JSON.stringify(input.ordinaryUserHiddenSelectors)};
      return {
        contractDigest: ${JSON.stringify(input.contractDigest)},
        agentSelectorVisible: visible(document.querySelector('select[data-chat-agent-filter="true"]')),
        agentLabels: Array.from(document.querySelector('select[data-chat-agent-filter="true"]')?.options ?? [])
          .map((option) => option.textContent.trim()),
        brandHostCount: document.querySelectorAll('.sidebar-brand').length,
        brandText: (() => {
          const brand = document.querySelector('.sidebar-brand')?.cloneNode(true);
          brand?.querySelector?.('.longhub-agent-scope')?.remove();
          return brand?.textContent?.replace(/\\s+/g, ' ').trim() ?? '';
        })(),
        htmlLang: document.documentElement.lang || '',
        documentTitle: document.title,
        productPolicy: document.documentElement.dataset.longhubProductUi || null,
        brandedLogo: document.querySelector('.sidebar-brand__logo')?.src.startsWith('data:image/') ?? false,
        recentSessionTitleVisible: document.body.innerText.includes('HR 最近会话'),
        internalSessionKeyVisible: document.body.innerText.includes('agent:') ||
          Array.from(document.querySelectorAll('[title]')).some((element) => element.title.includes('agent:')),
        visibleInfrastructureTerms: ['OpenClaw', 'Gateway', 'Token', 'Provider', 'longhub-default']
          .filter((term) => document.body.innerText.includes(term)),
        defaultSessionTitleVisible: document.body.innerText.includes('龙枢助手会话'),
        visibleEnglishTerms: ['Main Session', 'Done', 'responding'].filter((term) => document.body.innerText.includes(term)),
        visibleAdminWelcomeSuggestions: Array.from(document.querySelectorAll('.agent-chat__suggestion'))
          .filter((element) => visible(element) && ['Help me configure a channel', 'Check system health'].includes(element.textContent.trim())).length,
        selectAgentHost: Array.from(document.querySelectorAll('*')).some(
          (element) => typeof element[${JSON.stringify(input.selectAgentMethod)}] === 'function',
        ),
        visibleModelControls: modelSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))).filter(visible).length,
        visibleRestrictedNavigation: restrictedSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))).filter(visible).length,
        visibleOrdinaryUserHidden: ordinaryUserHiddenSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))).filter(visible).length,
        hasNode: typeof window.process !== 'undefined' || typeof window.require !== 'undefined',
      };
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const screenshot = await window.webContents.capturePage(input.stableCaptureRect);
    const size = screenshot.getSize();
    const normalized = screenshot.resize({ width: 120, height: 80, quality: "good" }).toBitmap();
    let red = 0;
    let green = 0;
    let blue = 0;
    let dark = 0;
    let light = 0;
    let edges = 0;
    const luminance = [];
    for (let index = 0; index < normalized.length; index += 4) {
      const b = normalized[index];
      const g = normalized[index + 1];
      const r = normalized[index + 2];
      const luma = Math.round((r * 299 + g * 587 + b * 114) / 1000);
      red += r;
      green += g;
      blue += b;
      dark += luma < 96 ? 1 : 0;
      light += luma > 224 ? 1 : 0;
      luminance.push(luma);
    }
    const bitmapWidth = 120;
    for (let index = 0; index < luminance.length; index += 1) {
      if (index % bitmapWidth !== 0 && Math.abs(luminance[index] - luminance[index - 1]) > 32) edges += 1;
      if (index >= bitmapWidth && Math.abs(luminance[index] - luminance[index - bitmapWidth]) > 32) edges += 1;
    }
    const pixels = luminance.length;
    const visualBaseline = {
      viewport: input.viewport,
      capture: { width: size.width, height: size.height },
      signature: {
        meanRgb: [red, green, blue].map((value) => Math.round(value / pixels)),
        darkRatio: Number((dark / pixels).toFixed(4)),
        lightRatio: Number((light / pixels).toFixed(4)),
        edgeDensity: Number((edges / (pixels * 2)).toFixed(4)),
      },
    };

    await selectAgent(window.webContents, input.hrAgentId);
    await waitUntil(
      window.webContents,
      `new URL(location.href).searchParams.get('session') === ${JSON.stringify(input.latestHrSessionKey)}`,
    );
    const restoredHr = await selectorSnapshot(window.webContents);

    await selectAgent(window.webContents, "main");
    await waitUntil(window.webContents, `new URL(location.href).searchParams.get('session') === 'agent:main:main'`);

    const blockedImmediately = await window.webContents.executeJavaScript(`(() => {
      const marker = document.createElement('button');
      marker.className = 'chat-send-btn--stop';
      marker.addEventListener('click', () => {
        document.documentElement.dataset.longhubStopClicked = 'true';
        window.setTimeout(() => marker.remove(), 50);
      });
      document.body.append(marker);
      window.confirm = () => true;
      const select = document.querySelector('select[data-chat-agent-filter="true"]');
      select.focus();
      select.value = ${JSON.stringify(input.hrAgentId)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        selected: select.value,
        stopClicked: document.documentElement.dataset.longhubStopClicked === 'true',
      };
    })()`);
    await waitUntil(
      window.webContents,
      `document.documentElement.dataset.longhubStopClicked === 'true' && new URL(location.href).searchParams.get('session') === ${JSON.stringify(input.latestHrSessionKey)}`,
    );
    const switchedAfterStop = await selectorSnapshot(window.webContents);

    await window.webContents.executeJavaScript(input.removalPolicyScript);
    await waitUntil(
      window.webContents,
      `!Array.from(document.querySelector('select[data-chat-agent-filter="true"]')?.options ?? []).some((option) => option.value === ${JSON.stringify(input.hrAgentId)})`,
    );
    await window.loadURL(input.mainFallbackUrl);
    await waitUntil(window.webContents, `document.querySelector('.sidebar-brand')`);
    await window.webContents.insertCSS(input.productCss);
    await window.webContents.executeJavaScript(input.productUiScript);
    await window.webContents.executeJavaScript(input.removalPolicyScript);
    await waitUntil(window.webContents, `!document.querySelector('select[data-chat-agent-filter="true"]') || document.querySelector('select[data-chat-agent-filter="true"]')?.value === 'main'`);
    const afterRemovalSelector = await selectorSnapshot(window.webContents);
    const afterRemoval = afterRemovalSelector ?? await window.webContents.executeJavaScript(`({
      value: 'main',
      options: [],
      session: new URL(location.href).searchParams.get('session'),
      policy: 'v1',
    })`);

    writeFileSync(input.resultPath, JSON.stringify({
      initial,
      uiContract,
      visualBaseline,
      restoredHr,
      blockedImmediately,
      switchedAfterStop,
      afterRemoval,
    }, null, 2));
  } catch (error) {
    let diagnostic = null;
    try {
      diagnostic = await window.webContents.executeJavaScript(`({
        url: location.href,
        title: document.title,
        body: document.body?.innerText?.slice(0, 2000) ?? '',
        selectors: document.querySelectorAll('select').length,
        agentSelectors: document.querySelectorAll('select[data-chat-agent-filter="true"]').length,
        selectHtml: Array.from(document.querySelectorAll('select')).map((select) => select.outerHTML.slice(0, 500)),
        appKeys: Object.keys(document.querySelector('openclaw-app') ?? {}).filter((key) => /agent|session/i.test(key)),
      })`);
    } catch {}
    writeFileSync(input.resultPath, JSON.stringify({
      error: error instanceof Error ? error.stack : String(error),
      diagnostic,
    }));
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
