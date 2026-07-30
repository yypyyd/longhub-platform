/** 龙枢管理后台：登录 + 看板/用户/设备/授权/套装/商品/订单/流水/审计。 */
import { useCallback, useEffect, useState } from "react";
import {
  api,
  ApiError,
  uploadClientRelease,
  yuan,
  type ClientRelease,
  type AdminModelConfig,
  type AdminKnowledgeDocument,
  type AdminPackReview,
  type AdminActivationCode,
  type AdminAudit,
  type AdminDevice,
  type AdminEntitlement,
  type AdminOrder,
  type AdminProduct,
  type AdminRelease,
  type AdminTxn,
  type AdminUser,
  type Metrics,
} from "./api";

type Tab =
  | "dashboard"
  | "users"
  | "devices"
  | "activation-codes"
  | "entitlements"
  | "packs"
  | "clients"
  | "model"
  | "knowledge"
  | "pack-reviews"
  | "products"
  | "orders"
  | "transactions"
  | "audits";

const TABS: { key: Tab; label: string }[] = [
  { key: "dashboard", label: "看板" },
  { key: "users", label: "用户" },
  { key: "devices", label: "设备" },
  { key: "activation-codes", label: "授权码" },
  { key: "entitlements", label: "授权" },
  { key: "packs", label: "套装发布" },
  { key: "clients", label: "客户端版本" },
  { key: "model", label: "默认模型" },
  { key: "knowledge", label: "租户知识库" },
  { key: "pack-reviews", label: "第三方审核" },
  { key: "products", label: "商品定价" },
  { key: "orders", label: "订单" },
  { key: "transactions", label: "余额流水" },
  { key: "audits", label: "审计日志" },
];

const TOKEN_KEY = "longhub_admin_token";
const WHO_KEY = "longhub_admin_who";

function percentage(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function latencyLabel(bucket: string): string {
  return ({ lt_1s: "< 1 秒", "1_to_3s": "1–3 秒", "3_to_10s": "3–10 秒", "10_to_30s": "10–30 秒", gte_30s: "≥ 30 秒" } as Record<string, string>)[bucket] ?? bucket;
}

export function App(): JSX.Element {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [who, setWho] = useState<string>(() => localStorage.getItem(WHO_KEY) ?? "");
  const [tab, setTab] = useState<Tab>("dashboard");

  const onLogout = (): void => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(WHO_KEY);
    setToken(null);
  };

  if (!token) {
    return (
      <Login
        onDone={(t, name) => {
          localStorage.setItem(TOKEN_KEY, t);
          localStorage.setItem(WHO_KEY, name);
          setWho(name);
          setToken(t);
        }}
      />
    );
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand"><img src="/longhub-avatar.png" alt="" /><span>龙枢管理后台</span></div>
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? "active" : ""} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
        <div className="who">{who}</div>
        <button onClick={onLogout}>退出登录</button>
      </aside>
      <main className="main">
        <Panel tab={tab} token={token} onExpired={onLogout} />
      </main>
    </div>
  );
}

function Login(props: { onDone: (token: string, who: string) => void }): JSX.Element {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setError("");
    setBusy(true);
    try {
      const res = await api<{ token: string; admin: { username: string; role: string } }>("/v1/admin/auth/login", {
        method: "POST",
        body: { username, password },
      });
      props.onDone(res.token, `${res.admin.username} · ${res.admin.role}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login">
        <img className="login-logo" src="/longhub-avatar.png" alt="龙枢" />
        <h1>龙枢管理后台</h1>
        <label>用户名</label>
        <input value={username} onChange={(e) => setUsername(e.target.value)} />
        <label>密码</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button className="btn" disabled={busy || !username || !password} onClick={() => void submit()}>
          登录
        </button>
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

function Panel(props: { tab: Tab; token: string; onExpired: () => void }): JSX.Element {
  const { tab, token, onExpired } = props;
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [devices, setDevices] = useState<AdminDevice[]>([]);
  const [activationCodes, setActivationCodes] = useState<AdminActivationCode[]>([]);
  const [generatedCode, setGeneratedCode] = useState("");
  const [entitlements, setEntitlements] = useState<AdminEntitlement[]>([]);
  const [releases, setReleases] = useState<AdminRelease[]>([]);
  const [clientReleases, setClientReleases] = useState<ClientRelease[]>([]);
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [txns, setTxns] = useState<AdminTxn[]>([]);
  const [audits, setAudits] = useState<AdminAudit[]>([]);
  const [modelConfig, setModelConfig] = useState<AdminModelConfig | null>(null);
  const [knowledgeDocuments, setKnowledgeDocuments] = useState<AdminKnowledgeDocument[]>([]);
  const [knowledgeTenant, setKnowledgeTenant] = useState("tenant-default");
  const [packReviews, setPackReviews] = useState<AdminPackReview[]>([]);

  const guard = useCallback(
    (err: unknown): void => {
      if (err instanceof ApiError && err.code === "UNAUTHORIZED") onExpired();
      else setError(err instanceof Error ? err.message : "请求失败");
    },
    [onExpired],
  );

  const refresh = useCallback(async (): Promise<void> => {
    setError("");
    try {
      if (tab === "dashboard") setMetrics(await api<Metrics>("/v1/admin/metrics", { token }));
      if (tab === "users") setUsers((await api<{ users: AdminUser[] }>("/v1/admin/users", { token })).users);
      if (tab === "devices") setDevices((await api<{ devices: AdminDevice[] }>("/v1/admin/devices", { token })).devices);
      if (tab === "activation-codes")
        setActivationCodes((await api<{ activation_codes: AdminActivationCode[] }>("/v1/admin/activation-codes", { token })).activation_codes);
      if (tab === "entitlements")
        setEntitlements((await api<{ entitlements: AdminEntitlement[] }>("/v1/admin/entitlements", { token })).entitlements);
      if (tab === "packs") setReleases((await api<{ releases: AdminRelease[] }>("/v1/admin/packs", { token })).releases);
      if (tab === "clients")
        setClientReleases((await api<{ releases: ClientRelease[] }>("/v1/admin/client-releases", { token })).releases);
      if (tab === "model") setModelConfig(await api<AdminModelConfig>("/v1/admin/model-config", { token }));
      if (tab === "knowledge") {
        const query = encodeURIComponent(knowledgeTenant);
        setKnowledgeDocuments((await api<{ documents: AdminKnowledgeDocument[] }>(`/v1/admin/knowledge-documents?tenant_id=${query}`, { token })).documents);
      }
      if (tab === "pack-reviews") setPackReviews((await api<{ reviews: AdminPackReview[] }>("/v1/admin/pack-reviews", { token })).reviews);
      if (tab === "products") setProducts((await api<{ products: AdminProduct[] }>("/v1/admin/products", { token })).products);
      if (tab === "orders") setOrders((await api<{ orders: AdminOrder[] }>("/v1/admin/orders", { token })).orders);
      if (tab === "transactions") setTxns((await api<{ transactions: AdminTxn[] }>("/v1/admin/transactions", { token })).transactions);
      if (tab === "audits") setAudits((await api<{ audits: AdminAudit[] }>("/v1/admin/audits", { token })).audits);
    } catch (err) {
      guard(err);
    }
  }, [tab, token, guard, knowledgeTenant]);

  useEffect(() => {
    setNotice("");
    void refresh();
  }, [refresh]);

  const act = async (fn: () => Promise<unknown>, done: string): Promise<void> => {
    setError("");
    setNotice("");
    try {
      await fn();
      setNotice(done);
      await refresh();
    } catch (err) {
      guard(err);
    }
  };

  const createActivationCode = async (body: Record<string, unknown>): Promise<void> => {
    setError("");
    setNotice("");
    try {
      const result = await api<{ code: string }>("/v1/admin/activation-codes", { method: "POST", body, token });
      setGeneratedCode(result.code);
      setNotice("授权码已生成；明文只显示在这里，请立即交付并妥善保存。");
      await refresh();
    } catch (err) {
      guard(err);
    }
  };

  const submitPackReview = async (body: Record<string, unknown>): Promise<void> => {
    setError("");
    setNotice("");
    try {
      await api("/v1/admin/pack-reviews", { method: "POST", body, token });
      setNotice("Pack 已通过自动扫描并进入待批准状态");
    } catch (err) {
      guard(err);
    } finally {
      await refresh();
    }
  };

  return (
    <>
      {tab === "dashboard" && (
        <>
          <h2>看板</h2>
          {metrics && (
            <div className="stats">
              <div className="stat">
                <div className="num">{metrics.users_total}</div>
                <div className="label">注册用户</div>
              </div>
              <div className="stat">
                <div className="num">{metrics.devices_total}</div>
                <div className="label">设备</div>
              </div>
              <div className="stat">
                <div className="num">{metrics.orders_paid_total}</div>
                <div className="label">已支付订单</div>
              </div>
              <div className="stat">
                <div className="num">{yuan(metrics.revenue_fen)}</div>
                <div className="label">累计收入</div>
              </div>
              <div className="stat">
                <div className="num">{metrics.releases_total}</div>
                <div className="label">套装发布</div>
              </div>
              <div className="stat">
                <div className="num">{metrics.operations.client_starts}</div>
                <div className="label">24 小时启动</div>
              </div>
              <div className="stat">
                <div className="num">{percentage(metrics.operations.crash_rate)}</div>
                <div className="label">异常退出率</div>
              </div>
              <div className="stat">
                <div className="num">{percentage(metrics.operations.model_success_rate)}</div>
                <div className="label">模型请求成功率</div>
              </div>
              <div className="stat">
                <div className="num">{percentage(metrics.operations.update_success_rate)}</div>
                <div className="label">客户端升级成功率</div>
              </div>
              <div className="stat">
                <div className="num">{metrics.model_usage.input_tokens + metrics.model_usage.output_tokens}</div>
                <div className="label">本月模型 Token</div>
              </div>
              <div className="stat">
                <div className="num">{(metrics.model_usage.cost_microunits / 1_000_000).toFixed(4)}</div>
                <div className="label">本月模型成本单位</div>
              </div>
            </div>
          )}
          {metrics && (
            <div className="dashboard-grid">
              <div className="card">
                <h3>近 24 小时运行健康</h3>
                <table><tbody>
                  <tr><td>正常 / 异常退出</td><td>{metrics.operations.previous_exit_clean} / {metrics.operations.previous_exit_unclean}</td></tr>
                  <tr><td>模型成功 / 总请求</td><td>{metrics.operations.model_successes} / {metrics.operations.model_requests}</td></tr>
                  <tr><td>升级健康 / 失败 / 回滚</td><td>{metrics.operations.update_healthy} / {metrics.operations.update_failed} / {metrics.operations.update_rollback}</td></tr>
                  <tr><td>固定产品错误</td><td>{metrics.operations.product_errors}</td></tr>
                </tbody></table>
              </div>
              <div className="card">
                <h3>模型首包延迟（TTFB）</h3>
                <table><tbody>
                  {Object.entries(metrics.operations.model_latency_buckets).map(([bucket, count]) => (
                    <tr key={bucket}><td>{latencyLabel(bucket)}</td><td>{count}</td></tr>
                  ))}
                </tbody></table>
              </div>
              <div className="card">
                <h3>客户端版本分布</h3>
                <table><tbody>
                  {metrics.operations.desktop_versions.length === 0 && <tr><td>暂无数据</td><td>—</td></tr>}
                  {metrics.operations.desktop_versions.map((item) => <tr key={item.version}><td>{item.version}</td><td>{item.count}</td></tr>)}
                </tbody></table>
              </div>
              <div className="card">
                <h3>主要产品错误</h3>
                <table><tbody>
                  {metrics.operations.top_product_errors.length === 0 && <tr><td>暂无数据</td><td>—</td></tr>}
                  {metrics.operations.top_product_errors.map((item) => <tr key={item.code}><td>{item.code}</td><td>{item.count}</td></tr>)}
                </tbody></table>
              </div>
            </div>
          )}
        </>
      )}

      {tab === "users" && (
        <>
          <h2>用户管理</h2>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>用户 ID</th>
                  <th>邮箱</th>
                  <th>余额</th>
                  <th>状态</th>
                  <th>注册时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.user_id}>
                    <td>{u.user_id.slice(0, 14)}…</td>
                    <td>{u.email}</td>
                    <td>{yuan(u.balance_fen)}</td>
                    <td>
                      <span className={`pill ${u.status}`}>{u.status}</span>
                    </td>
                    <td>{new Date(u.created_at).toLocaleString("zh-CN")}</td>
                    <td>
                      <div className="row">
                        <button
                          className={`btn ${u.status === "active" ? "danger" : ""}`}
                          onClick={() =>
                            void act(
                              () =>
                                api(`/v1/admin/users/${u.user_id}/status`, {
                                  method: "POST",
                                  body: { status: u.status === "active" ? "disabled" : "active" },
                                  token,
                                }),
                              "用户状态已更新",
                            )
                          }
                        >
                          {u.status === "active" ? "停用" : "启用"}
                        </button>
                        <AdjustBalance
                          onAdjust={(fen, remark) =>
                            void act(
                              () =>
                                api("/v1/admin/wallet/adjust", {
                                  method: "POST",
                                  body: { user_id: u.user_id, amount_fen: fen, remark },
                                  token,
                                }),
                              "调账成功",
                            )
                          }
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === "devices" && (
        <>
          <h2>设备管理</h2>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>设备 ID</th>
                  <th>平台</th>
                  <th>版本</th>
                  <th>绑定用户</th>
                  <th>状态</th>
                  <th>产品激活</th>
                  <th>最后在线 / 模型成功</th>
                  <th>错误 / 分组</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {devices.map((d) => (
                  <tr key={d.device_id}>
                    <td>{d.device_id}</td>
                    <td>{d.platform}</td>
                    <td>{d.app_version}</td>
                    <td>{d.user_id ? `${d.user_id.slice(0, 14)}…` : "—"}</td>
                    <td>
                      <span className={`pill ${d.status}`}>{d.status}</span>
                    </td>
                    <td>{d.activated_at ? new Date(d.activated_at).toLocaleString("zh-CN") : "待激活"}</td>
                    <td>{d.last_seen_at ? new Date(d.last_seen_at).toLocaleString("zh-CN") : "—"}<br />{d.last_model_success_at ? new Date(d.last_model_success_at).toLocaleString("zh-CN") : "—"}</td>
                    <td>{d.last_error_code ?? "—"}<br />{d.rollout_group ?? "默认组"}</td>
                    <td><div className="row">
                      <button className={`btn ${d.status === "active" ? "danger" : ""}`} onClick={() => void act(
                        () => api(`/v1/admin/devices/${d.device_id}`, { method: "POST", body: { status: d.status === "active" ? "revoked" : "active" }, token }),
                        d.status === "active" ? "设备已停用" : "设备已启用",
                      )}>{d.status === "active" ? "停用" : "启用"}</button>
                      <button className="btn ghost" onClick={() => void (async () => {
                        try {
                          const result = await api<{ device_token: string }>(`/v1/admin/devices/${d.device_id}/rotate-credential`, { method: "POST", body: {}, token });
                          setNotice(`新设备凭据（仅本次显示）：${result.device_token}`);
                          await refresh();
                        } catch (error) { guard(error); }
                      })()}>轮换凭据</button>
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === "entitlements" && (
        <>
          <h2>授权管理</h2>
          <GrantForm
            onGrant={(deviceId, packId) =>
              void act(
                () => api("/v1/admin/entitlements", { method: "POST", body: { device_id: deviceId, pack_id: packId }, token }),
                "授权已授予",
              )
            }
          />
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>授权 ID</th>
                  <th>设备</th>
                  <th>套装</th>
                  <th>状态</th>
                  <th>到期</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {entitlements.map((e) => (
                  <tr key={e.entitlement_id}>
                    <td>{e.entitlement_id.slice(0, 14)}…</td>
                    <td>{e.device_id.slice(0, 14)}…</td>
                    <td>{e.pack_id}</td>
                    <td>
                      <span className={`pill ${e.status}`}>{e.status}</span>
                    </td>
                    <td>{new Date(e.expires_at).toLocaleDateString("zh-CN")}</td>
                    <td>
                      {e.status === "active" && (
                        <button
                          className="btn danger"
                          onClick={() =>
                            void act(
                              () => api(`/v1/admin/entitlements/${e.entitlement_id}/revoke`, { method: "POST", body: {}, token }),
                              "授权已撤销",
                            )
                          }
                        >
                          撤销
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === "packs" && (
        <>
          <h2>套装发布</h2>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>套装</th>
                  <th>版本</th>
                  <th>状态</th>
                  <th>签名密钥</th>
                  <th>最低客户端</th>
                  <th>发布时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {releases.map((r) => (
                  <tr key={`${r.pack_id}@${r.version}`}>
                    <td>{r.pack_id}</td>
                    <td>{r.version}</td>
                    <td>
                      <span className={`pill ${r.status}`}>{r.status}</span>
                    </td>
                    <td>{r.signature_key_id}</td>
                    <td>{r.min_desktop_version}</td>
                    <td>{new Date(r.created_at).toLocaleString("zh-CN")}</td>
                    <td>
                      {r.status === "active" && (
                        <button
                          className="btn danger"
                          onClick={() =>
                            void act(
                              () => api(`/v1/admin/packs/${r.pack_id}/${r.version}/revoke`, { method: "POST", body: {}, token }),
                              "版本已吊销",
                            )
                          }
                        >
                          吊销
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted mt">套装上传发布请使用 Console 命令行（云端签名后自动上架）。</p>
          </div>
        </>
      )}

      {tab === "clients" && (
        <>
          <h2>客户端版本</h2>
          <ClientUploadForm
            onUpload={(version, file) => void act(
              () => uploadClientRelease(token, version, file),
              "安装包已签名上传并保持暂停；请验证后再开启灰度",
            )}
          />
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>版本</th>
                  <th>文件</th>
                  <th>大小</th>
                  <th>上传人</th>
                  <th>上传时间</th>
                  <th>发布策略</th>
                  <th>下载</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {clientReleases.map((r) => (
                  <tr key={r.manifest.version}>
                    <td>{r.manifest.version} · #{r.manifest.sequence}</td>
                    <td>{r.manifest.filename}</td>
                    <td>{(r.manifest.size / 1024 / 1024).toFixed(1)} MB</td>
                    <td>{r.uploaded_by}</td>
                    <td>{new Date(r.uploaded_at).toLocaleString("zh-CN")}</td>
                    <td>
                      {r.manifest.rollout.status === "paused"
                        ? `已暂停（保留 ${(r.manifest.rollout.basis_points / 100).toFixed(2)}%）`
                        : `灰度 ${(r.manifest.rollout.basis_points / 100).toFixed(2)}%`}
                      <br />
                      <span className="muted">
                        #{r.manifest.sequence} · 回滚数据：
                        {r.manifest.rollback_data_strategy === "snapshot_required" ? "恢复快照" : "向后兼容"}
                      </span>
                    </td>
                    <td>
                      <a href={r.url}>下载</a>
                    </td>
                    <td>
                      {[500, 2_500, 10_000].map((basisPoints) => (
                        <button
                          key={basisPoints}
                          className="btn"
                          disabled={
                            clientReleases.find((item) =>
                              item.manifest.channel === r.manifest.channel)?.manifest.version !== r.manifest.version ||
                            r.manifest.rollout.status === "active" &&
                            r.manifest.rollout.basis_points === basisPoints
                          }
                          onClick={() => void act(
                            () => api(`/v1/admin/client-releases/${encodeURIComponent(r.manifest.version)}/rollout`, {
                              method: "PATCH",
                              body: { status: "active", basis_points: basisPoints },
                              token,
                            }),
                            `客户端 ${r.manifest.version} 灰度已调整为 ${basisPoints / 100}%`,
                          )}
                        >
                          {basisPoints / 100}%
                        </button>
                      ))}
                      <button
                        className="btn danger"
                        disabled={
                          clientReleases.find((item) =>
                            item.manifest.channel === r.manifest.channel)?.manifest.version !== r.manifest.version ||
                          r.manifest.rollout.status === "paused"
                        }
                        onClick={() => void act(
                          () => api(`/v1/admin/client-releases/${encodeURIComponent(r.manifest.version)}/rollout`, {
                            method: "PATCH",
                            body: {
                              status: "paused",
                              basis_points: r.manifest.rollout.basis_points,
                            },
                            token,
                          }),
                          `客户端 ${r.manifest.version} 已暂停`,
                        )}
                      >
                        暂停
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted mt">
              新上传版本默认暂停。灰度比例和暂停操作都会生成更高签名序列；仅当前渠道最新版本可调整。
            </p>
          </div>
        </>
      )}

      {tab === "products" && (
        <>
          <h2>商品定价</h2>
          <ProductForm
            onCreate={(p) => void act(() => api("/v1/admin/products", { method: "POST", body: p, token }), "商品已创建")}
          />
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>名称</th>
                  <th>套装</th>
                  <th>月付</th>
                  <th>年付</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <tr key={p.product_id}>
                    <td>{p.name}</td>
                    <td>{p.pack_id}</td>
                    <td>{yuan(p.price_monthly_fen)}</td>
                    <td>{yuan(p.price_yearly_fen)}</td>
                    <td>
                      <span className={`pill ${p.status}`}>{p.status === "listed" ? "上架" : "下架"}</span>
                    </td>
                    <td>
                      <button
                        className={`btn ${p.status === "listed" ? "danger" : ""}`}
                        onClick={() =>
                          void act(
                            () =>
                              api(`/v1/admin/products/${p.product_id}`, {
                                method: "POST",
                                body: { status: p.status === "listed" ? "unlisted" : "listed" },
                                token,
                              }),
                            "商品状态已更新",
                          )
                        }
                      >
                        {p.status === "listed" ? "下架" : "上架"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === "activation-codes" && (
        <>
          <h2>客户端授权码</h2>
          <ActivationCodeForm onCreate={(body) => void createActivationCode(body)} />
          {generatedCode && (
            <div className="card">
              <h3>新授权码（仅显示一次）</h3>
              <div className="row">
                <input readOnly value={generatedCode} style={{ flex: 1, fontFamily: "monospace", fontWeight: 700 }} />
                <button className="btn ghost" onClick={() => void navigator.clipboard.writeText(generatedCode)}>复制</button>
              </div>
            </div>
          )}
          <div className="card">
            <table>
              <thead><tr><th>标签</th><th>尾号</th><th>使用</th><th>智能体套装</th><th>到期</th><th>状态</th><th>操作</th></tr></thead>
              <tbody>
                {activationCodes.map((code) => (
                  <tr key={code.activation_code_id}>
                    <td>{code.label || "—"}</td>
                    <td>••••-{code.code_hint}</td>
                    <td>{code.use_count}/{code.max_uses}</td>
                    <td>{code.pack_ids.join(", ") || "基础助手"}</td>
                    <td>{new Date(code.expires_at).toLocaleDateString("zh-CN")}</td>
                    <td><span className={`pill ${code.status}`}>{code.status === "active" ? "有效" : "已撤销"}</span></td>
                    <td>{code.status === "active" && (
                      <button className="btn danger" onClick={() => void act(
                        () => api(`/v1/admin/activation-codes/${code.activation_code_id}/revoke`, { method: "POST", body: {}, token }),
                        "授权码已撤销，已激活设备将立即失去模型访问权",
                      )}>撤销</button>
                    )}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === "model" && (
        <>
          <h2>默认模型</h2>
          {modelConfig && (
            <ModelConfigForm
              config={modelConfig}
              onSave={(body) => void act(() => api("/v1/admin/model-config", { method: "POST", body, token }), "默认模型配置已保存")}
              onTest={() => void act(() => api("/v1/admin/model-config/test", { method: "POST", body: {}, token }), "上游模型连接正常")}
            />
          )}
        </>
      )}

      {tab === "knowledge" && (
        <>
          <h2>租户知识库</h2>
          <KnowledgeDocumentForm
            tenantId={knowledgeTenant}
            onTenantChange={setKnowledgeTenant}
            onCreate={(body) => void act(
              () => api("/v1/admin/knowledge-documents", { method: "POST", body, token }),
              "知识文档已加密保存",
            )}
          />
          <div className="card">
            <table>
              <thead><tr><th>标题</th><th>来源</th><th>租户</th><th>大小</th><th>创建时间</th><th>操作</th></tr></thead>
              <tbody>{knowledgeDocuments.map((document) => (
                <tr key={document.document_id}>
                  <td>{document.title}</td><td>{document.source_label}</td><td>{document.tenant_id}</td>
                  <td>{document.bytes.toLocaleString("zh-CN")} B</td>
                  <td>{new Date(document.created_at).toLocaleString("zh-CN")}</td>
                  <td><button className="btn danger" onClick={() => void act(
                    () => api(`/v1/admin/knowledge-documents/${document.document_id}`, { method: "DELETE", token }),
                    "知识文档已删除",
                  )}>删除</button></td>
                </tr>
              ))}</tbody>
            </table>
            <p className="muted mt">列表只显示元数据；正文使用独立知识数据密钥加密，设备查询按租户隔离。</p>
          </div>
        </>
      )}

      {tab === "pack-reviews" && (
        <>
          <h2>第三方 Pack 审核</h2>
          <PackReviewForm onSubmit={(body) => void submitPackReview(body)} />
          <div className="card">
            <table>
              <thead><tr><th>发布者</th><th>Pack</th><th>状态</th><th>扫描结果</th><th>更新时间</th><th>操作</th></tr></thead>
              <tbody>{packReviews.map((review) => (
                <tr key={review.review_id}>
                  <td>{review.publisher}</td><td>{review.pack_id}@{review.version}</td>
                  <td><span className={`pill ${review.status}`}>{review.status}</span></td>
                  <td>{review.findings.length ? review.findings.join("；") : "未发现固定危险模式"}</td>
                  <td>{new Date(review.updated_at).toLocaleString("zh-CN")}</td>
                  <td>{review.status === "submitted" && <button className="btn" onClick={() => void act(
                    () => api(`/v1/admin/pack-reviews/${review.review_id}/approve`, { method: "POST", body: {}, token }),
                    "Pack 已重新校验、签名并发布",
                  )}>批准并发布</button>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </>
      )}

      {tab === "orders" && (
        <>
          <h2>订单管理</h2>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>订单号</th>
                  <th>用户</th>
                  <th>类型</th>
                  <th>金额</th>
                  <th>状态</th>
                  <th>支付方式</th>
                  <th>时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.order_id}>
                    <td>{o.order_id.slice(0, 14)}…</td>
                    <td>{o.user_id.slice(0, 14)}…</td>
                    <td>{o.type === "plan" ? `订阅 ${o.pack_id ?? ""} (${o.period ?? ""})` : "充值"}</td>
                    <td>{yuan(o.amount_fen)}</td>
                    <td>
                      <span className={`pill ${o.status}`}>{o.status}</span>
                    </td>
                    <td>{o.pay_method ?? "—"}</td>
                    <td>{new Date(o.created_at).toLocaleString("zh-CN")}</td>
                    <td>
                      {o.status === "paid" && (
                        <button
                          className="btn danger"
                          onClick={() =>
                            void act(
                              () => api(`/v1/admin/orders/${o.order_id}/refund`, { method: "POST", body: {}, token }),
                              "退款已入余额",
                            )
                          }
                        >
                          退款
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === "transactions" && (
        <>
          <h2>余额流水</h2>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>流水号</th>
                  <th>用户</th>
                  <th>类型</th>
                  <th>变动</th>
                  <th>余额</th>
                  <th>备注</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {txns.map((t) => (
                  <tr key={t.txn_id}>
                    <td>{t.txn_id.slice(0, 14)}…</td>
                    <td>{t.user_id.slice(0, 14)}…</td>
                    <td>{t.type}</td>
                    <td>{t.amount_fen > 0 ? `+${yuan(t.amount_fen)}` : `-${yuan(-t.amount_fen)}`}</td>
                    <td>{yuan(t.balance_after_fen)}</td>
                    <td>{t.remark ?? "—"}</td>
                    <td>{new Date(t.created_at).toLocaleString("zh-CN")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === "audits" && (
        <>
          <h2>审计日志</h2>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>操作者</th>
                  <th>动作</th>
                  <th>详情</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {audits.map((a) => (
                  <tr key={a.audit_id}>
                    <td>{a.actor}</td>
                    <td>{a.action}</td>
                    <td>{a.detail ? JSON.stringify(a.detail) : "—"}</td>
                    <td>{new Date(a.created_at).toLocaleString("zh-CN")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {notice && <p className="notice">{notice}</p>}
      {error && <p className="error">{error}</p>}
    </>
  );
}

function KnowledgeDocumentForm(props: {
  tenantId: string;
  onTenantChange: (tenantId: string) => void;
  onCreate: (body: Record<string, unknown>) => void;
}): JSX.Element {
  const [title, setTitle] = useState("");
  const [sourceLabel, setSourceLabel] = useState("");
  const [content, setContent] = useState("");
  return (
    <div className="card">
      <h3>新增知识文档</h3>
      <div className="form-grid">
        <label>租户 ID<input value={props.tenantId} onChange={(event) => props.onTenantChange(event.target.value)} /></label>
        <label>标题<input value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} /></label>
        <label className="span-2">来源标识<input value={sourceLabel} maxLength={200} onChange={(event) => setSourceLabel(event.target.value)} /></label>
        <label className="span-2">正文（最大 1 MiB）<textarea value={content} onChange={(event) => setContent(event.target.value)} /></label>
      </div>
      <button className="btn mt" disabled={!props.tenantId.trim() || !title.trim() || !sourceLabel.trim() || !content.trim()} onClick={() => {
        props.onCreate({ tenant_id: props.tenantId.trim(), title: title.trim(), source_label: sourceLabel.trim(), content });
        setTitle(""); setSourceLabel(""); setContent("");
      }}>加密保存</button>
    </div>
  );
}

function PackReviewForm(props: { onSubmit: (body: Record<string, unknown>) => void }): JSX.Element {
  const [publisher, setPublisher] = useState("");
  const [packJson, setPackJson] = useState("");
  const [parseError, setParseError] = useState("");
  const submit = (): void => {
    try {
      const pack = JSON.parse(packJson) as unknown;
      setParseError("");
      props.onSubmit({ publisher: publisher.trim(), pack });
    } catch {
      setParseError("Pack JSON 格式无效");
    }
  };
  return (
    <div className="card">
      <h3>提交审核</h3>
      <div className="form-grid">
        <label className="span-2">发布者<input value={publisher} maxLength={128} onChange={(event) => setPublisher(event.target.value)} /></label>
        <label className="span-2">Pack JSON<textarea value={packJson} onChange={(event) => setPackJson(event.target.value)} /></label>
      </div>
      <button className="btn mt" disabled={!publisher.trim() || !packJson.trim()} onClick={submit}>扫描并提交</button>
      {parseError && <p className="error">{parseError}</p>}
      <p className="muted mt">自动扫描通过后仍需人工批准；批准时会再次校验、使用平台密钥签名并发布。</p>
    </div>
  );
}

function ModelConfigForm(props: {
  config: AdminModelConfig;
  onSave: (body: Record<string, unknown>) => void;
  onTest: () => void;
}): JSX.Element {
  const [enabled, setEnabled] = useState(props.config.enabled);
  const [emergencyDisabled, setEmergencyDisabled] = useState(props.config.emergency_disabled);
  const [configId, setConfigId] = useState(props.config.config_id);
  const [scopeType, setScopeType] = useState(props.config.scope_type);
  const [scopeId, setScopeId] = useState(props.config.scope_id);
  const [baseUrl, setBaseUrl] = useState(props.config.base_url);
  const [modelId, setModelId] = useState(props.config.model_id);
  const [displayName, setDisplayName] = useState(props.config.display_name);
  const [apiType, setApiType] = useState(props.config.api_type);
  const [contextWindow, setContextWindow] = useState(String(props.config.context_window));
  const [maxTokens, setMaxTokens] = useState(String(props.config.max_tokens));
  const [apiKey, setApiKey] = useState("");
  const [assistantName, setAssistantName] = useState(props.config.assistant_name);
  const [welcomeMessage, setWelcomeMessage] = useState(props.config.welcome_message);
  const [timeoutMs, setTimeoutMs] = useState(String(props.config.request_timeout_ms));
  const [maxRetries, setMaxRetries] = useState(String(props.config.max_retries));
  const [rate, setRate] = useState(String(props.config.device_requests_per_minute));
  const [dailyTokens, setDailyTokens] = useState(String(props.config.device_daily_tokens));
  const [monthlyTokens, setMonthlyTokens] = useState(String(props.config.tenant_monthly_tokens));
  const [concurrency, setConcurrency] = useState(String(props.config.max_device_concurrency));

  useEffect(() => {
    setEnabled(props.config.enabled);
    setEmergencyDisabled(props.config.emergency_disabled);
    setConfigId(props.config.config_id);
    setScopeType(props.config.scope_type);
    setScopeId(props.config.scope_id);
    setBaseUrl(props.config.base_url);
    setModelId(props.config.model_id);
    setDisplayName(props.config.display_name);
    setApiType(props.config.api_type);
    setContextWindow(String(props.config.context_window));
    setMaxTokens(String(props.config.max_tokens));
    setApiKey("");
    setAssistantName(props.config.assistant_name);
    setWelcomeMessage(props.config.welcome_message);
    setTimeoutMs(String(props.config.request_timeout_ms));
    setMaxRetries(String(props.config.max_retries));
    setRate(String(props.config.device_requests_per_minute));
    setDailyTokens(String(props.config.device_daily_tokens));
    setMonthlyTokens(String(props.config.tenant_monthly_tokens));
    setConcurrency(String(props.config.max_device_concurrency));
  }, [props.config]);

  const valid = Boolean(baseUrl && modelId && displayName && Number(contextWindow) > 0 && Number(maxTokens) > 0);
  return (
    <div className="card model-form">
      <p className="muted">客户端只会看到“龙枢默认模型”，真实上游模型和密钥不会下发给用户。</p>
      {!props.config.encryption_ready && <p className="error">服务端尚未配置 MODEL_CONFIG_KEY，当前不能保存 API Key。</p>}
      <label className="switch-row">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        启用客户端默认模型
      </label>
      <label className="switch-row"><input type="checkbox" checked={emergencyDisabled} onChange={(e) => setEmergencyDisabled(e.target.checked)} />紧急暂停该策略</label>
      <div className="form-grid">
        <label>策略 ID<input value={configId} onChange={(e) => setConfigId(e.target.value)} /></label>
        <label>作用域<select value={scopeType} onChange={(e) => setScopeType(e.target.value as AdminModelConfig["scope_type"])}><option value="global">全局</option><option value="tenant">租户</option><option value="plan">套餐</option><option value="device">设备</option></select></label>
        <label>作用域 ID<input value={scopeId} disabled={scopeType === "global"} onChange={(e) => setScopeId(e.target.value)} /></label>
        <label>OpenAI 兼容 Base URL<input placeholder="https://api.example.com/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></label>
        <label>真实模型 ID<input placeholder="例如 gpt-4.1" value={modelId} onChange={(e) => setModelId(e.target.value)} /></label>
        <label>客户端显示名称<input value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></label>
        <label>接口格式<select value={apiType} onChange={(e) => setApiType(e.target.value as AdminModelConfig["api_type"])}><option value="openai-completions">Chat Completions</option><option value="openai-responses">Responses</option></select></label>
        <label>上下文窗口<input type="number" value={contextWindow} onChange={(e) => setContextWindow(e.target.value)} /></label>
        <label>最大输出 Token<input type="number" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} /></label>
        <label>助手名称<input value={assistantName} onChange={(e) => setAssistantName(e.target.value)} /></label>
        <label>欢迎语<input value={welcomeMessage} onChange={(e) => setWelcomeMessage(e.target.value)} /></label>
        <label>上游超时（毫秒）<input type="number" value={timeoutMs} onChange={(e) => setTimeoutMs(e.target.value)} /></label>
        <label>失败重试（0–2）<input type="number" value={maxRetries} onChange={(e) => setMaxRetries(e.target.value)} /></label>
        <label>设备每分钟请求<input type="number" value={rate} onChange={(e) => setRate(e.target.value)} /></label>
        <label>设备每日 Token<input type="number" value={dailyTokens} onChange={(e) => setDailyTokens(e.target.value)} /></label>
        <label>租户每月 Token<input type="number" value={monthlyTokens} onChange={(e) => setMonthlyTokens(e.target.value)} /></label>
        <label>设备并发<input type="number" value={concurrency} onChange={(e) => setConcurrency(e.target.value)} /></label>
        <label className="span-2">API Key<input type="password" autoComplete="new-password" placeholder={props.config.has_api_key ? "已安全保存；留空表示不更换" : "请输入上游 API Key"} value={apiKey} onChange={(e) => setApiKey(e.target.value)} /></label>
      </div>
      <div className="row mt">
        <button className="btn" disabled={!valid || !props.config.encryption_ready} onClick={() => props.onSave({ config_id: configId, scope_type: scopeType, scope_id: scopeType === "global" ? "-" : scopeId, enabled, emergency_disabled: emergencyDisabled, base_url: baseUrl, model_id: modelId, display_name: displayName, api_type: apiType, context_window: Number(contextWindow), max_tokens: Number(maxTokens), assistant_name: assistantName, welcome_message: welcomeMessage, request_timeout_ms: Number(timeoutMs), max_retries: Number(maxRetries), device_requests_per_minute: Number(rate), device_daily_tokens: Number(dailyTokens), tenant_monthly_tokens: Number(monthlyTokens), max_device_concurrency: Number(concurrency), ...(apiKey ? { api_key: apiKey } : {}) })}>保存配置</button>
        <button className="btn ghost" disabled={!props.config.enabled || !props.config.has_api_key} onClick={props.onTest}>测试连接</button>
        {props.config.updated_at && <span className="muted">上次更新：{new Date(props.config.updated_at).toLocaleString("zh-CN")}</span>}
      </div>
    </div>
  );
}

function AdjustBalance(props: { onAdjust: (fen: number, remark: string) => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [remark, setRemark] = useState("");

  if (!open) {
    return (
      <button className="btn ghost" onClick={() => setOpen(true)}>
        调账
      </button>
    );
  }
  return (
    <div className="row">
      <input style={{ width: 90 }} placeholder="±元" value={amount} onChange={(e) => setAmount(e.target.value)} />
      <input style={{ width: 110 }} placeholder="备注" value={remark} onChange={(e) => setRemark(e.target.value)} />
      <button
        className="btn"
        disabled={!Number.isFinite(Number(amount)) || Number(amount) === 0}
        onClick={() => {
          props.onAdjust(Math.round(Number(amount) * 100), remark || "管理端调账");
          setOpen(false);
          setAmount("");
          setRemark("");
        }}
      >
        确认
      </button>
      <button className="btn ghost" onClick={() => setOpen(false)}>
        取消
      </button>
    </div>
  );
}

function GrantForm(props: { onGrant: (deviceId: string, packId: string) => void }): JSX.Element {
  const [deviceId, setDeviceId] = useState("");
  const [packId, setPackId] = useState("longhub.hr-suite");
  return (
    <div className="card">
      <h3>手动授予授权</h3>
      <div className="row">
        <input style={{ flex: 1, minWidth: 220 }} placeholder="设备 ID（dev-…）" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} />
        <input style={{ width: 200 }} placeholder="套装 ID" value={packId} onChange={(e) => setPackId(e.target.value)} />
        <button
          className="btn"
          disabled={!deviceId.trim() || !packId.trim()}
          onClick={() => {
            props.onGrant(deviceId.trim(), packId.trim());
            setDeviceId("");
          }}
        >
          授予
        </button>
      </div>
    </div>
  );
}

function ActivationCodeForm(props: { onCreate: (body: Record<string, unknown>) => void }): JSX.Element {
  const [label, setLabel] = useState("");
  const [maxUses, setMaxUses] = useState("1");
  const [days, setDays] = useState("365");
  const [packIds, setPackIds] = useState("");
  const uses = Number(maxUses);
  const expiresInDays = Number(days);
  const valid = Number.isInteger(uses) && uses > 0 && Number.isInteger(expiresInDays) && expiresInDays > 0;
  return (
    <div className="card">
      <h3>生成授权码</h3>
      <p className="muted">授权码明文只返回一次；核销后设备才能启动模型和龙枢 WebUI。</p>
      <div className="row">
        <input style={{ minWidth: 160 }} placeholder="标签（客户/订单）" value={label} onChange={(e) => setLabel(e.target.value)} />
        <input style={{ width: 110 }} type="number" min="1" max="10000" placeholder="设备数" value={maxUses} onChange={(e) => setMaxUses(e.target.value)} />
        <input style={{ width: 120 }} type="number" min="1" max="3650" placeholder="有效天数" value={days} onChange={(e) => setDays(e.target.value)} />
        <input style={{ flex: 1, minWidth: 220 }} placeholder="附带套装 ID，逗号分隔（可空）" value={packIds} onChange={(e) => setPackIds(e.target.value)} />
        <button className="btn" disabled={!valid} onClick={() => props.onCreate({
          label: label.trim() || undefined,
          max_uses: uses,
          expires_in_days: expiresInDays,
          pack_ids: packIds.split(",").map((value) => value.trim()).filter(Boolean),
        })}>生成</button>
      </div>
    </div>
  );
}

function ClientUploadForm(props: { onUpload: (version: string, file: File) => void }): JSX.Element {
  const [version, setVersion] = useState("1.0.0");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="card">
      <h3>上传新版本安装包</h3>
      <div className="row">
        <input style={{ width: 110 }} placeholder="版本 x.y.z" value={version} onChange={(e) => setVersion(e.target.value)} />
        <input type="file" accept=".exe" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <button
          className="btn"
          disabled={busy || !file || !/^\d+\.\d+\.\d+$/.test(version)}
          onClick={() => {
            if (!file) return;
            setBusy(true);
            props.onUpload(version, file);
            setBusy(false);
          }}
        >
          {busy ? "上传中…" : "上传并上架"}
        </button>
      </div>
      <p className="muted mt">上传成功后官网下载页立即展示该版本的下载按钮。</p>
    </div>
  );
}

function ProductForm(props: {
  onCreate: (p: { pack_id: string; name: string; description: string; price_monthly_fen: number; price_yearly_fen: number }) => void;
}): JSX.Element {
  const [packId, setPackId] = useState("longhub.hr-suite");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [monthly, setMonthly] = useState("99");
  const [yearly, setYearly] = useState("699");
  const valid = packId.trim() && name.trim() && Number(monthly) > 0 && Number(yearly) > 0;
  return (
    <div className="card">
      <h3>新建商品</h3>
      <div className="row">
        <input style={{ width: 180 }} placeholder="套装 ID" value={packId} onChange={(e) => setPackId(e.target.value)} />
        <input style={{ width: 160 }} placeholder="商品名称" value={name} onChange={(e) => setName(e.target.value)} />
        <input style={{ flex: 1, minWidth: 200 }} placeholder="描述" value={description} onChange={(e) => setDescription(e.target.value)} />
        <input style={{ width: 90 }} placeholder="月付(元)" value={monthly} onChange={(e) => setMonthly(e.target.value)} />
        <input style={{ width: 90 }} placeholder="年付(元)" value={yearly} onChange={(e) => setYearly(e.target.value)} />
        <button
          className="btn"
          disabled={!valid}
          onClick={() =>
            props.onCreate({
              pack_id: packId.trim(),
              name: name.trim(),
              description: description.trim(),
              price_monthly_fen: Math.round(Number(monthly) * 100),
              price_yearly_fen: Math.round(Number(yearly) * 100),
            })
          }
        >
          创建
        </button>
      </div>
    </div>
  );
}
