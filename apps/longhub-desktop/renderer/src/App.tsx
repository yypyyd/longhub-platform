import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DeviceInfo,
  InstalledPack,
  SubmitTaskParams,
  TaskEvent,
  TaskRecord,
} from "./longhub";

const CHAT_SKILL_ID = "longhub.skill.chat";
const CLOUD_BASE_URL = "http://154.9.26.158:8081";
const HR_PACK_ID = "longhub.hr-suite";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  status: "pending" | "done" | "failed";
}

const QUICK_PROMPTS = [
  { label: "起草 JD", prompt: "请帮我为「高级前端工程师」岗位起草一份职位描述。" },
  { label: "简历初筛", prompt: "请帮我制定一份简历初筛标准，岗位是产品经理。" },
  { label: "Offer 函", prompt: "请帮我起草一份 Offer 录用通知函模板。" },
];

export function App() {
  const [coreVersion, setCoreVersion] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [conversationId] = useState(() => crypto.randomUUID());
  const [packs, setPacks] = useState<InstalledPack[]>([]);
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | undefined>();
  const [notice, setNotice] = useState("");
  const [cloudBusy, setCloudBusy] = useState(false);
  const taskToMessage = useRef(new Map<string, string>());
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const refreshPacks = useCallback(async () => {
    setPacks(await window.longhub.listPacks());
  }, []);

  const resolveTask = useCallback(async (taskId: string) => {
    const messageId = taskToMessage.current.get(taskId);
    if (!messageId) return;
    const record: TaskRecord = await window.longhub.getTask(taskId);
    if (record.status === "succeeded") {
      const reply = (record.output as { reply?: string } | undefined)?.reply;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId ? { ...m, text: reply ?? "（无内容）", status: "done" } : m,
        ),
      );
      taskToMessage.current.delete(taskId);
      setSending(false);
    } else if (record.status === "failed" || record.status === "timed_out") {
      const message = record.error?.message ?? "任务失败";
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId ? { ...m, text: `出错了：${message}`, status: "failed" } : m,
        ),
      );
      taskToMessage.current.delete(taskId);
      setSending(false);
    }
  }, []);

  useEffect(() => {
    void window.longhub.hello().then((h) => setCoreVersion(h.coreRpcVersion));
    void window.longhub.deviceInfo().then(setDeviceInfo);
    void refreshPacks();
    return window.longhub.onTaskEvent((event: TaskEvent) => {
      void resolveTask(event.task_id);
    });
  }, [refreshPacks, resolveTask]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  async function doSubmit(params: SubmitTaskParams, assistantMessageId: string) {
    const result = await window.longhub.submitTask(params);
    taskToMessage.current.set(result.taskId, assistantMessageId);
    // 任务可能在映射建立前就已完成（Mock 即时返回），补一次查询兜底
    void resolveTask(result.taskId);
  }

  function sendMessage(text: string) {
    const content = text.trim();
    if (!content || sending) return;
    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    setMessages((prev) => [
      ...prev,
      { id: userId, role: "user", text: content, status: "done" },
      { id: assistantId, role: "assistant", text: "", status: "pending" },
    ]);
    setDraft("");
    setSending(true);
    void doSubmit(
      {
        idempotencyKey: crypto.randomUUID(),
        skillId: CHAT_SKILL_ID,
        input: { conversationId, message: content },
      },
      assistantId,
    );
  }

  async function handleInstallHrSuite() {
    setCloudBusy(true);
    try {
      const result = await window.longhub.installPackFromCloud({
        baseUrl: CLOUD_BASE_URL,
        packId: HR_PACK_ID,
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
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-logo" src="./longhub-avatar.png" alt="龙枢" />
          <div>
            <div className="brand-name">龙枢工作台</div>
            <div className="brand-sub">{coreVersion ? `Core ${coreVersion}` : "连接中…"}</div>
          </div>
        </div>

        <section className="side-card">
          <h3>我的设备</h3>
          {deviceInfo === undefined ? (
            <p className="muted">设备注册中…</p>
          ) : deviceInfo.ok ? (
            <>
              <code className="device-id">{deviceInfo.deviceId}</code>
              <button
                className="ghost"
                onClick={() => void navigator.clipboard.writeText(deviceInfo.deviceId)}
              >
                复制设备 ID
              </button>
              <p className="muted">在官网「个人中心 → 我的设备」绑定后，订阅授权自动下发。</p>
            </>
          ) : (
            <p className="muted">设备注册失败：{deviceInfo.message}</p>
          )}
        </section>

        <section className="side-card">
          <h3>智能体套装</h3>
          {packs.length === 0 ? (
            <p className="muted">尚未安装套装</p>
          ) : (
            <ul className="pack-list">
              {packs.map((pack) => (
                <li key={pack.packId}>
                  <span className="pack-name">{pack.packId}</span>
                  <span className="pack-version">v{pack.activeVersion ?? "?"}</span>
                  {pack.previousVersion && (
                    <button className="ghost" onClick={() => void handleRollback(pack.packId)}>
                      回滚 v{pack.previousVersion}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <button disabled={cloudBusy} onClick={() => void handleInstallHrSuite()}>
            {cloudBusy ? "安装中…" : "安装 HR 套装"}
          </button>
        </section>

        {notice && <div className="notice">{notice}</div>}
      </aside>

      <main className="chat">
        <div className="chat-scroll" ref={scrollRef}>
          {messages.length === 0 ? (
            <div className="chat-empty">
              <h2>你好，我是龙枢助手</h2>
              <p>可以直接跟我对话，也可以从下面的快捷任务开始。</p>
              <div className="chips">
                {QUICK_PROMPTS.map((q) => (
                  <button key={q.label} className="chip" onClick={() => sendMessage(q.prompt)}>
                    {q.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m) => (
              <div key={m.id} className={`bubble-row ${m.role}`}>
                <div className={`bubble ${m.role} ${m.status}`}>
                  {m.status === "pending" ? <span className="typing">思考中…</span> : m.text}
                </div>
              </div>
            ))
          )}
        </div>
        <div className="composer">
          <textarea
            value={draft}
            placeholder="输入消息，Enter 发送，Shift+Enter 换行"
            rows={1}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage(draft);
              }
            }}
          />
          <button disabled={sending || draft.trim() === ""} onClick={() => sendMessage(draft)}>
            发送
          </button>
        </div>
      </main>

    </div>
  );
}
