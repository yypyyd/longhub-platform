const { app, BrowserWindow, protocol } = require("electron");
const { pathToFileURL } = require("node:url");
const { readFileSync, writeFileSync } = require("node:fs");
const { randomUUID } = require("node:crypto");

app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-software-rasterizer");
app.commandLine.appendSwitch("no-sandbox");
protocol.registerSchemesAsPrivileged([{
  scheme: "longhub-product",
  privileges: { standard: true, secure: true, stream: true },
}]);

const inputPath = process.argv[2];
if (!inputPath) throw new Error("缺少产品扩展 E2E 输入");
const input = JSON.parse(readFileSync(inputPath, "utf8"));

async function waitUntil(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed() && predicate(window));
    if (found && !found.webContents.isLoading()) return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("等待产品扩展窗口超时");
}

app.whenReady().then(async () => {
  let coordinator;
  let attackerWindow;
  let hostWindow;
  try {
    const confirmationResponses = [];
    const skillActions = [];
    const accountActions = [];
    const noCodeActions = [];
    const agentActions = [];
    let allowAccount = false;
    let skillAttempts = 0;
    const skillSnapshot = (installed = false) => ({
      schema_version: "longhub/skill-center/v1",
      agents: [
        { profileId: "longhub.agent.hr", agentId: "longhub-agent-hr", name: "HR 助理" },
        { profileId: "longhub.agent.finance", agentId: "longhub-agent-finance", name: "财务助理" },
      ],
      skills: [{
        skillId: "longhub.skill.resume-screen",
        name: "简历初筛",
        description: "按岗位条件生成结构化初筛结果",
        category: "招聘",
        publisher: "龙枢官方",
        latestVersion: "1.0.0",
        ...(installed ? { installedVersion: "1.0.0" } : {}),
        runtimeKind: "builtin",
        actionLabel: "启用",
        executionLabel: "本机内置能力",
        requestedPermissions: ["connector:hr-api:read"],
        confirmationClass: "none",
        maxCostMicros: 12000,
        entitled: true,
        bindings: installed ? [{ agentId: "longhub-agent-hr", enabled: true }] : [],
      }],
    });
    let noCodeSnapshot = {
      agents: [
        { profileId: "longhub.agent.hr", agentId: "longhub-agent-hr", name: "HR 助理" },
        { profileId: "longhub.agent.finance", agentId: "longhub-agent-finance", name: "财务助理" },
      ],
      contentSkills: [], workflows: [], overlays: [],
    };
    let agentManagementSnapshot = {
      currentAgentId: "longhub-agent-hr",
      agents: [
        { agentId: "main", name: "龙枢助手", enabled: true, builtIn: true },
        { agentId: "longhub-agent-hr", name: "HR 助理", packId: "longhub.pack.hr", enabled: true, builtIn: false },
        { agentId: "longhub-agent-finance", name: "财务助理", packId: "longhub.pack.finance", enabled: true, builtIn: false },
      ],
      installableAgents: [{ packId: "longhub.pack.legal", version: "1.0.0", agentId: "longhub-agent-legal", label: "法务助理", state: "ready" }],
    };
    const module = await import(pathToFileURL(input.coordinatorModule).href);
    hostWindow = new BrowserWindow({
      show: false,
      frame: false,
      width: 1120,
      height: 720,
    });
    coordinator = new module.ProductExtensionWindowCoordinator({
      assetsDir: input.assetsDir,
      preloadPath: input.preloadPath,
      iconPath: input.iconPath,
      parentWindow: () => hostWindow,
      isEntryAllowed: (entry) => entry === "agents" || entry === "skills" || (entry === "account" && allowAccount),
      agentCenter: {
        read: () => structuredClone(agentManagementSnapshot),
        perform: async (params) => {
          agentActions.push(params);
          if (params.action === "select") agentManagementSnapshot.currentAgentId = params.agentId;
          if (params.action === "disable") {
            agentManagementSnapshot.agents = agentManagementSnapshot.agents.map((agent) =>
              agent.packId === params.packId ? { ...agent, enabled: false } : agent);
          }
          if (params.action === "enable") {
            agentManagementSnapshot.agents = agentManagementSnapshot.agents.map((agent) =>
              agent.packId === params.packId ? { ...agent, enabled: true } : agent);
          }
          if (params.action === "install") agentManagementSnapshot.installableAgents = [];
          return structuredClone(agentManagementSnapshot);
        },
      },
      skillCenter: {
        read: async () => skillSnapshot(false),
        perform: async (params) => {
          skillActions.push(params);
          skillAttempts += 1;
          if (skillAttempts === 1) throw new Error("simulated gateway failure");
          return skillSnapshot(true);
        },
      },
      noCodeCenter: {
        read: () => structuredClone(noCodeSnapshot),
        perform: async (params) => {
          noCodeActions.push(params);
          if (params.action === "content.create") {
            noCodeSnapshot.contentSkills = [{ skillId: "user.skill.11111111-1111-4111-8111-111111111111", name: params.name, description: params.description, source: "user_local" }];
          } else if (params.action === "workflow.create") {
            noCodeSnapshot.workflows = [{ workflowId: "user.workflow.11111111-1111-4111-8111-111111111111", name: params.name, stepCount: 1 }];
          } else if (params.action === "workflow.run") {
            noCodeSnapshot.lastWorkflowRun = { runId: "workflow-run-e2e", outputs: { first: "ok" }, costMicros: 0, executedSteps: 1 };
          } else if (params.action === "agent.create") {
            noCodeSnapshot.overlays = [{
              schemaVersion: "longhub/nocode-agent-overlay/v1", overlayId: "user.agent.11111111-1111-4111-8111-111111111111",
              baseProfileId: params.baseProfileId, targetAgentId: params.targetAgentId, name: params.name,
              description: params.description, preferences: { language: params.language, tone: params.tone },
              personalEntryIds: params.personalEntryIds, skillIds: params.skillIds,
            }];
          } else if (params.action === "handoff.preview") {
            noCodeSnapshot.pendingHandoff = {
              handoffId: "11111111-1111-4111-8111-111111111111", sourceAgentId: params.sourceAgentId,
              targetAgentId: params.targetAgentId, summary: params.summary, digest: "a".repeat(64),
              expiresAt: new Date(Date.now() + 300000).toISOString(), confirmationToken: "b".repeat(43),
            };
          } else if (params.action === "handoff.confirm") {
            delete noCodeSnapshot.pendingHandoff;
            noCodeSnapshot.completedHandoff = {
              targetAgentId: params.targetAgentId,
              message: "用户确认转交以下摘要：候选人已接受报价。",
              inheritedPermissions: [], inheritedMemory: [],
            };
          }
          return structuredClone(noCodeSnapshot);
        },
      },
      dataCenter: {
        read: async (agentId = "longhub-agent-hr") => ({
          agents: [{ agentId: "longhub-agent-hr", name: "HR 助理" }, { agentId: "longhub-agent-finance", name: "财务助理" }],
          selectedAgentId: agentId,
          sessions: [{ key: `${agentId}:session-1`, agentId, label: "候选人沟通", archived: false }],
          trashedSessions: [],
          personalEntries: [{ entryId: "entry-1", agentId, title: "我的简历", createdAt: "2026-07-31T00:00:00.000Z" }],
          citations: [],
          attachments: [],
          searchQuery: "",
        }),
        perform: async (params) => {
          accountActions.push(params);
          return {
            agents: [{ agentId: "longhub-agent-hr", name: "HR 助理" }, { agentId: "longhub-agent-finance", name: "财务助理" }],
            selectedAgentId: params.agentId,
            sessions: [{ key: `${params.agentId}:session-1`, agentId: params.agentId, label: "候选人沟通", archived: false }],
            trashedSessions: [],
            personalEntries: [{ entryId: "entry-1", agentId: params.agentId, title: "我的简历", createdAt: "2026-07-31T00:00:00.000Z" }],
            citations: params.action === "knowledge.query" ? [{ agentId: params.agentId, documentId: "doc-1", title: "差旅制度", sourceLabel: "员工手册", snippet: "十个工作日内报销" }] : [],
            attachments: [],
            searchQuery: "",
          };
        },
      },
      respondConfirmation: async (request, approved) => {
        confirmationResponses.push({ confirmationId: request.confirmationId, approved });
      },
    });
    await coordinator.start();
    const opened = await coordinator.open("agents");
    const denied = await coordinator.open("account");
    const extensionWindow = await waitUntil((window) =>
      window.webContents.getURL() === "longhub-product://app/agents");
    await extensionWindow.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const done = () => document.querySelector("#agents-status")?.textContent.includes("当前智能体");
        if (done()) return resolve();
        const observer = new MutationObserver(() => {
          if (done()) { observer.disconnect(); resolve(); }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      })
    `);
    const agentSwitch = await extensionWindow.webContents.executeJavaScript(`new Promise((resolve) => {
      document.querySelector(".agent-row:nth-child(3) .agent-row__actions .primary")?.click();
      setTimeout(() => resolve({
        current: document.querySelector('.agent-row[data-current="true"] strong')?.textContent,
        status: document.querySelector('#agents-status')?.textContent,
      }), 300);
    })`);
    await extensionWindow.webContents.executeJavaScript(`
      document.querySelector("#content-name").value = "招聘写作规范";
      document.querySelector("#content-description").value = "统一语气";
      document.querySelector("#content-instructions").value = "只使用可核验信息。";
      document.querySelector("#content-create").click();
    `);
    await extensionWindow.webContents.executeJavaScript(`new Promise((resolve) => {
      const done = () => document.querySelector("#content-list strong")?.textContent === "招聘写作规范";
      if (done()) return resolve();
      const observer = new MutationObserver(() => { if (done()) { observer.disconnect(); resolve(); } });
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    })`);
    await extensionWindow.webContents.executeJavaScript(`
      document.querySelector("#workflow-name").value = "安全筛选";
      document.querySelector("#workflow-steps").value = JSON.stringify([{id:"first",kind:"skill",skillId:"user.skill.11111111-1111-4111-8111-111111111111",input:{}}]);
      document.querySelector("#workflow-create").click();
    `);
    await extensionWindow.webContents.executeJavaScript(`new Promise((resolve) => {
      const done = () => document.querySelector("#workflow-list strong")?.textContent === "安全筛选";
      if (done()) return resolve();
      const observer = new MutationObserver(() => { if (done()) { observer.disconnect(); resolve(); } });
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    })`);
    await extensionWindow.webContents.executeJavaScript(`
      document.querySelector("#overlay-name").value = "我的招聘助手";
      document.querySelector("#overlay-description").value = "使用设备本地偏好";
      document.querySelector("#overlay-create").click();
    `);
    await extensionWindow.webContents.executeJavaScript(`new Promise((resolve) => {
      const done = () => document.querySelector("#overlay-list strong")?.textContent === "我的招聘助手";
      if (done()) return resolve();
      const observer = new MutationObserver(() => { if (done()) { observer.disconnect(); resolve(); } });
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    })`);
    await extensionWindow.webContents.executeJavaScript(`
      document.querySelector("#handoff-summary").value = "候选人已接受报价。";
      document.querySelector("#handoff-preview").click();
    `);
    await extensionWindow.webContents.executeJavaScript(`new Promise((resolve) => {
      const done = () => document.querySelector("#handoff-result .primary");
      if (done()) return resolve();
      const observer = new MutationObserver(() => { if (done()) { observer.disconnect(); resolve(); } });
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    })`);
    await extensionWindow.webContents.executeJavaScript('document.querySelector("#handoff-result .primary").click()');
    await extensionWindow.webContents.executeJavaScript(`new Promise((resolve) => {
      const done = () => document.querySelector("#handoff-result")?.textContent.includes("继承权限 0");
      if (done()) return resolve();
      const observer = new MutationObserver(() => { if (done()) { observer.disconnect(); resolve(); } });
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    })`);
    const state = await extensionWindow.webContents.executeJavaScript(`({
      url: location.href,
      title: document.title,
      heading: document.querySelector("#title")?.textContent,
      status: document.querySelector("#agents-status")?.textContent,
      content: document.querySelector("#content-list strong")?.textContent,
      workflow: document.querySelector("#workflow-list strong")?.textContent,
      overlay: document.querySelector("#overlay-list strong")?.textContent,
      handoff: document.querySelector("#handoff-result")?.textContent,
      bridgeKeys: Object.keys(window.longhubProduct || {}).sort(),
      hasNode: typeof window.process !== "undefined" || typeof window.require !== "undefined",
    })`);
    const bounds = extensionWindow.getBounds();
    const image = await extensionWindow.webContents.capturePage();
    writeFileSync(input.screenshotPath, image.toPNG());

    await extensionWindow.webContents.executeJavaScript(
      'location.href = "longhub-product://app/settings"',
    ).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterForbiddenNavigation = extensionWindow.webContents.getURL();

    const skillOpened = await coordinator.open("skills");
    let skillWindow = await waitUntil((window) =>
      window.webContents.getURL() === "longhub-product://app/skills");
    await skillWindow.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const done = () => document.querySelector(".skill-card h3")?.textContent === "简历初筛";
        if (done()) return resolve();
        const observer = new MutationObserver(() => {
          if (done()) { observer.disconnect(); resolve(); }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      })
    `);
    const skillPreview = await skillWindow.webContents.executeJavaScript(`({
      title: document.title,
      action: document.querySelector(".skill-card .primary")?.textContent,
      meta: [...document.querySelectorAll(".skill-meta span")].map((item) => item.textContent),
      permission: document.querySelector(".skill-permissions li")?.textContent,
      agents: [...document.querySelectorAll("#skill-agent option")].map((item) => item.textContent),
      bridgeKeys: Object.keys(window.longhubProduct || {}).sort(),
      hasNode: typeof window.process !== "undefined" || typeof window.require !== "undefined",
    })`);
    await skillWindow.webContents.executeJavaScript('document.querySelector(".skill-card .primary").click()');
    await skillWindow.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const done = () => document.querySelector("#skills-status")?.textContent.includes("状态已恢复");
        if (done()) return resolve();
        const observer = new MutationObserver(() => {
          if (done()) { observer.disconnect(); resolve(); }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      })
    `);
    const firstSkillFailure = await skillWindow.webContents.executeJavaScript(
      'document.querySelector("#skills-status")?.textContent',
    );
    await skillWindow.webContents.executeJavaScript("void window.longhubProduct.close(); true");
    await new Promise((resolve) => setTimeout(resolve, 150));

    allowAccount = true;
    const accountOpened = await coordinator.open("account");
    const accountWindow = await waitUntil((window) => window.webContents.getURL() === "longhub-product://app/account");
    await accountWindow.webContents.executeJavaScript(`new Promise((resolve) => {
      const done = () => document.querySelector("#session-list .data-row input")?.value === "候选人沟通";
      if (done()) return resolve();
      const observer = new MutationObserver(() => { if (done()) { observer.disconnect(); resolve(); } });
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    })`);
    const accountPreview = await accountWindow.webContents.executeJavaScript(`({
      title: document.title,
      agents: [...document.querySelectorAll("#account-agent option")].map((item) => item.textContent),
      session: document.querySelector("#session-list .data-row input")?.value,
      profile: document.querySelector("#profile-list .data-row p")?.textContent,
      bridgeKeys: Object.keys(window.longhubProduct || {}).sort(),
      hasNode: typeof window.process !== "undefined" || typeof window.require !== "undefined",
    })`);
    await accountWindow.webContents.executeJavaScript(`
      document.querySelector("#knowledge-query").value = "差旅 报销";
      document.querySelector("#knowledge-search").click();
    `);
    await accountWindow.webContents.executeJavaScript(`new Promise((resolve) => {
      const done = () => document.querySelector("#citation-list strong")?.textContent === "差旅制度";
      if (done()) return resolve();
      const observer = new MutationObserver(() => { if (done()) { observer.disconnect(); resolve(); } });
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    })`);
    const accountCitation = await accountWindow.webContents.executeJavaScript(`({
      title: document.querySelector("#citation-list strong")?.textContent,
      source: document.querySelectorAll("#citation-list p")[0]?.textContent,
      snippet: document.querySelectorAll("#citation-list p")[1]?.textContent,
    })`);
    await accountWindow.webContents.executeJavaScript("void window.longhubProduct.close(); true");
    await new Promise((resolve) => setTimeout(resolve, 150));
    await coordinator.open("skills");
    skillWindow = await waitUntil((window) => window.webContents.getURL() === "longhub-product://app/skills");
    await skillWindow.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const button = () => document.querySelector(".skill-card .primary");
        if (button()) return resolve();
        const observer = new MutationObserver(() => {
          if (button()) { observer.disconnect(); resolve(); }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
      })
    `);
    await skillWindow.webContents.executeJavaScript('document.querySelector(".skill-card .primary").click()');
    await skillWindow.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const done = () => document.querySelector("#skills-status")?.textContent === "启用成功";
        if (done()) return resolve();
        const observer = new MutationObserver(() => {
          if (done()) { observer.disconnect(); resolve(); }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      })
    `);
    const skillAfterRetry = await skillWindow.webContents.executeJavaScript(`({
      status: document.querySelector("#skills-status")?.textContent,
      action: document.querySelector(".skill-card .primary")?.textContent,
      installed: [...document.querySelectorAll(".skill-meta span")].map((item) => item.textContent).find((item) => item.startsWith("版本 ")),
    })`);
    await skillWindow.webContents.executeJavaScript("void window.longhubProduct.close(); true");
    await new Promise((resolve) => setTimeout(resolve, 150));

    attackerWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: input.attackerPreloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    await attackerWindow.loadURL("data:text/html,attacker");
    const attacker = await attackerWindow.webContents.executeJavaScript(
      'window.attackProduct().then(() => ({ok:true}), (error) => ({ok:false, message:error.message}))',
    );
    attackerWindow.destroy();
    attackerWindow = undefined;

    const confirmationRequest = {
      confirmationId: "confirm-" + randomUUID(),
      skillId: "longhub.skill.offer-letter",
      agentId: "agent-hr",
      profileVersion: "1.0.0",
      sessionId: "session-1",
      toolCallId: "call-1",
      permissions: ["connector:hr-api:write"],
      payloadDigest: "a".repeat(64),
      display: {
        action: "生成录用通知书",
        object: "候选人录用通知",
        recipient: "张三",
        dataScope: ["岗位：前端工程师", "月薪（人民币元）：30000", "入职日期：2026-08-15"],
        estimatedCostCents: 0,
      },
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    };
    const confirmationOpened = await coordinator.openConfirmation(confirmationRequest);
    const confirmationWindow = await waitUntil((window) =>
      window.webContents.getURL() === "longhub-product://app/confirmations");
    await confirmationWindow.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const done = () => document.querySelector("#confirmation-agent")?.textContent === "agent-hr";
        if (done()) return resolve();
        const observer = new MutationObserver(() => {
          if (done()) { observer.disconnect(); resolve(); }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      })
    `);
    const confirmationState = await confirmationWindow.webContents.executeJavaScript(`({
      action: document.querySelector("#confirmation-action")?.textContent,
      agent: document.querySelector("#confirmation-agent")?.textContent,
      skill: document.querySelector("#confirmation-skill")?.textContent,
      recipient: document.querySelector("#confirmation-recipient")?.textContent,
      data: [...document.querySelectorAll("#confirmation-data li")].map((item) => item.textContent),
      permission: document.querySelector("#confirmation-permissions li")?.textContent,
      cost: document.querySelector("#confirmation-cost")?.textContent,
      bridgeKeys: Object.keys(window.longhubProduct || {}).sort(),
      hasNode: typeof window.process !== "undefined" || typeof window.require !== "undefined",
    })`);
    await confirmationWindow.webContents.executeJavaScript(
      'document.querySelector("#approve").click()',
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const closedRequest = {
      ...confirmationRequest,
      confirmationId: "confirm-" + randomUUID(),
      toolCallId: "call-close",
      payloadDigest: "b".repeat(64),
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    };
    await coordinator.openConfirmation(closedRequest);
    const closedWindow = await waitUntil((window) =>
      window.webContents.getURL() === "longhub-product://app/confirmations");
    void closedWindow.webContents.executeJavaScript("window.longhubProduct.close()")
      .catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 200));

    writeFileSync(input.resultPath, JSON.stringify({
      opened,
      denied,
      state,
      bounds,
      afterForbiddenNavigation,
      skillOpened,
      skillPreview,
      firstSkillFailure,
      skillAfterRetry,
      skillActions,
      accountOpened,
      accountPreview,
      accountCitation,
      accountActions,
      noCodeActions,
      agentActions,
      agentSwitch,
      attacker,
      confirmationOpened,
      confirmationState,
      confirmationResponses,
      screenshot: image.getSize(),
      remainingWindowsBeforeClose:
        BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed()).length,
    }, null, 2));
  } catch (error) {
    writeFileSync(input.resultPath, JSON.stringify({
      error: error instanceof Error ? error.stack : String(error),
    }, null, 2));
    process.exitCode = 1;
  } finally {
    if (attackerWindow && !attackerWindow.isDestroyed()) attackerWindow.destroy();
    coordinator?.dispose();
    if (hostWindow && !hostWindow.isDestroyed()) hostWindow.destroy();
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.destroy();
    }
    app.quit();
  }
});
