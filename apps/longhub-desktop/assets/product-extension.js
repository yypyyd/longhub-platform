(() => {
  "use strict";
  const api = window.longhubProduct;
  const labels = { agents: "智能体", skills: "能力", account: "我的" };
  const descriptions = {
    agents: "查看和切换由龙枢策略允许的智能体。",
    skills: "查看可用于当前智能体的官方能力。",
    account: "管理当前设备上的个人设置与数据。",
  };
  const status = document.getElementById("status");
  document.getElementById("close").addEventListener("click", () => {
    api.close().catch(() => window.close());
  });
  if (location.pathname === "/confirmations") {
    document.getElementById("entry-view").hidden = true;
    document.getElementById("confirmation-view").hidden = false;
    const approve = document.getElementById("approve");
    const deny = document.getElementById("deny");
    const confirmationStatus = document.getElementById("confirmation-status");
    let expiresAt = 0;
    const addItems = (target, values) => {
      for (const value of values) {
        const item = document.createElement("li");
        item.textContent = value;
        target.appendChild(item);
      }
    };
    const finish = (approved) => {
      approve.disabled = true;
      deny.disabled = true;
      confirmationStatus.textContent = approved ? "正在提交确认…" : "正在提交拒绝…";
      const action = approved ? api.approve : api.deny;
      action().catch(() => {
        confirmationStatus.textContent = "提交失败，本次操作不会执行";
        setTimeout(() => api.close().catch(() => window.close()), 800);
      });
    };
    approve.addEventListener("click", () => finish(true));
    deny.addEventListener("click", () => finish(false));
    api.confirmation().then((request) => {
      expiresAt = Date.parse(request.expiresAt);
      document.title = "操作确认 - 龙枢";
      document.getElementById("title").textContent = "操作确认";
      document.getElementById("section").textContent = "确认中心";
      document.getElementById("confirmation-action").textContent = request.display.action;
      document.getElementById("confirmation-agent").textContent = request.agentId;
      document.getElementById("confirmation-skill").textContent = request.skillId;
      document.getElementById("confirmation-object").textContent = request.display.object;
      document.getElementById("confirmation-recipient").textContent = request.display.recipient;
      addItems(document.getElementById("confirmation-data"), request.display.dataScope);
      addItems(document.getElementById("confirmation-permissions"), request.permissions);
      document.getElementById("confirmation-cost").textContent =
        request.display.estimatedCostCents === 0
          ? "无额外费用"
          : "人民币 " + (request.display.estimatedCostCents / 100).toFixed(2) + " 元";
      const updateExpiry = () => {
        const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
        document.getElementById("confirmation-expiry").textContent = seconds + " 秒";
        if (seconds === 0) {
          approve.disabled = true;
          deny.disabled = true;
          confirmationStatus.textContent = "确认已过期，本次操作不会执行";
        }
      };
      updateExpiry();
      setInterval(updateExpiry, 1000);
    }).catch(() => {
      approve.disabled = true;
      deny.disabled = true;
      confirmationStatus.textContent = "确认请求无效，本次操作不会执行";
    });
    return;
  }
  if (location.pathname === "/agents") {
    document.getElementById("entry-view").hidden = true;
    document.getElementById("agents-view").hidden = false;
    document.title = "智能体 - 龙枢";
    document.getElementById("title").textContent = "智能体";
    document.getElementById("section").textContent = "智能体管理";
    const agentSelect = document.getElementById("nocode-agent");
    const handoffTarget = document.getElementById("handoff-target");
    const workspaceStatus = document.getElementById("agents-status");
    const managementList = document.getElementById("agent-management-list");
    const installList = document.getElementById("agent-install-list");
    let current;
    let management;
    const addText = (target, value, tag = "p") => {
      const element = document.createElement(tag);
      element.textContent = String(value);
      target.append(element);
      return element;
    };
    const selectedAgent = () => current?.agents.find((item) => item.agentId === agentSelect.value);
    const run = (promise, success) => {
      workspaceStatus.textContent = "正在执行…";
      delete workspaceStatus.dataset.error;
      promise.then((snapshot) => {
        render(snapshot);
        workspaceStatus.textContent = success;
      }).catch(() => {
        workspaceStatus.textContent = "操作被拒绝或失败；未获得额外权限";
        workspaceStatus.dataset.error = "true";
      });
    };
    const actionButton = (label, action, primary = false) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = primary ? "primary" : "secondary";
      button.textContent = label;
      button.addEventListener("click", action);
      return button;
    };
    const renderManagement = () => {
      managementList.replaceChildren();
      for (const agent of management.agents) {
        const card = document.createElement("article");
        card.className = "agent-row";
        if (agent.agentId === management.currentAgentId) card.dataset.current = "true";
        const avatar = document.createElement("span");
        avatar.className = "agent-avatar";
        avatar.textContent = agent.builtIn ? "龙" : agent.name.slice(0, 1);
        const body = document.createElement("div");
        body.className = "agent-row__body";
        addText(body, agent.name, "strong");
        addText(body, agent.builtIn ? "内置智能体" : agent.enabled ? "已安装 · 已启用" : "已安装 · 已停用");
        if (agent.agentId === management.currentAgentId) addText(body, "当前", "span").className = "current-badge";
        const actions = document.createElement("div");
        actions.className = "agent-row__actions";
        if (agent.enabled && agent.agentId !== management.currentAgentId) {
          actions.append(actionButton("切换", () => run(api.selectAgent(agent.agentId), "已切换到 " + agent.name), true));
        }
        if (!agent.builtIn && agent.packId) {
          actions.append(agent.enabled
            ? actionButton("停用", () => run(api.disableAgent(agent.packId), agent.name + " 已停用"))
            : actionButton("启用", () => run(api.enableAgent(agent.packId), agent.name + " 已启用"), true));
        }
        card.append(avatar, body, actions);
        managementList.append(card);
      }
      installList.replaceChildren();
      if (management.installableAgents.length === 0) {
        const empty = document.createElement("p");
        empty.className = "agent-empty";
        empty.textContent = "当前没有新的已授权智能体";
        installList.append(empty);
      }
      for (const agent of management.installableAgents) {
        const row = document.createElement("div");
        row.className = "agent-install-row";
        const body = document.createElement("div");
        addText(body, agent.label, "strong");
        addText(body, agent.state === "error" ? "上次安装失败，可安全重试" : "官方签名 · 当前设备已授权");
        const button = actionButton(agent.state === "installing" ? "安装中…" : agent.state === "error" ? "重试" : "安装",
          () => run(api.installAgent(agent.packId), agent.label + " 已安装并进入会话"), true);
        button.disabled = agent.state === "installing";
        row.append(body, button);
        installList.append(row);
      }
    };
    const render = (composite) => {
      management = composite.management;
      current = composite.workspace;
      const snapshot = current;
      renderManagement();
      const previous = agentSelect.value;
      const options = snapshot.agents.map((agent) => {
        const option = document.createElement("option"); option.value = agent.agentId; option.textContent = agent.name; return option;
      });
      agentSelect.replaceChildren(...options);
      if (snapshot.agents.some((agent) => agent.agentId === previous)) agentSelect.value = previous;
      handoffTarget.replaceChildren(...snapshot.agents.filter((agent) => agent.agentId !== agentSelect.value).map((agent) => {
        const option = document.createElement("option"); option.value = agent.agentId; option.textContent = agent.name; return option;
      }));
      const contents = document.getElementById("content-list"); contents.replaceChildren();
      for (const item of snapshot.contentSkills) {
        const row = document.createElement("div"); row.className = "data-row";
        addText(row, item.name, "strong"); addText(row, item.source === "user_local" ? "用户创建 · 零权限" : "OpenClaw 纯内容降权导入 · 零权限");
        const exportButton = addText(row, "导出", "button");
        exportButton.addEventListener("click", () => run(api.exportContent(item.skillId), "Content Skill 已导出到文本框"));
        contents.append(row);
      }
      if (snapshot.exportedContent) document.getElementById("content-package").value = snapshot.exportedContent.serialized;
      const workflows = document.getElementById("workflow-list"); workflows.replaceChildren();
      for (const item of snapshot.workflows) {
        const row = document.createElement("div"); row.className = "data-row";
        addText(row, item.name, "strong"); addText(row, item.stepCount + " 个静态步骤");
        const execute = addText(row, "按 Core 鉴权执行", "button");
        execute.addEventListener("click", () => run(api.runWorkflow(item.workflowId, agentSelect.value), "Workflow 已完成逐步鉴权执行"));
        workflows.append(row);
      }
      const overlays = document.getElementById("overlay-list"); overlays.replaceChildren();
      for (const item of snapshot.overlays) {
        const row = document.createElement("div"); row.className = "data-row";
        addText(row, item.name, "strong"); addText(row, "基于 " + item.baseProfileId + " 的用户覆盖层");
        overlays.append(row);
      }
      const handoff = document.getElementById("handoff-result"); handoff.replaceChildren();
      if (snapshot.pendingHandoff) {
        addText(handoff, snapshot.pendingHandoff.summary);
        addText(handoff, "摘要 SHA-256：" + snapshot.pendingHandoff.digest);
        const confirm = addText(handoff, "确认转交", "button"); confirm.className = "primary";
        confirm.addEventListener("click", () => run(api.confirmHandoff(
          snapshot.pendingHandoff.handoffId,
          snapshot.pendingHandoff.targetAgentId,
          snapshot.pendingHandoff.confirmationToken,
        ), "摘要已转交，未继承权限或原始记忆"));
      } else if (snapshot.completedHandoff) {
        addText(handoff, snapshot.completedHandoff.message);
        addText(handoff, "继承权限 0 · 继承记忆 0");
      }
      if (snapshot.lastWorkflowRun) addText(workflows, "最近执行：" + snapshot.lastWorkflowRun.executedSteps + " 步，费用 " + snapshot.lastWorkflowRun.costMicros);
      if (!workspaceStatus.dataset.error) {
        const active = management.agents.find((agent) => agent.agentId === management.currentAgentId);
        workspaceStatus.textContent = "当前智能体：" + (active?.name || "龙枢助手") + "。切换会恢复该智能体最近会话。";
      }
    };
    agentSelect.addEventListener("change", () => render({ management, workspace: current }));
    document.getElementById("content-create").addEventListener("click", () => run(api.createContent(
      document.getElementById("content-name").value,
      document.getElementById("content-description").value,
      document.getElementById("content-instructions").value,
    ), "零权限 Content Skill 已创建"));
    document.getElementById("content-import").addEventListener("click", () => run(api.importContent(
      document.getElementById("content-package").value,
    ), "Content Skill 已导入并重建用户身份"));
    document.getElementById("openclaw-import").addEventListener("click", () => run(api.importOpenClawContent(), "OpenClaw 纯内容 Skill 已降权导入"));
    document.getElementById("workflow-create").addEventListener("click", () => {
      let steps;
      try { steps = JSON.parse(document.getElementById("workflow-steps").value); }
      catch { workspaceStatus.textContent = "Workflow JSON 无效"; return; }
      run(api.createWorkflow(document.getElementById("workflow-name").value, steps), "受限 Workflow 已创建");
    });
    document.getElementById("overlay-create").addEventListener("click", () => {
      const selected = selectedAgent();
      if (!selected) return;
      run(api.createOverlay({
        baseProfileId: selected.profileId,
        targetAgentId: selected.agentId,
        name: document.getElementById("overlay-name").value,
        description: document.getElementById("overlay-description").value,
        language: "zh-CN",
        tone: document.getElementById("overlay-tone").value,
        personalEntryIds: [],
        skillIds: current.contentSkills.map((item) => item.skillId),
      }), "无代码 Agent 覆盖层已保存，签名 Profile 未改变");
    });
    document.getElementById("handoff-preview").addEventListener("click", () => run(api.previewHandoff(
      agentSelect.value, handoffTarget.value, document.getElementById("handoff-summary").value,
    ), "请核对摘要后确认转交"));
    api.workspace().then(render).catch(() => {
      workspaceStatus.textContent = "智能体中心当前不可用，请关闭后重试";
      workspaceStatus.dataset.error = "true";
    });
    return;
  }
  if (location.pathname === "/skills") {
    document.getElementById("entry-view").hidden = true;
    document.getElementById("skills-view").hidden = false;
    document.title = "能力 - 龙枢";
    document.getElementById("title").textContent = "能力";
    document.getElementById("section").textContent = "能力中心";
    const agentSelect = document.getElementById("skill-agent");
    const list = document.getElementById("skills-list");
    const skillStatus = document.getElementById("skills-status");
    let currentSnapshot;
    const text = (element, value) => { element.textContent = String(value); return element; };
    const selectedAgent = () => agentSelect.value;
    const actionFor = (skill) => {
      const binding = skill.bindings.find((item) => item.agentId === selectedAgent());
      if (!skill.installedVersion || !binding) return { method: "install", label: skill.actionLabel };
      if (skill.latestVersion !== skill.installedVersion) return { method: "upgrade", label: "升级" };
      return binding.enabled ? { method: "disable", label: "停用" } : { method: "enable", label: "启用" };
    };
    const render = (snapshot) => {
      const previousAgent = agentSelect.value;
      currentSnapshot = snapshot;
      agentSelect.replaceChildren(...snapshot.agents.map((agent) => {
        const option = document.createElement("option");
        option.value = agent.agentId;
        option.textContent = agent.name;
        return option;
      }));
      if (snapshot.agents.some((agent) => agent.agentId === previousAgent)) agentSelect.value = previousAgent;
      list.replaceChildren();
      for (const skill of snapshot.skills) {
        const card = document.createElement("article");
        card.className = "skill-card";
        const header = document.createElement("header");
        const heading = document.createElement("div");
        heading.append(text(document.createElement("h3"), skill.name));
        heading.append(text(document.createElement("p"), skill.description));
        header.append(heading);
        header.append(text(document.createElement("span"), skill.publisher));
        card.append(header);
        const meta = document.createElement("div");
        meta.className = "skill-meta";
        for (const value of [
          skill.category,
          skill.executionLabel,
          "版本 " + (skill.installedVersion || skill.latestVersion),
          skill.confirmationClass === "per_execution" ? "写操作逐次确认" : "无需写操作确认",
          skill.maxCostMicros ? "单次费用上限 ¥" + (skill.maxCostMicros / 1000000).toFixed(2) : "无额外费用",
        ]) meta.append(text(document.createElement("span"), value));
        card.append(meta);
        const permissions = document.createElement("ul");
        permissions.className = "skill-permissions";
        const values = skill.requestedPermissions.length ? skill.requestedPermissions : ["无需额外权限"];
        for (const value of values) permissions.append(text(document.createElement("li"), value));
        card.append(permissions);
        const footer = document.createElement("footer");
        const primary = text(document.createElement("button"), actionFor(skill).label);
        primary.className = "primary";
        primary.disabled = !skill.entitled || !selectedAgent();
        primary.addEventListener("click", () => {
          const action = actionFor(skill);
          primary.disabled = true;
          skillStatus.textContent = "正在" + action.label + "…";
          const needsAgent = ["install", "enable", "disable"].includes(action.method);
          api[action.method](skill.skillId, needsAgent ? selectedAgent() : undefined).then((next) => {
            render(next);
            skillStatus.textContent = action.label + "成功";
          }).catch(() => {
            skillStatus.textContent = "操作失败，本次状态已恢复；请关闭窗口后重试";
            skillStatus.dataset.error = "true";
          });
        });
        footer.append(primary);
        if (skill.installedVersion) {
          const uninstall = text(document.createElement("button"), "卸载");
          uninstall.className = "secondary";
          uninstall.addEventListener("click", () => {
            uninstall.disabled = true;
            api.uninstall(skill.skillId).then(render).catch(() => {
              skillStatus.textContent = "卸载失败，本次状态已恢复；请关闭窗口后重试";
            });
          });
          footer.prepend(uninstall);
        }
        card.append(footer);
        list.append(card);
      }
      skillStatus.textContent = snapshot.skills.length ? "目录与本机状态已同步" : "当前没有可用能力";
    };
    agentSelect.addEventListener("change", () => { if (currentSnapshot) render(currentSnapshot); });
    api.skills().then(render).catch(() => {
      skillStatus.textContent = "能力目录当前不可用，请关闭后重试";
      skillStatus.dataset.error = "true";
    });
    return;
  }
  if (location.pathname === "/account") {
    document.getElementById("entry-view").hidden = true;
    document.getElementById("account-view").hidden = false;
    document.title = "我的 - 龙枢";
    document.getElementById("title").textContent = "我的";
    document.getElementById("section").textContent = "当前设备数据";
    const agentSelect = document.getElementById("account-agent");
    const accountStatus = document.getElementById("account-status");
    const addText = (target, value, tag = "p") => {
      const element = document.createElement(tag);
      element.textContent = String(value);
      target.append(element);
      return element;
    };
    const run = (promise, success) => {
      accountStatus.textContent = "正在执行…";
      promise.then((snapshot) => { render(snapshot); accountStatus.textContent = success; }).catch(() => {
        accountStatus.textContent = "操作失败且未扩大数据范围；请关闭窗口后重试";
        accountStatus.dataset.error = "true";
      });
    };
    const render = (snapshot) => {
      const previous = agentSelect.value;
      agentSelect.replaceChildren(...snapshot.agents.map((agent) => {
        const option = document.createElement("option");
        option.value = agent.agentId;
        option.textContent = agent.name;
        return option;
      }));
      agentSelect.value = snapshot.selectedAgentId || previous;
      const agentId = snapshot.selectedAgentId;
      document.getElementById("session-search-query").value = snapshot.searchQuery || "";
      document.getElementById("session-export").value = snapshot.lastExport ? JSON.stringify(snapshot.lastExport, null, 2) : "";
      const sessions = document.getElementById("session-list");
      sessions.replaceChildren();
      for (const item of snapshot.sessions) {
        const row = document.createElement("div"); row.className = "data-row";
        const input = document.createElement("input"); input.value = item.label || item.key; input.maxLength = 120;
        row.append(input);
        const rename = addText(row, "重命名", "button");
        rename.addEventListener("click", () => run(api.renameSession(agentId, item.key, input.value), "会话已重命名"));
        const archive = addText(row, item.archived ? "取消归档" : "归档", "button");
        archive.addEventListener("click", () => run(api.archiveSession(agentId, item.key, !item.archived), "会话归档状态已更新"));
        const pin = addText(row, item.pinned ? "取消置顶" : "置顶", "button");
        pin.addEventListener("click", () => run(api.pinSession(agentId, item.key, !item.pinned), "会话置顶状态已更新"));
        const exportButton = addText(row, "导出", "button");
        exportButton.addEventListener("click", () => run(api.exportSession(agentId, item.key), "单会话已导出到只读文本框"));
        const trash = addText(row, "移到回收站", "button");
        trash.addEventListener("click", () => run(api.trashSession(agentId, item.key), "会话可恢复删除完成"));
        const attachment = addText(row, "选择附件预览", "button");
        attachment.addEventListener("click", () => run(api.selectFile(agentId, item.key), "附件已在隔离进程解析"));
        sessions.append(row);
      }
      const attachmentList = document.getElementById("attachment-list"); attachmentList.replaceChildren();
      for (const item of snapshot.attachments) {
        const row = document.createElement("div"); row.className = "data-row";
        addText(row, item.filename, "strong"); addText(row, item.kind + (item.truncated ? "（已截断）" : ""));
        addText(row, item.text);
        attachmentList.append(row);
      }
      if (snapshot.attachmentSessionId && snapshot.attachments.length) {
        const sendAttachments = addText(attachmentList, "发送解析内容到该会话", "button");
        sendAttachments.className = "primary";
        sendAttachments.addEventListener("click", () => run(api.sendFiles(
          agentId, snapshot.attachmentSessionId,
        ), "附件解析内容已发送给当前 Agent，会话仍保持绑定"));
      }
      const trashList = document.getElementById("trash-list"); trashList.replaceChildren();
      for (const item of snapshot.trashedSessions) {
        const row = document.createElement("div"); row.className = "data-row";
        addText(row, item.key); addText(row, "保留至 " + item.deleteAfter);
        const restore = addText(row, "恢复", "button");
        restore.addEventListener("click", () => run(api.restoreSession(agentId, item.key), "会话已恢复"));
        if (snapshot.pendingPermanentDelete?.key === item.key) {
          const confirmDelete = addText(row, "确认永久删除", "button");
          confirmDelete.addEventListener("click", () => run(api.confirmPermanentDelete(
            agentId, item.key, snapshot.pendingPermanentDelete.confirmation,
          ), "会话已永久删除"));
        } else if (Date.parse(item.deleteAfter) <= Date.now()) {
          const requestDelete = addText(row, "申请永久删除", "button");
          requestDelete.addEventListener("click", () => run(api.requestPermanentDelete(agentId, item.key), "请再次确认永久删除"));
        }
        trashList.append(row);
      }
      const profiles = document.getElementById("profile-list"); profiles.replaceChildren();
      for (const item of snapshot.personalEntries) {
        const row = document.createElement("div"); row.className = "data-row";
        addText(row, item.title); addText(row, item.deletedAt ? "在回收站" : "仅当前设备");
        const action = addText(row, item.deletedAt ? "恢复" : "删除", "button");
        action.addEventListener("click", () => run(
          item.deletedAt ? api.restoreProfile(agentId, item.entryId) : api.trashProfile(agentId, item.entryId),
          item.deletedAt ? "资料已恢复" : "资料已移到回收站",
        ));
        profiles.append(row);
      }
      const citations = document.getElementById("citation-list"); citations.replaceChildren();
      for (const item of snapshot.citations) {
        const row = document.createElement("div"); row.className = "data-row";
        addText(row, item.title, "strong"); addText(row, item.sourceLabel); addText(row, item.snippet);
        citations.append(row);
      }
      accountStatus.textContent = "数据仅按所选 Agent 展示";
    };
    agentSelect.addEventListener("change", () => run(api.selectAgent(agentSelect.value), "已切换 Agent 数据边界"));
    document.getElementById("session-search").addEventListener("click", () => run(api.searchSessions(
      agentSelect.value, document.getElementById("session-search-query").value,
    ), "会话搜索结果已更新"));
    document.getElementById("profile-add").addEventListener("click", () => run(api.addProfile(
      agentSelect.value,
      document.getElementById("profile-title").value,
      document.getElementById("profile-content").value,
    ), "个人资料已保存到当前设备"));
    document.getElementById("knowledge-search").addEventListener("click", () => run(api.queryKnowledge(
      agentSelect.value,
      document.getElementById("knowledge-query").value,
    ), "企业知识引用已更新"));
    api.account().then(render).catch(() => {
      accountStatus.textContent = "用户数据中心当前不可用，请关闭后重试";
      accountStatus.dataset.error = "true";
    });
    return;
  }
  api.context().then((context) => {
    if (!context || !labels[context.entry]) throw new Error("invalid context");
    document.title = labels[context.entry] + " - 龙枢";
    document.getElementById("title").textContent = labels[context.entry];
    document.getElementById("section").textContent = labels[context.entry];
    document.getElementById("heading").textContent = labels[context.entry] + "入口";
    document.getElementById("description").textContent = descriptions[context.entry];
    status.textContent = "策略已验证";
  }).catch(() => {
    status.textContent = "功能当前不可用，请关闭后重试";
    status.dataset.error = "true";
  });
})();
