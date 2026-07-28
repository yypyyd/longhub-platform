/** 龙枢管理后台：登录 + 看板/用户/设备/授权/套装/商品/订单/流水/审计。 */
import { useCallback, useEffect, useState } from "react";
import {
  api,
  ApiError,
  uploadClientRelease,
  yuan,
  type ClientRelease,
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
  | "entitlements"
  | "packs"
  | "clients"
  | "products"
  | "orders"
  | "transactions"
  | "audits";

const TABS: { key: Tab; label: string }[] = [
  { key: "dashboard", label: "看板" },
  { key: "users", label: "用户" },
  { key: "devices", label: "设备" },
  { key: "entitlements", label: "授权" },
  { key: "packs", label: "套装发布" },
  { key: "clients", label: "客户端版本" },
  { key: "products", label: "商品定价" },
  { key: "orders", label: "订单" },
  { key: "transactions", label: "余额流水" },
  { key: "audits", label: "审计日志" },
];

const TOKEN_KEY = "longhub_admin_token";
const WHO_KEY = "longhub_admin_who";

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
        <div className="brand">龙枢管理后台</div>
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
  const [entitlements, setEntitlements] = useState<AdminEntitlement[]>([]);
  const [releases, setReleases] = useState<AdminRelease[]>([]);
  const [clientReleases, setClientReleases] = useState<ClientRelease[]>([]);
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [txns, setTxns] = useState<AdminTxn[]>([]);
  const [audits, setAudits] = useState<AdminAudit[]>([]);

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
      if (tab === "entitlements")
        setEntitlements((await api<{ entitlements: AdminEntitlement[] }>("/v1/admin/entitlements", { token })).entitlements);
      if (tab === "packs") setReleases((await api<{ releases: AdminRelease[] }>("/v1/admin/packs", { token })).releases);
      if (tab === "clients")
        setClientReleases((await api<{ releases: ClientRelease[] }>("/v1/admin/client-releases", { token })).releases);
      if (tab === "products") setProducts((await api<{ products: AdminProduct[] }>("/v1/admin/products", { token })).products);
      if (tab === "orders") setOrders((await api<{ orders: AdminOrder[] }>("/v1/admin/orders", { token })).orders);
      if (tab === "transactions") setTxns((await api<{ transactions: AdminTxn[] }>("/v1/admin/transactions", { token })).transactions);
      if (tab === "audits") setAudits((await api<{ audits: AdminAudit[] }>("/v1/admin/audits", { token })).audits);
    } catch (err) {
      guard(err);
    }
  }, [tab, token, guard]);

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
                  <th>注册时间</th>
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
                    <td>{new Date(d.created_at).toLocaleString("zh-CN")}</td>
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
            onUpload={(version, file) => void act(() => uploadClientRelease(token, version, file), "安装包已上传并上架")}
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
                  <th>下载</th>
                </tr>
              </thead>
              <tbody>
                {clientReleases.map((r) => (
                  <tr key={r.version}>
                    <td>{r.version}</td>
                    <td>{r.filename}</td>
                    <td>{(r.size / 1024 / 1024).toFixed(1)} MB</td>
                    <td>{r.uploaded_by}</td>
                    <td>{new Date(r.uploaded_at).toLocaleString("zh-CN")}</td>
                    <td>
                      <a href={r.url}>下载</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted mt">列表首个版本会作为官网下载页的最新版本。</p>
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
