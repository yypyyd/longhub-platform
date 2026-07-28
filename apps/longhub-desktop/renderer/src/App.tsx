import { useCallback, useEffect, useState } from "react";
import type {
  InstalledPack,
  SubmitTaskParams,
  TaskEvent,
  TaskRecord,
} from "./longhub";

interface TaskView extends TaskRecord {
  skillId: string;
  events: string[];
}

export function App() {
  const [coreVersion, setCoreVersion] = useState("");
  const [packs, setPacks] = useState<InstalledPack[]>([]);
  const [tasks, setTasks] = useState<Record<string, TaskView>>({});
  const [skillId, setSkillId] = useState("longhub.skill.echo-upper");
  const [inputText, setInputText] = useState("longhub");
  const [permissionsText, setPermissionsText] = useState("");
  const [pendingConfirmation, setPendingConfirmation] = useState<
    { params: SubmitTaskParams; permissions: string[] } | undefined
  >();
  const [notice, setNotice] = useState("");
  const [cloudBaseUrl, setCloudBaseUrl] = useState("http://127.0.0.1:8081");
  const [cloudPackId, setCloudPackId] = useState("longhub.hr-suite");
  const [cloudVersion, setCloudVersion] = useState("");
  const [cloudBusy, setCloudBusy] = useState(false);

  const refreshPacks = useCallback(async () => {
    setPacks(await window.longhub.listPacks());
  }, []);

  const refreshTask = useCallback(async (taskId: string) => {
    const record = await window.longhub.getTask(taskId);
    setTasks((prev) => {
      const existing = prev[taskId];
      if (!existing) return prev;
      return { ...prev, [taskId]: { ...existing, ...record } };
    });
  }, []);

  useEffect(() => {
    void window.longhub.hello().then((h) => setCoreVersion(h.coreRpcVersion));
    void refreshPacks();
    return window.longhub.onTaskEvent((event: TaskEvent) => {
      setTasks((prev) => {
        const existing = prev[event.task_id];
        if (!existing) return prev;
        return {
          ...prev,
          [event.task_id]: { ...existing, events: [...existing.events, event.type] },
        };
      });
      void refreshTask(event.task_id);
    });
  }, [refreshPacks, refreshTask]);

  async function doSubmit(params: SubmitTaskParams) {
    const result = await window.longhub.submitTask(params);
    if ("needsConfirmation" in result) {
      setPendingConfirmation({ params, permissions: result.needsConfirmation });
      return;
    }
    setTasks((prev) => ({
      ...prev,
      [result.taskId]: {
        taskId: result.taskId,
        status: result.status,
        skillId: params.skillId,
        events: [],
      },
    }));
  }

  function handleSubmit() {
    const grantedPermissions = permissionsText
      .split(/[,\s]+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    void doSubmit({
      idempotencyKey: crypto.randomUUID(),
      skillId,
      input: { text: inputText },
      grantedPermissions,
    });
  }

  async function handleInstall() {
    const result = await window.longhub.installPack();
    setNotice(
      result.ok
        ? `已安装 ${result.packId} v${result.version}`
        : `安装失败 [${result.code}] ${result.message}`,
    );
    await refreshPacks();
  }

  async function handleInstallFromCloud() {
    setCloudBusy(true);
    try {
      const result = await window.longhub.installPackFromCloud({
        baseUrl: cloudBaseUrl,
        packId: cloudPackId,
        version: cloudVersion.trim() === "" ? undefined : cloudVersion.trim(),
      });
      setNotice(
        result.ok
          ? `已从云端安装 ${result.packId} v${result.version}`
          : `云端安装失败 [${result.code}] ${result.message}`,
      );
      await refreshPacks();
    } finally {
      setCloudBusy(false);
    }
  }

  async function handleRollback(packId: string) {
    const result = await window.longhub.rollbackPack(packId);
    setNotice(
      result.ok
        ? `已回滚 ${result.packId} 到 v${result.version}`
        : `回滚失败 [${result.code}] ${result.message}`,
    );
    await refreshPacks();
  }

  return (
    <div className="app">
      <header>
        <h1>龙枢工作台</h1>
        <span className="core-version">
          {coreVersion ? `Core RPC ${coreVersion}` : "Core 连接中…"}
        </span>
      </header>

      {notice && <div className="notice">{notice}</div>}

      <main>
        <section className="panel">
          <h2>智能体套装</h2>
          <button onClick={() => void handleInstall()}>安装套装…</button>
          {packs.length === 0 ? (
            <p className="empty">尚未安装任何套装</p>
          ) : (
            <ul>
              {packs.map((pack) => (
                <li key={pack.packId}>
                  <strong>{pack.packId}</strong>
                  <span> v{pack.activeVersion ?? "?"}</span>
                  {pack.previousVersion && (
                    <button onClick={() => void handleRollback(pack.packId)}>
                      回滚到 v{pack.previousVersion}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <h3>从云端安装</h3>
          <div className="form">
            <label>
              云端地址
              <input value={cloudBaseUrl} onChange={(e) => setCloudBaseUrl(e.target.value)} />
            </label>
            <label>
              套装 ID
              <input value={cloudPackId} onChange={(e) => setCloudPackId(e.target.value)} />
            </label>
            <label>
              版本（留空取最新）
              <input value={cloudVersion} onChange={(e) => setCloudVersion(e.target.value)} />
            </label>
            <button disabled={cloudBusy} onClick={() => void handleInstallFromCloud()}>
              {cloudBusy ? "安装中…" : "从云端安装"}
            </button>
          </div>
        </section>

        <section className="panel">
          <h2>任务面板</h2>
          <div className="form">
            <label>
              技能
              <input value={skillId} onChange={(e) => setSkillId(e.target.value)} />
            </label>
            <label>
              输入文本
              <input value={inputText} onChange={(e) => setInputText(e.target.value)} />
            </label>
            <label>
              申请权限（逗号分隔，如 connector:hr-api:read）
              <input
                value={permissionsText}
                onChange={(e) => setPermissionsText(e.target.value)}
              />
            </label>
            <button onClick={handleSubmit}>提交任务</button>
          </div>
          <ul className="tasks">
            {Object.values(tasks).map((task) => (
              <li key={task.taskId}>
                <div>
                  <strong>{task.taskId}</strong> {task.skillId} —{" "}
                  <span className={`status status-${task.status}`}>{task.status}</span>
                  {(task.status === "pending" || task.status === "running") && (
                    <button onClick={() => void window.longhub.cancelTask(task.taskId)}>
                      取消
                    </button>
                  )}
                </div>
                {task.output !== undefined && (
                  <pre>{JSON.stringify(task.output, null, 2)}</pre>
                )}
                <div className="events">{task.events.join(" → ")}</div>
              </li>
            ))}
          </ul>
        </section>
      </main>

      {pendingConfirmation && (
        <div className="modal-backdrop">
          <div className="modal">
            <h3>权限确认</h3>
            <p>该任务申请了需要人工确认的权限：</p>
            <ul>
              {pendingConfirmation.permissions.map((p) => (
                <li key={p}>
                  <code>{p}</code>
                </li>
              ))}
            </ul>
            <div className="modal-actions">
              <button
                onClick={() => {
                  const { params } = pendingConfirmation;
                  setPendingConfirmation(undefined);
                  void doSubmit({ ...params, userConfirmed: true });
                }}
              >
                批准并执行
              </button>
              <button onClick={() => setPendingConfirmation(undefined)}>拒绝</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
