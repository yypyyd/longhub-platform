/**
 * LongHub 公共门户。
 *
 * 这里是 LongHub 自己的产品面：免费原生 OpenClaw 管家、客户端下载、账号/设备
 * 配对状态和 Cloud Skill 订阅信息。Portal 不承载 OpenClaw Control UI，也不提供本地
 * 模型、Provider、Channels、插件、MCP 或第三方 Skill 的收费开关。
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  api,
  ApiError,
  yuan,
  type ClientRelease,
  type CloudCliRelease,
  type CloudSkillEntitlement,
  type CloudSkillOrder,
  type CloudSkillPlan,
  type CloudSkillSubscription,
  type Device,
  type Me,
  type PairDeviceResult,
} from "./api";

type View = "home" | "skills" | "download" | "login" | "register" | "account";
type BillingPeriod = "monthly" | "yearly";

const TOKEN_KEY = "longhub_portal_token";

function readToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function friendlyError(reason: unknown, fallback: string): string {
  if (!(reason instanceof ApiError)) return fallback;
  const messages: Record<string, string> = {
    BAD_CREDENTIALS: "邮箱或密码错误。",
    EMAIL_EXISTS: "这个邮箱已经注册，请直接登录。",
    INVALID_EMAIL: "请输入有效的邮箱地址。",
    INVALID_PASSWORD: "密码至少需要 8 位。",
    USER_DISABLED: "账号已被停用，请联系支持。",
    DEVICE_NOT_FOUND: "没有找到这个设备，请先运行 longhub-cloud pair。",
    PAIRING_CODE_REQUIRED: "请输入 longhub-cloud pair 显示的一次性配对码。",
    PAIRING_CODE_INVALID: "配对码格式无效，请重新运行 longhub-cloud pair。",
    PAIRING_CODE_EXPIRED: "配对码已过期，请重新运行 longhub-cloud pair。",
    PAIRING_CODE_USED: "配对码已经使用过，请重新运行 longhub-cloud pair。",
    PAIRING_UNAVAILABLE: "配对服务暂时不可用，请稍后重试。",
    DEVICE_REVOKED: "该设备凭据已撤销，请重新运行 longhub-cloud pair。",
    CLOUD_SKILL_DEVICE_REQUIRED: "请先绑定一个 LongHub 设备，再订阅云端 Skill。",
    CLOUD_SKILL_PLAN_NOT_FOUND: "该云端 Skill 方案已下架，请刷新目录。",
    CLOUD_SKILL_SUBSCRIPTION_NOT_FOUND: "订阅不存在或已被移除。",
    CLOUD_SKILL_SUBSCRIPTION_NOT_ACTIVE: "只有有效订阅可以取消。",
    NETWORK_UNAVAILABLE: "网络暂时不可用，请稍后重试。",
    NOT_FOUND: "服务正在升级，请稍后重试。",
  };
  return messages[reason.code] ?? fallback;
}

function formatDate(value: string | undefined, withTime = false): string {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return withTime ? date.toLocaleString("zh-CN") : date.toLocaleDateString("zh-CN");
}

function periodLabel(period: BillingPeriod): string {
  return period === "monthly" ? "月度" : "年度";
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    active: "有效",
    cancelled: "已取消",
    expired: "已到期",
    refunded: "已退款",
    suspended: "已暂停",
    revoked: "已撤回",
    pending: "待处理",
    paid: "已支付",
  };
  return labels[status] ?? "状态未知";
}

function statusClass(status: string): string {
  return /^[a-z]+$/.test(status) ? status : "unknown";
}

function platformLabel(platform: string): string {
  if (platform === "windows") return "LongHub Manager (Windows)";
  if (platform === "openclaw-plugin-windows") return "OpenClaw Cloud Plugin (Windows)";
  return platform;
}

/**
 * 只有经过当前产品发布门禁、明确标记为 Manager 的制品才可以从公开
 * Portal 下载。即使服务端误返回其它产品，也在界面层 fail closed。
 */
function isLongHubManagerRelease(release: ClientRelease | null | undefined): boolean {
  return release?.manifest.product_surface === "longhub-manager";
}

export function App(): JSX.Element {
  const [view, setView] = useState<View>("home");
  const [token, setToken] = useState<string | null>(() => readToken());

  const onLogin = (nextToken: string): void => {
    try {
      window.localStorage.setItem(TOKEN_KEY, nextToken);
    } catch {
      // The in-memory token still lets the current tab work if storage is blocked.
    }
    setToken(nextToken);
    setView("account");
  };

  const onLogout = useCallback((): void => {
    if (token) void api("/v1/auth/logout", { method: "POST", body: {}, token }).catch(() => undefined);
    try {
      window.localStorage.removeItem(TOKEN_KEY);
    } catch {
      // Ignore storage errors; the in-memory session is still cleared.
    }
    setToken(null);
    setView("home");
  }, [token]);

  return (
    <>
      <nav className="nav" aria-label="LongHub 主导航">
        <button className="brand" type="button" onClick={() => setView("home")} aria-label="返回 LongHub 首页">
          <img src="/longhub-avatar.png" alt="" />
          <span>龙枢 LongHub</span>
        </button>
        <button className="link" type="button" onClick={() => setView("skills")}>云端 Skill</button>
        <button className="link" type="button" onClick={() => setView("download")}>下载管家</button>
        <span className="spacer" />
        {token ? (
          <>
            <button className="link" type="button" onClick={() => setView("account")}>我的账号</button>
            <button className="link" type="button" onClick={onLogout}>退出</button>
          </>
        ) : (
          <>
            <button className="link" type="button" onClick={() => setView("login")}>登录</button>
            <button className="link" type="button" onClick={() => setView("register")}>注册</button>
          </>
        )}
      </nav>

      {view === "home" && <Home goSkills={() => setView("skills")} goDownload={() => setView("download")} />}
      {view === "skills" && <CloudSkills token={token} goAccount={() => setView("account")} />}
      {view === "download" && <Download />}
      {view === "login" && <Auth mode="login" onDone={onLogin} switchMode={() => setView("register")} />}
      {view === "register" && <Auth mode="register" onDone={onLogin} switchMode={() => setView("login")} />}
      {view === "account" && token ? <Account token={token} onExpired={onLogout} /> : null}
      {view === "account" && !token ? <AccountLogin goLogin={() => setView("login")} /> : null}

      <div className="footer">© {new Date().getFullYear()} 龙枢 LongHub · 免费原生 OpenClaw 管家 · 云端 Skill 订阅</div>
    </>
  );
}

function Home(props: { goSkills: () => void; goDownload: () => void }): JSX.Element {
  return (
    <>
      <div className="hero">
        <p className="eyebrow">免费原生 OpenClaw 管家</p>
        <h1>
          帮你安装和管理 OpenClaw
          <br />
          需要时再连接 LongHub 云端 Skill
        </h1>
        <p className="sub">
          LongHub 不替换 OpenClaw、不嵌入它的控制页面，也不限制你自己的模型、插件、MCP 和第三方 Skill。
          本地管家永久免费，商业能力只通过可取消的云端 Skill 订阅提供。
        </p>
        <div className="cta">
          <button className="btn" type="button" onClick={props.goDownload}>免费下载管家</button>
          <button className="btn ghost" type="button" onClick={props.goSkills}>查看云端 Skill</button>
        </div>
      </div>
      <div className="page">
        <div className="grid cols-3">
          <div className="card">
            <h3>原生安装</h3>
            <p>按 OpenClaw 官方方式安装在你的系统环境中，LongHub 只负责检测、启动、备份和诊断。</p>
          </div>
          <div className="card">
            <h3>本地能力不设门槛</h3>
            <p>模型、Provider、Channels、Agent、插件、MCP 和第三方 Skill 不因 LongHub 账号或订阅被锁定。</p>
          </div>
          <div className="card">
            <h3>云端实现留在云端</h3>
            <p>客户端只安装签名薄适配器；云端 Skill 的实现、凭据和内部路由不会下发到用户电脑。</p>
          </div>
        </div>
      </div>
    </>
  );
}

function Download(): JSX.Element {
  const [release, setRelease] = useState<ClientRelease | null | undefined>();
  const [cliRelease, setCliRelease] = useState<CloudCliRelease | null | undefined>();
  const [error, setError] = useState("");

  useEffect(() => {
    void api<{ release: ClientRelease | null }>("/v1/client-releases/latest")
      .then((result) => setRelease(result.release))
      .catch((reason) => {
        setRelease(null);
        setError(friendlyError(reason, "暂时无法获取安装包信息。"));
      });
    void api<{ release: CloudCliRelease | null }>("/v1/cloud-cli-releases/latest?channel=stable")
      .then((result) => setCliRelease(result.release))
      .catch(() => setCliRelease(null));
  }, []);

  const isManagerRelease = isLongHubManagerRelease(release);
  const isPublicRelease = isManagerRelease && release?.manifest.rollout.status === "active" && release.manifest.rollout.basis_points === 10_000;
  const isPublicCliRelease = cliRelease?.product_surface === "longhub-cloud-cli" &&
    cliRelease.rollout.status === "active" && cliRelease.rollout.basis_points === 10_000;

  return (
    <div className="page">
      <div className="page-heading">
        <p className="eyebrow">免费客户端</p>
        <h2 className="section">下载 LongHub 管家</h2>
        <p className="muted">不登录也可以下载、安装和使用本地管家。账号只在使用 LongHub 云端 Skill 时需要。</p>
      </div>
      <div className="grid cols-2">
        <div className="card">
          <h3>Windows 10/11（64 位）</h3>
          <p>管家会发现你系统里的原生 Node/OpenClaw，并提供安装、Gateway 健康、备份恢复和诊断入口。</p>
          {isPublicRelease && release ? (
            <p className="mt">
              <a className="btn" href={release.manifest.url_path} download>
                下载 v{release.manifest.version}（{(release.manifest.size / 1024 / 1024).toFixed(0)} MB）
              </a>
            </p>
          ) : release && !isManagerRelease ? (
            <div className="notice mt" role="status">
              当前版本尚未通过“LongHub Manager”制品校验，公开下载已暂时关闭。请等待新的免费管家安装包发布。
            </div>
          ) : release?.manifest.rollout.status === "active" ? (
            <p className="mt muted">v{release.manifest.version} 正在灰度发布，公开下载暂未开放。</p>
          ) : (
            <p className="mt muted">
              {release === undefined ? "正在获取最新版本…" : release?.manifest.rollout.status === "paused" ? `v${release.manifest.version} 暂停发布。` : "安装包正在准备中。"}
            </p>
          )}
          {error && <p className="error" role="alert">{error}</p>}
        </div>
        <div className="card">
          <h3>安装后怎么用</h3>
          <ol className="steps">
            <li>打开管家，检测或按官方方式安装系统原生 OpenClaw。</li>
            <li>在 LongHub 自有页面管理 Gateway、备份、修复和更新。</li>
            <li>需要 LongHub 云端 Skill 时，安装独立 CLI，运行 <code>longhub-cloud pair</code> 生成短时配对码，再由 Portal 完成账号绑定。</li>
          </ol>
          <p className="muted mt">LongHub 不会把 OpenClaw 复制到私有目录，也不会删除你的工作区、会话或第三方 Skill。</p>
        </div>
      </div>
      <div className="card mt">
        <h3>LongHub Cloud CLI（独立可选）</h3>
        <p>Cloud Skill 的设备配对和插件安装由独立的 <code>longhub-cloud</code> CLI 完成，不包含在免费 Manager 安装包中。</p>
        {isPublicCliRelease && cliRelease ? (
          <>
            <p className="mt"><a className="btn" href={cliRelease.url_path} download>下载 CLI v{cliRelease.version}</a></p>
            <p className="muted mt">SHA-256：<code>{cliRelease.sha256}</code><br />签名 key：<code>{cliRelease.signature_key_id}</code></p>
          </>
        ) : (
          <p className="muted mt">{cliRelease === undefined ? "正在获取 CLI 版本…" : "签名 CLI 候选尚未开放。"}</p>
        )}
      </div>
    </div>
  );
}

function CloudSkills(props: { token: string | null; goAccount: () => void }): JSX.Element {
  const [plans, setPlans] = useState<CloudSkillPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    setUnavailable(false);
    setError("");
    void api<{ plans: CloudSkillPlan[] }>("/v1/cloud-skill-plans")
      .then((result) => setPlans(result.plans.filter((plan) => plan.status === "listed")))
      .catch((reason) => {
        setPlans([]);
        if (reason instanceof ApiError && (reason.code === "NOT_FOUND" || reason.code === "ROUTE_NOT_FOUND")) {
          setUnavailable(true);
        } else {
          setError(friendlyError(reason, "云端目录暂时不可用，请稍后重试。"));
        }
      })
      .finally(() => setLoading(false));
  }, []);

  const showPaymentUnavailable = (): void => {
    setMessage("");
    setError("");
    // 支付渠道接入前保持 fail-closed：这里只展示明确状态，不创建订单或模拟结算。
    setMessage("支付通道尚未开通，当前只展示方案摘要，不会创建订单或扣款。正式开通后会在账号页完成订阅。");
  };

  return (
    <div className="page">
      <div className="page-heading">
        <p className="eyebrow">LongHub Cloud Skills</p>
        <h2 className="section">云端 Skill 目录</h2>
        <p className="muted">目录先展示已上架方案的公开摘要（包含 Skill、周期额度、速率、并发和价格）；本地 OpenClaw 不受订阅影响。完整输入、权限和数据处理说明会在正式开通前补齐。</p>
      </div>
      {loading && <p className="muted" aria-live="polite">正在加载云端目录…</p>}
      {unavailable && (
        <div className="card notice">
          <h3>云端 Skill 服务正在升级</h3>
          <p>免费客户端和本地 OpenClaw 管理不受影响。Cloud API 完成订阅路由部署后，这里会自动显示可订阅方案。</p>
        </div>
      )}
      {!loading && !unavailable && plans.length === 0 && <div className="card"><p className="muted">暂时没有上架的云端 Skill 方案。</p></div>}
      <div className="grid cols-2">
        {plans.map((plan) => (
          <div className="card price-card" key={plan.plan_id}>
            <p className="eyebrow">云端订阅方案</p>
            <h3>{plan.name}</h3>
            <p>{plan.description || "按订阅授权使用 LongHub 云端 Skill。"}</p>
            <div className="price">{yuan(plan.price_monthly_fen)}</div>
            <div className="per">每月 · 或按年 {yuan(plan.price_yearly_fen)}</div>
            <ul className="skill-facts">
              <li>包含 Skill：{plan.skill_ids.join("、") || "以目录为准"}</li>
              <li>周期额度：{plan.included_calls.toLocaleString("zh-CN")} 次</li>
              <li>速率上限：{plan.requests_per_minute}/分钟 · 并发 {plan.max_concurrency}</li>
            </ul>
            <div className="row" style={{ justifyContent: "center" }}>
              <button className="btn" type="button" onClick={showPaymentUnavailable}>月度方案（未开通）</button>
              <button className="btn ghost" type="button" onClick={showPaymentUnavailable}>年度方案（未开通）</button>
            </div>
            <p className="muted mt">支付通道尚未开通；本页面不会产生扣款或订单。</p>
          </div>
        ))}
      </div>
      {message && (
        <p className="notice" role="status">
          {message} {props.token && <button className="text-link" type="button" onClick={props.goAccount}>查看账号</button>}
        </p>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

function Auth(props: { mode: "login" | "register"; onDone: (token: string) => void; switchMode: () => void }): JSX.Element {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const isLogin = props.mode === "login";

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const path = isLogin ? "/v1/auth/login" : "/v1/auth/register";
      const result = await api<{ token: string }>(path, {
        method: "POST",
        body: { email: email.trim(), password },
      });
      props.onDone(result.token);
    } catch (reason) {
      setError(friendlyError(reason, isLogin ? "登录失败，请稍后重试。" : "注册失败，请稍后重试。"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <form className="form card" onSubmit={(event) => void submit(event)}>
        <h2>{isLogin ? "登录 LongHub" : "创建 LongHub 账号"}</h2>
        <p className="muted">账号只用于云端 Skill、设备配对和订阅管理；本地 OpenClaw 不依赖登录。</p>
        <label htmlFor="portal-email">邮箱</label>
        <input id="portal-email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" />
        <label htmlFor="portal-password">密码{isLogin ? "" : "（至少 8 位）"}</label>
        <input id="portal-password" type="password" autoComplete={isLogin ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="••••••••" />
        <button className="btn" type="submit" disabled={busy || !email.trim() || !password}>{busy ? "处理中…" : isLogin ? "登录" : "注册"}</button>
        {error && <p className="error" role="alert">{error}</p>}
        <p className="alt">{isLogin ? "还没有账号？" : "已有账号？"}<button className="text-link" type="button" onClick={props.switchMode}>{isLogin ? "立即注册" : "去登录"}</button></p>
      </form>
    </div>
  );
}

function AccountLogin(props: { goLogin: () => void }): JSX.Element {
  return (
    <div className="page">
      <div className="card account-login">
        <h2>登录后管理云端 Skill</h2>
        <p className="muted">本地 OpenClaw 无需账号；登录只用于查看订阅、权益和已绑定设备。</p>
        <button className="btn mt" type="button" onClick={props.goLogin}>去登录</button>
      </div>
    </div>
  );
}

function Account(props: { token: string; onExpired: () => void }): JSX.Element {
  const { token, onExpired } = props;
  const [me, setMe] = useState<Me | null>(null);
  const [orders, setOrders] = useState<CloudSkillOrder[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [subscriptions, setSubscriptions] = useState<CloudSkillSubscription[]>([]);
  const [entitlements, setEntitlements] = useState<CloudSkillEntitlement[]>([]);
  const [busySubscription, setBusySubscription] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async (): Promise<void> => {
    setError("");
    const results = await Promise.allSettled([
      api<Me>("/v1/me", { token }),
      api<{ orders: CloudSkillOrder[] }>("/v1/me/orders", { token }),
      api<{ devices: Device[] }>("/v1/me/devices", { token }),
      api<{ subscriptions: CloudSkillSubscription[] }>("/v1/me/cloud-skill-subscriptions", { token }),
      api<{ entitlements: CloudSkillEntitlement[] }>("/v1/me/cloud-skill-entitlements", { token }),
    ]);

    const isUnauthorized = (reason: unknown): boolean =>
      reason instanceof ApiError && (reason.status === 401 || reason.code === "UNAUTHORIZED");
    const authFailure = results.find((result) => result.status === "rejected" && isUnauthorized(result.reason));
    if (authFailure?.status === "rejected") {
      setLoading(false);
      onExpired();
      return;
    }

    const meResult = results[0];
    if (meResult?.status !== "fulfilled") {
      setMe(null);
      setError(friendlyError(meResult?.reason, "账号信息暂时无法加载，请稍后重试。"));
      setLoading(false);
      return;
    }
    setMe(meResult.value);

    const ordersResult = results[1];
    const devicesResult = results[2];
    const subscriptionsResult = results[3];
    const entitlementsResult = results[4];
    // Optional account modules degrade independently during a rolling deploy;
    // a missing subscription route must not hide the user's device information.
    setOrders(ordersResult?.status === "fulfilled" ? ordersResult.value.orders.filter((order) => order.type === "cloud_skill_plan") : []);
    setDevices(devicesResult?.status === "fulfilled" ? devicesResult.value.devices : []);
    setSubscriptions(subscriptionsResult?.status === "fulfilled" ? subscriptionsResult.value.subscriptions : []);
    setEntitlements(entitlementsResult?.status === "fulfilled" ? entitlementsResult.value.entitlements : []);
    if ([ordersResult, devicesResult, subscriptionsResult, entitlementsResult].some((result) => result?.status === "rejected")) {
      setError("账号基础信息已加载，但部分云端订阅数据暂时不可用；请稍后刷新。");
    }
    setLoading(false);
  }, [onExpired, token]);

  useEffect(() => { void refresh(); }, [refresh]);

  const cancel = async (subscription: CloudSkillSubscription): Promise<void> => {
    if (!window.confirm("确认取消该云端 Skill 订阅？取消不会影响本地 OpenClaw。")) return;
    setError("");
    setMessage("");
    setBusySubscription(subscription.subscription_id);
    try {
      await api(`/v1/me/cloud-skill-subscriptions/${subscription.subscription_id}/cancel`, {
        method: "POST",
        body: {},
        token,
      });
      setMessage("订阅已取消，本地 OpenClaw 仍可继续使用。");
      await refresh();
    } catch (reason) {
      if (reason instanceof ApiError && (reason.status === 401 || reason.code === "UNAUTHORIZED")) onExpired();
      else setError(friendlyError(reason, "取消订阅失败，请稍后重试。"));
    } finally {
      setBusySubscription(null);
    }
  };

  if (loading && !me) return <div className="page"><p className="muted">正在加载账号信息…</p></div>;
  if (!me) return <div className="page"><p className="error" role="alert">{error || "账号信息暂时无法加载。"}</p></div>;

  return (
    <div className="page">
      <div className="page-heading">
        <p className="eyebrow">LongHub Account</p>
        <h2 className="section">我的云端 Skill</h2>
        <p className="muted">{me.email} · 账号只管理云端订阅和设备，不控制本地 OpenClaw。</p>
      </div>
      {message && <p className="notice" role="status">{message}</p>}
      {error && <p className="error" role="alert">{error}</p>}

      <DevicePairing token={token} onExpired={onExpired} onPaired={refresh} />

      <div className="card mt">
        <h3>我的设备</h3>
        {devices.length === 0 ? <p className="muted mt">暂无绑定设备</p> : (
          <div className="table-scroll mt">
            <table><thead><tr><th>设备 ID</th><th>平台</th><th>版本</th><th>状态</th></tr></thead>
              <tbody>{devices.map((device) => <tr key={device.device_id}><td>{device.device_id}</td><td>{platformLabel(device.platform)}</td><td>{device.app_version}</td><td><span className={`pill ${statusClass(device.status)}`}>{statusLabel(device.status)}</span></td></tr>)}</tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card mt">
        <h3>云端订阅</h3>
        {subscriptions.length === 0 ? <p className="muted mt">暂无云端 Skill 订阅</p> : (
          <div className="table-scroll mt">
            <table><thead><tr><th>方案</th><th>周期</th><th>状态</th><th>到期</th><th>操作</th></tr></thead>
              <tbody>{subscriptions.map((subscription) => <tr key={subscription.subscription_id}>
                <td>{subscription.plan_id}</td>
                <td>{periodLabel(subscription.period)}</td>
                <td><span className={`pill ${statusClass(subscription.status)}`}>{statusLabel(subscription.status)}</span></td>
                <td>{formatDate(subscription.expires_at)}</td>
                <td>{subscription.status === "active" && <button className="btn danger small" type="button" disabled={busySubscription === subscription.subscription_id} onClick={() => void cancel(subscription)}>{busySubscription === subscription.subscription_id ? "处理中…" : "取消订阅"}</button>}</td>
              </tr>)}</tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card mt">
        <h3>Skill 权益</h3>
        {entitlements.length === 0 ? <p className="muted mt">暂无可用 Skill 权益</p> : (
          <div className="table-scroll mt">
            <table><thead><tr><th>Skill</th><th>方案</th><th>状态</th><th>到期</th></tr></thead>
              <tbody>{entitlements.map((entitlement) => <tr key={entitlement.entitlement_id}><td>{entitlement.skill_id}</td><td>{entitlement.plan_id}</td><td><span className={`pill ${statusClass(entitlement.status)}`}>{statusLabel(entitlement.status)}</span></td><td>{formatDate(entitlement.expires_at)}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card mt">
        <h3>订阅订单记录</h3>
        {orders.length === 0 ? <p className="muted mt">暂无云端订阅订单</p> : (
          <div className="table-scroll mt">
            <table><thead><tr><th>订单号</th><th>方案</th><th>周期</th><th>金额</th><th>状态</th><th>时间</th></tr></thead>
              <tbody>{orders.map((order) => <tr key={order.order_id}><td>{order.order_id.slice(0, 14)}…</td><td>{order.plan_id}</td><td>{periodLabel(order.period)}</td><td>{yuan(order.amount_fen)}</td><td><span className={`pill ${statusClass(order.status)}`}>{statusLabel(order.status)}</span></td><td>{formatDate(order.created_at, true)}</td></tr>)}</tbody>
            </table>
          </div>
        )}
        <p className="muted mt">支付通道接入前，Portal 不会创建模拟订单或扣款。</p>
      </div>
    </div>
  );
}

/**
 * Device ownership is proved by a short-lived code displayed by longhub-cloud.
 * The Portal deliberately never accepts a device UUID or a device
 * bearer token as a binding input.
 */
function DevicePairing(props: { token: string; onExpired: () => void; onPaired: () => Promise<void> }): JSX.Element {
  const [pairingCode, setPairingCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const normalizedCode = pairingCode.toUpperCase().replace(/[\s-]/gu, "");
  const validCode = /^[A-HJ-NP-Z2-9]{12}$/u.test(normalizedCode);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!validCode || busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api<PairDeviceResult>("/v1/me/devices/pair", {
        method: "POST",
        body: { pairing_code: normalizedCode },
        token: props.token,
      });
      setPairingCode("");
      setMessage("设备已安全配对到当前账号。现在可以运行 longhub-cloud install 安装 Cloud Plugin。");
      await props.onPaired();
    } catch (reason) {
      if (reason instanceof ApiError && (reason.status === 401 || reason.code === "UNAUTHORIZED")) {
        props.onExpired();
      } else {
        setError(friendlyError(reason, "设备配对失败，请检查配对码后重试。"));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h3>设备配对</h3>
      <p className="muted">在 Windows 终端运行 <code>longhub-cloud pair</code>，把输出的一次性配对码填到这里。配对码为 12 位短码，10 分钟内有效且只能使用一次。</p>
      <form className="pairing-form mt" onSubmit={(event) => void submit(event)}>
        <label htmlFor="portal-pairing-code">一次性配对码</label>
        <div className="row">
          <input
            id="portal-pairing-code"
            className="pairing-input"
            value={pairingCode}
            onChange={(event) => setPairingCode(event.target.value)}
            placeholder="例如 ABCD-2345-EFGH"
            autoComplete="one-time-code"
            spellCheck={false}
            maxLength={14}
            aria-describedby="portal-pairing-help"
          />
          <button className="btn" type="submit" disabled={busy || !validCode}>
            {busy ? "配对中…" : "完成配对"}
          </button>
        </div>
        <p id="portal-pairing-help" className="muted pairing-help">不接受设备 ID、设备 Token 或其他长期凭据。</p>
        {message && <p className="notice" role="status">{message}</p>}
        {error && <p className="error" role="alert">{error}</p>}
      </form>
    </div>
  );
}
