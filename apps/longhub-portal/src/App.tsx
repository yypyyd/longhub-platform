/** 龙枢官网：首页 / 定价 / 下载 / 注册登录 / 个人中心（余额、订单、设备、订阅、购买、充值）。 */
import { useCallback, useEffect, useState } from "react";
import {
  api,
  ApiError,
  yuan,
  type Device,
  type Entitlement,
  type Me,
  type Order,
  type Product,
  type Txn,
} from "./api";

type View = "home" | "pricing" | "download" | "login" | "register" | "account";

const TOKEN_KEY = "longhub_portal_token";

export function App(): JSX.Element {
  const [view, setView] = useState<View>("home");
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));

  const onLogin = (t: string): void => {
    localStorage.setItem(TOKEN_KEY, t);
    setToken(t);
    setView("account");
  };

  const onLogout = (): void => {
    if (token) void api("/v1/auth/logout", { method: "POST", body: {}, token }).catch(() => undefined);
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setView("home");
  };

  return (
    <>
      <nav className="nav">
        <span className="brand" onClick={() => setView("home")}>
          <img src="/longhub-avatar.png" alt="" />
          <span>龙枢 LongHub</span>
        </span>
        <button className="link" onClick={() => setView("pricing")}>
          定价
        </button>
        <button className="link" onClick={() => setView("download")}>
          下载
        </button>
        <span className="spacer" />
        {token ? (
          <>
            <button className="link" onClick={() => setView("account")}>
              个人中心
            </button>
            <button className="link" onClick={onLogout}>
              退出
            </button>
          </>
        ) : (
          <>
            <button className="link" onClick={() => setView("login")}>
              登录
            </button>
            <button className="link" onClick={() => setView("register")}>
              注册
            </button>
          </>
        )}
      </nav>
      {view === "home" && <Home goPricing={() => setView("pricing")} goDownload={() => setView("download")} />}
      {view === "pricing" && <Pricing token={token} goLogin={() => setView("login")} goAccount={() => setView("account")} />}
      {view === "download" && <Download />}
      {view === "login" && <Auth mode="login" onDone={onLogin} switchMode={() => setView("register")} />}
      {view === "register" && <Auth mode="register" onDone={onLogin} switchMode={() => setView("login")} />}
      {view === "account" && token && <Account token={token} onExpired={onLogout} />}
      <div className="footer">© {new Date().getFullYear()} 龙枢 LongHub · 本地 AI 数字员工平台</div>
    </>
  );
}

function Home(props: { goPricing: () => void; goDownload: () => void }): JSX.Element {
  return (
    <>
      <div className="hero">
        <h1>
          你的本地 AI 数字员工
          <br />
          数据不出门，能力不设限
        </h1>
        <p className="sub">龙枢工作台把 HR 数字员工装进你的 Windows 电脑，简历筛选、Offer、JD 一键完成。</p>
        <div className="cta">
          <button className="btn" onClick={props.goPricing}>
            查看定价
          </button>
          <button className="btn ghost" onClick={props.goDownload}>
            下载客户端
          </button>
        </div>
      </div>
      <div className="page">
        <div className="grid cols-3">
          <div className="card">
            <h3>简历智能筛选</h3>
            <p>按 JD 要求自动打分与推荐，批量处理候选人简历，几秒出结果。</p>
          </div>
          <div className="card">
            <h3>Offer 与 JD 生成</h3>
            <p>一键生成规范 Offer 函与岗位 JD 草稿，风格统一、要点完整。</p>
          </div>
          <div className="card">
            <h3>本地执行 · 云端授权</h3>
            <p>技能包经云端签名分发、本地验签执行，敏感数据保留在你的设备上。</p>
          </div>
        </div>
      </div>
    </>
  );
}

interface ClientRelease {
  manifest: {
    version: string;
    filename: string;
    size: number;
    url_path: string;
    rollout: {
      status: "active" | "paused";
      basis_points: number;
    };
  };
  signature_key_id: string;
  signature: string;
}

function Download(): JSX.Element {
  const [release, setRelease] = useState<ClientRelease | null | undefined>();

  useEffect(() => {
    void api<{ release: ClientRelease | null }>("/v1/client-releases/latest")
      .then((r) => setRelease(r.release))
      .catch(() => setRelease(null));
  }, []);

  return (
    <div className="page">
      <h2 className="section">下载龙枢工作台</h2>
      <div className="grid cols-2">
        <div className="card">
          <h3>Windows 客户端</h3>
          <p>
            支持 Windows 10/11（64 位）。安装后使用邮箱账号登录，在「个人中心 → 我的设备」中绑定设备，即可下载已订阅的数字员工套装。
          </p>
          {release?.manifest.rollout.status === "active" &&
          release.manifest.rollout.basis_points === 10_000 ? (
            <p className="mt">
              <a className="btn" href={release.manifest.url_path}>
                下载 Windows 安装包（v{release.manifest.version}，
                {(release.manifest.size / 1024 / 1024).toFixed(0)} MB）
              </a>
            </p>
          ) : release?.manifest.rollout.status === "active" ? (
            <p className="mt muted">
              v{release.manifest.version} 正在分批灰度，符合条件的已安装客户端会自动收到更新。
            </p>
          ) : (
            <p className="mt muted">
              {release === undefined
                ? "正在获取最新版本…"
                : release?.manifest.rollout.status === "paused"
                  ? `v${release.manifest.version} 暂停发布，当前不会提供下载。`
                  : "安装包正在打包上架，暂请联系管理员获取内测版本。"}
            </p>
          )}
        </div>
        <div className="card">
          <h3>快速上手</h3>
          <p>1. 注册账号并购买订阅（或充值后用余额购买）。</p>
          <p>2. 客户端首次启动会显示设备 ID，在个人中心绑定。</p>
          <p>3. 绑定后授权自动下发，客户端即可安装并运行 HR 套装。</p>
        </div>
      </div>
    </div>
  );
}

function Pricing(props: { token: string | null; goLogin: () => void; goAccount: () => void }): JSX.Element {
  const [products, setProducts] = useState<Product[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void api<{ products: Product[] }>("/v1/products").then((r) => setProducts(r.products), () => setError("加载商品失败"));
  }, []);

  const buy = async (product: Product, period: "monthly" | "yearly"): Promise<void> => {
    if (!props.token) {
      props.goLogin();
      return;
    }
    setError("");
    setMessage("");
    try {
      const order = await api<Order>("/v1/orders", {
        method: "POST",
        body: { type: "plan", product_id: product.product_id, period },
        token: props.token,
      });
      await api(`/v1/orders/${order.order_id}/pay`, { method: "POST", body: { method: "balance" }, token: props.token });
      setMessage("购买成功，授权已发放到你绑定的设备，可前往个人中心查看。");
    } catch (err) {
      if (err instanceof ApiError && err.code === "INSUFFICIENT_BALANCE") {
        setError("余额不足，请先到个人中心充值。");
      } else {
        setError(err instanceof Error ? err.message : "购买失败");
      }
    }
  };

  return (
    <div className="page">
      <h2 className="section">简单透明的定价</h2>
      <div className="grid cols-2">
        {products.map((p) => (
          <div className="card price-card" key={p.product_id}>
            <h3>{p.name}</h3>
            <p>{p.description}</p>
            <div className="price">{yuan(p.price_monthly_fen)}</div>
            <div className="per">每月 · 或按年 {yuan(p.price_yearly_fen)}</div>
            <div className="row" style={{ justifyContent: "center" }}>
              <button className="btn" onClick={() => void buy(p, "monthly")}>
                按月订阅
              </button>
              <button className="btn ghost" onClick={() => void buy(p, "yearly")}>
                按年订阅
              </button>
            </div>
          </div>
        ))}
        {products.length === 0 && <p className="muted" style={{ textAlign: "center" }}>暂无上架商品</p>}
      </div>
      {message && (
        <p className="notice">
          {message} <a onClick={props.goAccount}>前往个人中心</a>
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function Auth(props: { mode: "login" | "register"; onDone: (token: string) => void; switchMode: () => void }): JSX.Element {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const isLogin = props.mode === "login";

  const submit = async (): Promise<void> => {
    setError("");
    setBusy(true);
    try {
      const path = isLogin ? "/v1/auth/login" : "/v1/auth/register";
      const res = await api<{ token: string }>(path, { method: "POST", body: { email, password } });
      props.onDone(res.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="form card">
        <h2>{isLogin ? "登录龙枢" : "创建账号"}</h2>
        <label>邮箱</label>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        <label>密码{isLogin ? "" : "（至少 8 位）"}</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
        <button className="btn" disabled={busy || !email || !password} onClick={() => void submit()}>
          {isLogin ? "登录" : "注册"}
        </button>
        {error && <p className="error">{error}</p>}
        <p className="alt">
          {isLogin ? "还没有账号？" : "已有账号？"}
          <a onClick={props.switchMode}>{isLogin ? "立即注册" : "去登录"}</a>
        </p>
      </div>
    </div>
  );
}

function Account(props: { token: string; onExpired: () => void }): JSX.Element {
  const [me, setMe] = useState<Me | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [txns, setTxns] = useState<Txn[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [entitlements, setEntitlements] = useState<Entitlement[]>([]);
  const [rechargeYuan, setRechargeYuan] = useState("100");
  const [bindId, setBindId] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [meRes, ordersRes, txnsRes, devicesRes, entsRes] = await Promise.all([
        api<Me>("/v1/me", { token: props.token }),
        api<{ orders: Order[] }>("/v1/me/orders", { token: props.token }),
        api<{ transactions: Txn[] }>("/v1/me/transactions", { token: props.token }),
        api<{ devices: Device[] }>("/v1/me/devices", { token: props.token }),
        api<{ entitlements: Entitlement[] }>("/v1/me/entitlements", { token: props.token }),
      ]);
      setMe(meRes);
      setOrders(ordersRes.orders);
      setTxns(txnsRes.transactions);
      setDevices(devicesRes.devices);
      setEntitlements(entsRes.entitlements);
    } catch (err) {
      if (err instanceof ApiError && err.code === "UNAUTHORIZED") props.onExpired();
      else setError(err instanceof Error ? err.message : "加载失败");
    }
  }, [props]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const recharge = async (): Promise<void> => {
    setError("");
    setMessage("");
    const fen = Math.round(Number(rechargeYuan) * 100);
    if (!Number.isInteger(fen) || fen <= 0) {
      setError("请输入正确的充值金额");
      return;
    }
    try {
      const order = await api<Order>("/v1/orders", { method: "POST", body: { type: "recharge", amount_fen: fen }, token: props.token });
      await api(`/v1/orders/${order.order_id}/pay`, { method: "POST", body: { method: "mock" }, token: props.token });
      setMessage(`充值 ${yuan(fen)} 成功（模拟支付）`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "充值失败");
    }
  };

  const bind = async (): Promise<void> => {
    setError("");
    setMessage("");
    try {
      await api("/v1/me/devices/bind", { method: "POST", body: { device_id: bindId.trim() }, token: props.token });
      setMessage("设备绑定成功，已自动补发有效订阅授权");
      setBindId("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "绑定失败");
    }
  };

  if (!me) return <div className="page">{error ? <p className="error">{error}</p> : <p className="muted">加载中…</p>}</div>;

  return (
    <div className="page">
      <div className="grid cols-2">
        <div className="card">
          <h3>账户余额</h3>
          <div className="balance">{yuan(me.balance_fen)}</div>
          <p className="muted">{me.email}</p>
          <div className="row mt">
            <input
              style={{ width: 120, fontSize: 15, padding: "8px 12px", border: "1px solid #d2d2d7", borderRadius: 10 }}
              value={rechargeYuan}
              onChange={(e) => setRechargeYuan(e.target.value)}
            />
            <span className="muted">元</span>
            <button className="btn small" onClick={() => void recharge()}>
              模拟支付充值
            </button>
          </div>
        </div>
        <div className="card">
          <h3>绑定新设备</h3>
          <p>在龙枢工作台客户端里查看设备 ID（dev-…），绑定后授权自动下发。</p>
          <div className="row mt">
            <input
              style={{ flex: 1, fontSize: 15, padding: "8px 12px", border: "1px solid #d2d2d7", borderRadius: 10 }}
              placeholder="dev-xxxxxxxx"
              value={bindId}
              onChange={(e) => setBindId(e.target.value)}
            />
            <button className="btn small" disabled={!bindId.trim()} onClick={() => void bind()}>
              绑定
            </button>
          </div>
        </div>
      </div>
      {message && <p className="notice">{message}</p>}
      {error && <p className="error">{error}</p>}

      <div className="card mt">
        <h3>我的设备</h3>
        {devices.length === 0 ? (
          <p className="muted mt">暂无绑定设备</p>
        ) : (
          <table className="mt">
            <thead>
              <tr>
                <th>设备 ID</th>
                <th>平台</th>
                <th>版本</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.device_id}>
                  <td>{d.device_id}</td>
                  <td>{d.platform}</td>
                  <td>{d.app_version}</td>
                  <td>
                    <span className={`pill ${d.status}`}>{d.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card mt">
        <h3>我的订阅授权</h3>
        {entitlements.length === 0 ? (
          <p className="muted mt">暂无授权</p>
        ) : (
          <table className="mt">
            <thead>
              <tr>
                <th>套装</th>
                <th>设备</th>
                <th>状态</th>
                <th>到期时间</th>
              </tr>
            </thead>
            <tbody>
              {entitlements.map((e) => (
                <tr key={e.entitlement_id}>
                  <td>{e.pack_id}</td>
                  <td>{e.device_id}</td>
                  <td>
                    <span className={`pill ${e.status}`}>{e.status}</span>
                  </td>
                  <td>{new Date(e.expires_at).toLocaleDateString("zh-CN")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card mt">
        <h3>订单记录</h3>
        {orders.length === 0 ? (
          <p className="muted mt">暂无订单</p>
        ) : (
          <table className="mt">
            <thead>
              <tr>
                <th>订单号</th>
                <th>类型</th>
                <th>金额</th>
                <th>状态</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.order_id}>
                  <td>{o.order_id.slice(0, 12)}…</td>
                  <td>{o.type === "plan" ? `订阅 ${o.pack_id ?? ""} (${o.period ?? ""})` : "充值"}</td>
                  <td>{yuan(o.amount_fen)}</td>
                  <td>
                    <span className={`pill ${o.status}`}>{o.status}</span>
                  </td>
                  <td>{new Date(o.created_at).toLocaleString("zh-CN")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card mt">
        <h3>余额流水</h3>
        {txns.length === 0 ? (
          <p className="muted mt">暂无流水</p>
        ) : (
          <table className="mt">
            <thead>
              <tr>
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
                  <td>{t.type}</td>
                  <td>{t.amount_fen > 0 ? `+${yuan(t.amount_fen)}` : `-${yuan(-t.amount_fen)}`}</td>
                  <td>{yuan(t.balance_after_fen)}</td>
                  <td>{t.remark ?? "—"}</td>
                  <td>{new Date(t.created_at).toLocaleString("zh-CN")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
