/** 龙枢管理后台：免费管家运营与云端 Skill 服务。 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  ApiError,
  uploadCloudArtifactRelease,
  uploadManagerRelease,
  yuan,
  type AdminAudit,
  type AdminCloudSkillAdapterRelease,
  type AdminCloudSkillPlan,
  type AdminCloudSkillSubscription,
  type AdminDevice,
  type AdminModelConfig,
  type AdminOrder,
  type AdminUser,
  type CloudArtifactRelease,
  type CloudArtifactSurface,
  type ManagerRelease,
  type Metrics,
} from "./api";
import {
  cloudSkillOrderStatusLabel,
  cloudSkillSubscriptionStatusLabel,
  isValidCloudSkillId,
  isValidCloudSkillPlanId,
  isValidPositiveInteger,
  isValidYuanAmount,
  normalizeSkillIds,
} from "./cloud-skill-model";
import { managerInstallerFilename, isValidManagerVersion } from "./manager-release-model";

type Tab =
  | "dashboard"
  | "users"
  | "devices"
  | "cloud-plans"
  | "cloud-adapters"
  | "cloud-subscriptions"
  | "cloud-orders"
  | "manager-releases"
  | "cloud-artifacts"
  | "model"
  | "audits";

const NAV_GROUPS: { label: string; tabs: { key: Tab; label: string }[] }[] = [
  { label: "总览", tabs: [{ key: "dashboard", label: "运营看板" }] },
  {
    label: "用户与设备",
    tabs: [
      { key: "users", label: "用户" },
      { key: "devices", label: "设备" },
    ],
  },
  {
    label: "云端 Skill",
    tabs: [
      { key: "cloud-plans", label: "订阅方案" },
      { key: "cloud-adapters", label: "薄适配器发布" },
      { key: "cloud-subscriptions", label: "订阅与权益" },
      { key: "cloud-orders", label: "订阅订单" },
    ],
  },
  {
    label: "云端运维",
    tabs: [{ key: "model", label: "云端模型路由" }],
  },
  {
    label: "发布",
    tabs: [
      { key: "manager-releases", label: "Manager 版本" },
      { key: "cloud-artifacts", label: "Cloud Plugin / CLI" },
    ],
  },
  { label: "系统", tabs: [{ key: "audits", label: "审计日志" }] },
];

const TOKEN_KEY = "longhub_admin_token";
const WHO_KEY = "longhub_admin_who";

function percentage(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function latencyLabel(bucket: string): string {
  return (
    {
      lt_1s: "< 1 秒",
      "1_to_3s": "1–3 秒",
      "3_to_10s": "3–10 秒",
      "10_to_30s": "10–30 秒",
      gte_30s: "≥ 30 秒",
    } as Record<string, string>
  )[bucket] ?? bucket;
}

export function App(): JSX.Element {
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem(TOKEN_KEY));
  const [who, setWho] = useState<string>(() => sessionStorage.getItem(WHO_KEY) ?? "");
  const [tab, setTab] = useState<Tab>("dashboard");

  const onLogout = (): void => {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(WHO_KEY);
    setToken(null);
  };

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [tab]);

  if (!token) {
    return (
      <Login
        onDone={(nextToken, name) => {
          sessionStorage.setItem(TOKEN_KEY, nextToken);
          sessionStorage.setItem(WHO_KEY, name);
          setWho(name);
          setToken(nextToken);
        }}
      />
    );
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <img src="/longhub-avatar.png" alt="" />
          <span>
            <strong>龙枢</strong>
            <small>云端 Skill 运营后台</small>
          </span>
        </div>
        <nav className="sidebar-nav" aria-label="后台导航">
          {NAV_GROUPS.map((group) => (
            <div className="nav-group" key={group.label}>
              <div className="nav-label">{group.label}</div>
              {group.tabs.map((item) => (
                <button
                  key={item.key}
                  className={tab === item.key ? "active" : ""}
                  onClick={() => setTab(item.key)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="who">
            <span className="status-dot active" />
            {who}
          </div>
          <button onClick={onLogout}>退出登录</button>
        </div>
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
      const result = await api<{ token: string; admin: { username: string; role: string } }>(
        "/v1/admin/auth/login",
        { method: "POST", body: { username, password } },
      );
      props.onDone(result.token, `${result.admin.username} · ${result.admin.role}`);
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
        <h1>龙枢运营后台</h1>
        <p className="muted login-intro">管理免费的 LongHub Manager 和 LongHub 云端 Skill。</p>
        <label htmlFor="admin-username">用户名</label>
        <input id="admin-username" value={username} onChange={(event) => setUsername(event.target.value)} />
        <label htmlFor="admin-password">密码</label>
        <input
          id="admin-password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && username && password && !busy) void submit();
          }}
        />
        <button className="btn" disabled={busy || !username || !password} onClick={() => void submit()}>
          {busy ? "登录中…" : "登录"}
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
  const [cloudPlans, setCloudPlans] = useState<AdminCloudSkillPlan[]>([]);
  const [cloudAdapters, setCloudAdapters] = useState<AdminCloudSkillAdapterRelease[]>([]);
  const [cloudSubscriptions, setCloudSubscriptions] = useState<AdminCloudSkillSubscription[]>([]);
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [managerReleases, setManagerReleases] = useState<ManagerRelease[]>([]);
  const [pluginReleases, setPluginReleases] = useState<CloudArtifactRelease[]>([]);
  const [cliReleases, setCliReleases] = useState<CloudArtifactRelease[]>([]);
  const [audits, setAudits] = useState<AdminAudit[]>([]);
  const [modelConfig, setModelConfig] = useState<AdminModelConfig | null>(null);

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
      if (tab === "cloud-plans") {
        setCloudPlans((await api<{ plans: AdminCloudSkillPlan[] }>("/v1/admin/cloud-skill-plans", { token })).plans);
      }
      if (tab === "cloud-adapters") {
        setCloudAdapters(
          (await api<{ releases: AdminCloudSkillAdapterRelease[] }>("/v1/admin/cloud-skill-adapters", { token })).releases,
        );
      }
      if (tab === "cloud-subscriptions") {
        setCloudSubscriptions(
          (await api<{ subscriptions: AdminCloudSkillSubscription[] }>("/v1/admin/cloud-skill-subscriptions", { token }))
            .subscriptions,
        );
      }
      if (tab === "cloud-orders") {
        const result = await api<{ orders: AdminOrder[] }>("/v1/admin/orders", { token });
        setOrders(result.orders.filter((order) => order.type === "cloud_skill_plan"));
      }
      if (tab === "manager-releases") {
        setManagerReleases((await api<{ releases: ManagerRelease[] }>("/v1/admin/client-releases", { token })).releases);
      }
      if (tab === "cloud-artifacts") {
        const [plugins, cli] = await Promise.all([
          api<{ releases: CloudArtifactRelease[] }>("/v1/admin/cloud-plugin-releases", { token }),
          api<{ releases: CloudArtifactRelease[] }>("/v1/admin/cloud-cli-releases", { token }),
        ]);
        setPluginReleases(plugins.releases);
        setCliReleases(cli.releases);
      }
      if (tab === "model") setModelConfig(await api<AdminModelConfig>("/v1/admin/model-config", { token }));
      if (tab === "audits") setAudits((await api<{ audits: AdminAudit[] }>("/v1/admin/audits", { token })).audits);
    } catch (err) {
      guard(err);
    }
  }, [guard, tab, token]);

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
      {tab === "dashboard" && <Dashboard metrics={metrics} />}
      {tab === "users" && (
        <Users users={users} onStatusChange={(user) => void act(
          () => api(`/v1/admin/users/${encodeURIComponent(user.user_id)}/status`, {
            method: "POST",
            body: { status: user.status === "active" ? "disabled" : "active" },
            token,
          }),
          "用户状态已更新",
        )} />
      )}
      {tab === "devices" && (
        <Devices
          devices={devices}
          onStatusChange={(device) => void act(
            () => api(`/v1/admin/devices/${encodeURIComponent(device.device_id)}`, {
              method: "POST",
              body: { status: device.status === "active" ? "revoked" : "active" },
              token,
            }),
            device.status === "active" ? "设备已停用" : "设备已启用",
          )}
          onRotate={async (device) => {
            try {
              const result = await api<{ device_token: string }>(
                `/v1/admin/devices/${encodeURIComponent(device.device_id)}/rotate-credential`,
                { method: "POST", body: {}, token },
              );
              setNotice(`新设备凭据（仅本次显示）：${result.device_token}`);
              await refresh();
            } catch (err) {
              guard(err);
            }
          }}
        />
      )}
      {tab === "cloud-plans" && (
        <CloudSkillPlans
          plans={cloudPlans}
          onCreate={(body) => void act(
            () => api("/v1/admin/cloud-skill-plans", { method: "POST", body, token }),
            "云端 Skill 订阅方案已创建",
          )}
          onUpdate={(planId, body) => void act(
            () => api(`/v1/admin/cloud-skill-plans/${encodeURIComponent(planId)}`, { method: "POST", body, token }),
            "云端 Skill 订阅方案已更新",
          )}
        />
      )}
      {tab === "cloud-adapters" && (
        <CloudSkillAdapters
          releases={cloudAdapters}
          onPublish={(body) => act(
            () => api("/v1/admin/cloud-skill-adapters", { method: "POST", body, token }),
            "云端 Skill 薄适配器已发布",
          )}
          onRevoke={(release) => act(
            () => api(
              `/v1/admin/cloud-skill-adapters/${encodeURIComponent(release.skill_id)}/${encodeURIComponent(release.version)}/revoke`,
              { method: "POST", body: {}, token },
            ),
            `${release.skill_id}@${release.version} 已撤回`,
          )}
        />
      )}
      {tab === "cloud-subscriptions" && <CloudSkillSubscriptions subscriptions={cloudSubscriptions} />}
      {tab === "cloud-orders" && <CloudSkillOrders orders={orders} />}
      {tab === "manager-releases" && (
        <ManagerReleases
          releases={managerReleases}
          onUpload={(version, file) => act(
            () => uploadManagerRelease(token, version, file),
            "Manager 安装包已上传并保持暂停；请验证后再开启灰度",
          )}
          onRollout={(release, basisPoints) => void act(
            () => api(`/v1/admin/client-releases/${encodeURIComponent(release.manifest.version)}/rollout`, {
              method: "PATCH",
              body: { status: "active", basis_points: basisPoints },
              token,
            }),
            `Manager ${release.manifest.version} 灰度已调整为 ${basisPoints / 100}%`,
          )}
          onPause={(release) => void act(
            () => api(`/v1/admin/client-releases/${encodeURIComponent(release.manifest.version)}/rollout`, {
              method: "PATCH",
              body: { status: "paused", basis_points: release.manifest.rollout.basis_points },
              token,
            }),
            `Manager ${release.manifest.version} 已暂停`,
          )}
        />
      )}
      {tab === "cloud-artifacts" && (
        <CloudArtifactReleases
          pluginReleases={pluginReleases}
          cliReleases={cliReleases}
          onUpload={(surface, version, file) => act(
            () => uploadCloudArtifactRelease(token, surface, version, file),
            `${surface === "cloud-plugin" ? "Cloud Plugin" : "Cloud CLI"} 制品已上传并保持暂停`,
          )}
          onRollout={(surface, release, status, basisPoints) => void act(
            () => api(
              `/v1/admin/${surface}-releases/${encodeURIComponent(release.manifest.version)}/rollout`,
              { method: "PATCH", body: { status, basis_points: basisPoints }, token },
            ),
            `${release.manifest.product_surface} ${status === "paused" ? "已暂停" : "灰度已更新"}`,
          )}
          onWithdraw={(surface, release) => void act(
            () => api(`/v1/admin/${surface}-releases/${encodeURIComponent(release.manifest.version)}`, {
              method: "DELETE",
              token,
            }),
            `${release.manifest.product_surface}@${release.manifest.version} 已撤回`,
          )}
        />
      )}
      {tab === "model" && (
        <>
          <h2>云端模型路由</h2>
          <p className="muted page-intro">
            仅用于 LongHub Cloud Executor 的内部路由和额度控制；不会覆盖或限制用户系统中的原生 OpenClaw。
          </p>
          {modelConfig && (
            <ModelConfigForm
              config={modelConfig}
              onSave={(body) => void act(
                () => api("/v1/admin/model-config", { method: "POST", body, token }),
                "云端模型路由已保存",
              )}
              onTest={() => void act(
                () => api("/v1/admin/model-config/test", { method: "POST", body: {}, token }),
                "上游模型连接正常",
              )}
            />
          )}
        </>
      )}
      {tab === "audits" && <Audits audits={audits} />}
      {notice && <p className="notice">{notice}</p>}
      {error && <p className="error">{error}</p>}
    </>
  );
}

function Dashboard(props: { metrics: Metrics | null }): JSX.Element {
  const metrics = props.metrics;
  return (
    <>
      <h2>运营看板</h2>
      {!metrics ? (
        <div className="card empty-cell">正在加载运行数据…</div>
      ) : (
        <>
          <div className="stats">
            <Stat value={metrics.users_total} label="注册用户" />
            <Stat value={metrics.devices_total} label="已绑定设备" />
            <Stat value={metrics.operations.client_starts} label="24 小时 Manager 启动" />
            <Stat value={percentage(metrics.operations.crash_rate)} label="异常退出率" />
            <Stat value={percentage(metrics.operations.model_success_rate)} label="云端模型成功率" />
            <Stat value={percentage(metrics.operations.update_success_rate)} label="Manager 升级成功率" />
            <Stat value={metrics.model_usage.input_tokens + metrics.model_usage.output_tokens} label="云端模型 Token" />
          </div>
          <div className="dashboard-grid">
            <div className="card">
              <h3>近 24 小时运行健康</h3>
              <table><tbody>
                <tr><td>正常 / 异常退出</td><td>{metrics.operations.previous_exit_clean} / {metrics.operations.previous_exit_unclean}</td></tr>
                <tr><td>模型成功 / 总请求</td><td>{metrics.operations.model_successes} / {metrics.operations.model_requests}</td></tr>
                <tr><td>升级健康 / 失败 / 回滚</td><td>{metrics.operations.update_healthy} / {metrics.operations.update_failed} / {metrics.operations.update_rollback}</td></tr>
                <tr><td>LongHub 服务错误</td><td>{metrics.operations.product_errors}</td></tr>
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
              <h3>Manager 版本分布</h3>
              <table><tbody>
                {metrics.operations.manager_versions.length === 0 && <tr><td>暂无数据</td><td>—</td></tr>}
                {metrics.operations.manager_versions.map((item) => <tr key={item.version}><td>{item.version}</td><td>{item.count}</td></tr>)}
              </tbody></table>
            </div>
            <div className="card">
              <h3>主要服务错误</h3>
              <table><tbody>
                {metrics.operations.top_product_errors.length === 0 && <tr><td>暂无数据</td><td>—</td></tr>}
                {metrics.operations.top_product_errors.map((item) => <tr key={item.code}><td>{item.code}</td><td>{item.count}</td></tr>)}
              </tbody></table>
            </div>
          </div>
        </>
      )}
    </>
  );
}

function Stat(props: { value: number | string; label: string }): JSX.Element {
  return <div className="stat"><div className="num">{props.value}</div><div className="label">{props.label}</div></div>;
}

function Users(props: { users: AdminUser[]; onStatusChange: (user: AdminUser) => void }): JSX.Element {
  return (
    <>
      <h2>用户管理</h2>
      <p className="muted page-intro">账号用于设备绑定和云端 Skill 订阅；本地 OpenClaw 的模型与能力由用户自行管理。</p>
      <div className="card table-scroll">
        <table>
          <thead><tr><th>用户 ID</th><th>邮箱</th><th>状态</th><th>注册时间</th><th>操作</th></tr></thead>
          <tbody>
            {props.users.length === 0 && <tr><td colSpan={5} className="empty-cell">暂无用户</td></tr>}
            {props.users.map((user) => (
              <tr key={user.user_id}>
                <td><code>{user.user_id.slice(0, 14)}…</code></td>
                <td>{user.email}</td>
                <td><span className={`pill ${user.status}`}>{user.status}</span></td>
                <td>{new Date(user.created_at).toLocaleString("zh-CN")}</td>
                <td><button className={`btn ${user.status === "active" ? "danger" : ""}`} onClick={() => props.onStatusChange(user)}>{user.status === "active" ? "停用" : "启用"}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Devices(props: {
  devices: AdminDevice[];
  onStatusChange: (device: AdminDevice) => void;
  onRotate: (device: AdminDevice) => Promise<void>;
}): JSX.Element {
  return (
    <>
      <h2>设备管理</h2>
      <p className="muted page-intro">这里只管理 LongHub 的设备绑定与连接状态，不下发本地 OpenClaw 权限。</p>
      <div className="card table-scroll">
        <table>
          <thead><tr><th>设备 ID</th><th>平台</th><th>版本</th><th>绑定用户</th><th>状态</th><th>登记时间</th><th>最近在线 / 模型成功</th><th>错误 / 分组</th><th>操作</th></tr></thead>
          <tbody>
            {props.devices.length === 0 && <tr><td colSpan={9} className="empty-cell">暂无设备</td></tr>}
            {props.devices.map((device) => (
              <tr key={device.device_id}>
                <td><code>{device.device_id}</code></td>
                <td>{device.platform}</td>
                <td>{device.app_version}</td>
                <td>{device.user_id ? <code>{device.user_id.slice(0, 14)}…</code> : "未绑定"}</td>
                <td><span className={`pill ${device.status}`}>{device.status}</span></td>
                <td>{new Date(device.created_at).toLocaleString("zh-CN")}</td>
                <td>{device.last_seen_at ? new Date(device.last_seen_at).toLocaleString("zh-CN") : "—"}<br />{device.last_model_success_at ? new Date(device.last_model_success_at).toLocaleString("zh-CN") : "—"}</td>
                <td>{device.last_error_code ?? "—"}<br />{device.rollout_group ?? "默认组"}</td>
                <td><div className="row compact-actions">
                  <button className={`btn ${device.status === "active" ? "danger" : ""}`} onClick={() => props.onStatusChange(device)}>{device.status === "active" ? "停用" : "启用"}</button>
                  <button className="btn ghost" onClick={() => void props.onRotate(device)}>轮换凭据</button>
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function CloudSkillPlans(props: {
  plans: AdminCloudSkillPlan[];
  onCreate: (body: Record<string, unknown>) => void;
  onUpdate: (planId: string, body: Record<string, unknown>) => void;
}): JSX.Element {
  const [planId, setPlanId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [skills, setSkills] = useState("");
  const [monthly, setMonthly] = useState("99");
  const [yearly, setYearly] = useState("699");
  const [calls, setCalls] = useState("1000");
  const [rate, setRate] = useState("10");
  const [concurrency, setConcurrency] = useState("2");

  const skillIds = normalizeSkillIds(skills);
  const valid = isValidCloudSkillPlanId(planId) && Boolean(name.trim()) && skillIds.length > 0 &&
    skillIds.every(isValidCloudSkillId) &&
    isValidYuanAmount(monthly) && isValidYuanAmount(yearly) &&
    isValidPositiveInteger(calls) && isValidPositiveInteger(rate) && isValidPositiveInteger(concurrency);

  const create = (): void => {
    props.onCreate({
      plan_id: planId.trim(),
      name: name.trim(),
      description: description.trim(),
      skill_ids: skillIds,
      price_monthly_fen: Math.round(Number(monthly) * 100),
      price_yearly_fen: Math.round(Number(yearly) * 100),
      included_calls: Math.round(Number(calls)),
      requests_per_minute: Math.round(Number(rate)),
      max_concurrency: Math.round(Number(concurrency)),
      status: "unlisted",
    });
    setPlanId(""); setName(""); setDescription(""); setSkills("");
  };

  return (
    <>
      <h2>云端 Skill 订阅方案</h2>
      <p className="muted page-intro">方案只描述云端 Skill 的价格、额度和并发；不会改变用户系统中的原生 OpenClaw。</p>
      <div className="card">
        <h3>新建方案</h3>
        <div className="form-grid">
          <label>方案 ID<input maxLength={128} placeholder="例如 content-pro" value={planId} onChange={(event) => setPlanId(event.target.value)} /></label>
          <label>展示名称<input placeholder="例如 内容创作云端 Skill" value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label className="span-2">说明<input value={description} onChange={(event) => setDescription(event.target.value)} /></label>
          <label className="span-2">Skill ID（逗号分隔）<input maxLength={4096} placeholder="例如 longhub.skill.content-draft" value={skills} onChange={(event) => setSkills(event.target.value)} /></label>
          <label>月价（元）<input type="number" min="0" value={monthly} onChange={(event) => setMonthly(event.target.value)} /></label>
          <label>年价（元）<input type="number" min="0" value={yearly} onChange={(event) => setYearly(event.target.value)} /></label>
          <label>周期额度（次）<input type="number" min="1" value={calls} onChange={(event) => setCalls(event.target.value)} /></label>
          <label>每分钟请求上限<input type="number" min="1" value={rate} onChange={(event) => setRate(event.target.value)} /></label>
          <label>最大并发<input type="number" min="1" value={concurrency} onChange={(event) => setConcurrency(event.target.value)} /></label>
        </div>
        <button className="btn mt" disabled={!valid} onClick={create}>创建并保持未上架</button>
        <p className="muted mt">新方案需要完成验收后才可上架。</p>
      </div>
      <div className="card mt table-scroll">
        <table>
          <thead><tr><th>方案</th><th>Skill</th><th>价格</th><th>额度 / 限制</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            {props.plans.length === 0 && <tr><td colSpan={6} className="empty-cell">暂无方案</td></tr>}
            {props.plans.map((plan) => (
              <tr key={plan.plan_id}>
                <td><strong>{plan.name}</strong><br /><code>{plan.plan_id}</code></td>
                <td>{plan.skill_ids.join(", ")}</td>
                <td>{yuan(plan.price_monthly_fen)} / 月<br />{yuan(plan.price_yearly_fen)} / 年</td>
                <td>{plan.included_calls.toLocaleString("zh-CN")} 次<br />{plan.requests_per_minute}/分 · {plan.max_concurrency} 并发</td>
                <td><span className={`pill ${plan.status}`}>{plan.status === "listed" ? "已上架" : "未上架"}</span></td>
                <td><button className={`btn ${plan.status === "listed" ? "danger" : ""}`} onClick={() => props.onUpdate(plan.plan_id, { status: plan.status === "listed" ? "unlisted" : "listed" })}>{plan.status === "listed" ? "下架" : "上架"}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

const CLOUD_ADAPTER_REQUIRED_FILES = [
  "SKILL.md",
  "schemas/input.json",
  "schemas/output.json",
] as const;

const DEFAULT_CLOUD_ADAPTER_MANIFEST = {
  schema_version: "longhub/cloud-skill-adapter/v1",
  skill_id: "longhub.skill.example",
  version: "1.0.0",
  display: {
    name: "示例云端 Skill",
    description: "通过 LongHub 云端服务提供能力的原生 OpenClaw 薄适配器",
    category: "productivity",
  },
  service: {
    service_id: "longhub.cloud.example",
    api_version: "1.0",
    entry: "local-longhub-bridge",
  },
  schemas: {
    input: "schemas/input.json",
    output: "schemas/output.json",
  },
  subscription: { plan_ids: ["example-plan"] },
  permissions: { requested: ["candidate.read"], confirmation_class: "none" },
  compatibility: { manager_min_version: "0.1.0", openclaw_version: "2026.7.1" },
};

const DEFAULT_CLOUD_ADAPTER_SKILL = `---
name: example-cloud-skill
description: 通过 LongHub 云端桥接调用示例 Skill
---

此文件只描述公开的安装说明和使用方式，不包含提示词、凭据或可执行代码。
`;

const DEFAULT_CLOUD_ADAPTER_INPUT = `{
  "type": "object",
  "properties": {
    "text": { "type": "string", "description": "需要处理的文本" }
  },
  "required": ["text"],
  "additionalProperties": false
}`;

const DEFAULT_CLOUD_ADAPTER_OUTPUT = `{
  "type": "object",
  "properties": {
    "result": { "type": "string" }
  },
  "required": ["result"],
  "additionalProperties": false
}`;

/** Return a lower-case SHA-256 digest for public adapter file content. */
async function cloudAdapterSha256(content: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("当前浏览器不支持安全摘要，请使用 HTTPS 或最新版浏览器");
  const bytes = new TextEncoder().encode(content);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

/** Encode UTF-8 bytes without relying on spread (adapter files may be large). */
function cloudAdapterBase64(content: string): { encoded: string; size: number } {
  const bytes = new TextEncoder().encode(content);
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return { encoded: btoa(chunks.join("")), size: bytes.byteLength };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validCloudAdapterSkillId(value: unknown): boolean {
  return typeof value === "string" &&
    /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*\.skill\.[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/.test(value);
}

function validCloudAdapterVersion(value: unknown): boolean {
  return typeof value === "string" &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value);
}

function CloudSkillAdapters(props: {
  releases: AdminCloudSkillAdapterRelease[];
  /** Actions may be fire-and-forget from the parent panel, but the form
   * still awaits them so its busy state stays active until the request and
   * refresh have completed. */
  onPublish: (body: Record<string, unknown>) => void | Promise<void>;
  onRevoke: (release: AdminCloudSkillAdapterRelease) => void | Promise<void>;
}): JSX.Element {
  const [manifestText, setManifestText] = useState(() => JSON.stringify(DEFAULT_CLOUD_ADAPTER_MANIFEST, null, 2));
  const [skillMarkdown, setSkillMarkdown] = useState(DEFAULT_CLOUD_ADAPTER_SKILL);
  const [inputSchema, setInputSchema] = useState(DEFAULT_CLOUD_ADAPTER_INPUT);
  const [outputSchema, setOutputSchema] = useState(DEFAULT_CLOUD_ADAPTER_OUTPUT);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");

  const publish = async (): Promise<void> => {
    setFormError("");
    setBusy(true);
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(manifestText);
      } catch {
        throw new Error("manifest JSON 格式不正确");
      }
      if (!isPlainRecord(parsed)) throw new Error("manifest 必须是 JSON 对象");
      if (parsed.schema_version !== "longhub/cloud-skill-adapter/v1") {
        throw new Error("schema_version 必须为 longhub/cloud-skill-adapter/v1");
      }
      if (!validCloudAdapterSkillId(parsed.skill_id)) {
        throw new Error("skill_id 格式应为 publisher.skill.name");
      }
      if (!validCloudAdapterVersion(parsed.version)) throw new Error("version 必须是语义化版本号");
      if (!skillMarkdown.trim()) throw new Error("SKILL.md 不能为空");
      if (!inputSchema.trim() || !outputSchema.trim()) throw new Error("输入和输出 Schema 不能为空");
      try {
        const input = JSON.parse(inputSchema) as unknown;
        const output = JSON.parse(outputSchema) as unknown;
        if (!isPlainRecord(input) || !isPlainRecord(output)) throw new Error("Schema 必须是 JSON 对象");
      } catch (error) {
        if (error instanceof Error && error.message === "Schema 必须是 JSON 对象") throw error;
        throw new Error("schemas/input.json 和 schemas/output.json 必须是合法 JSON");
      }

      const contents: Record<(typeof CLOUD_ADAPTER_REQUIRED_FILES)[number], string> = {
        "SKILL.md": skillMarkdown,
        "schemas/input.json": inputSchema,
        "schemas/output.json": outputSchema,
      };
      const files: Record<string, string> = {};
      const declarations: Array<{ path: string; sha256: string; size: number }> = [];
      for (const path of CLOUD_ADAPTER_REQUIRED_FILES) {
        const content = contents[path];
        const encoded = cloudAdapterBase64(content);
        if (encoded.size <= 0 || encoded.size > 4 * 1024 * 1024) {
          throw new Error(`${path} 必须大于 0 且不超过 4 MiB`);
        }
        files[path] = encoded.encoded;
        declarations.push({ path, sha256: await cloudAdapterSha256(content), size: encoded.size });
      }

      // Integrity is server-owned. Remove stale values from pasted JSON and
      // always bind the manifest to the exact three files shown in this form.
      const manifest: Record<string, unknown> = { ...parsed, files: declarations };
      delete manifest.integrity;
      await props.onPublish({ manifest, files });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "适配器发布失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h2>云端 Skill 薄适配器</h2>
      <p className="muted page-intro">
        这里只发布公开的三文件薄适配器，帮助用户在原生 OpenClaw 中安装 LongHub Skill。业务提示词、模型路由、凭据和执行代码留在云端，后台不会把它们下发到 Manager。
      </p>
      <div className="card">
        <h3>发布新适配器</h3>
        <p className="muted">manifest 使用严格 JSON；保存时浏览器会为 SKILL.md 和两个 JSON Schema 计算 SHA-256/字节数，服务端仍会重新校验、签名并保存。</p>
        <label className="adapter-field-label" htmlFor="cloud-adapter-manifest">manifest JSON</label>
        <textarea
          id="cloud-adapter-manifest"
          className="adapter-json"
          value={manifestText}
          spellCheck={false}
          onChange={(event) => setManifestText(event.target.value)}
        />
        <div className="adapter-files">
          <label>SKILL.md（只允许公开说明）<textarea value={skillMarkdown} spellCheck={false} onChange={(event) => setSkillMarkdown(event.target.value)} /></label>
          <label>schemas/input.json<textarea value={inputSchema} spellCheck={false} onChange={(event) => setInputSchema(event.target.value)} /></label>
          <label>schemas/output.json<textarea value={outputSchema} spellCheck={false} onChange={(event) => setOutputSchema(event.target.value)} /></label>
        </div>
        <div className="row mt">
          <button className="btn" disabled={busy} onClick={() => void publish()}>{busy ? "计算摘要并发布中…" : "发布并签名"}</button>
          <span className="muted">发布后版本不可覆盖；如需停止分发，请在下方撤回。</span>
        </div>
        {formError && <p className="error">{formError}</p>}
      </div>
      <div className="card mt table-scroll">
        <table>
          <thead><tr><th>Skill / 版本</th><th>状态</th><th>兼容版本</th><th>摘要</th><th>签名密钥</th><th>发布时间</th><th>操作</th></tr></thead>
          <tbody>
            {props.releases.length === 0 && <tr><td colSpan={7} className="empty-cell">暂无适配器发布</td></tr>}
            {props.releases.map((release) => (
              <tr key={`${release.skill_id}@${release.version}`}>
                <td><strong>{release.skill_id}</strong><br /><code>{release.version}</code></td>
                <td><span className={`pill ${release.status}`}>{release.status === "active" ? "分发中" : "已撤回"}</span></td>
                <td>管家 ≥ {release.min_manager_version}<br />OpenClaw {release.openclaw_version}</td>
                <td><code title={release.digest}>{release.digest.slice(0, 16)}…</code></td>
                <td><code>{release.signature_key_id}</code></td>
                <td>{new Date(release.created_at).toLocaleString("zh-CN")}{release.revoked_at && <><br /><span className="muted">撤回：{new Date(release.revoked_at).toLocaleString("zh-CN")}</span></>}</td>
                <td><button className="btn danger" disabled={release.status === "revoked"} onClick={() => {
                  if (window.confirm(`确认撤回 ${release.skill_id}@${release.version}？撤回后新设备将无法安装。`)) void props.onRevoke(release);
                }}>撤回</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function CloudSkillSubscriptions(props: { subscriptions: AdminCloudSkillSubscription[] }): JSX.Element {
  const active = props.subscriptions.filter((item) => item.status === "active").length;
  const planCount = new Set(props.subscriptions.map((item) => item.plan_id)).size;
  return (
    <>
      <h2>云端 Skill 订阅与权益</h2>
      <p className="muted page-intro">订阅只授予对应云端 Skill 的调用权益；本地 OpenClaw 始终由用户自行管理。</p>
      <div className="stats">
        <Stat value={props.subscriptions.length} label="订阅总数" />
        <Stat value={active} label="当前有效" />
        <Stat value={planCount} label="使用方案" />
      </div>
      <div className="card mt table-scroll">
        <table>
          <thead><tr><th>订阅 ID</th><th>用户 / 租户</th><th>方案</th><th>周期</th><th>状态</th><th>有效期</th><th>来源订单</th></tr></thead>
          <tbody>
            {props.subscriptions.length === 0 && <tr><td colSpan={7} className="empty-cell">暂无订阅</td></tr>}
            {props.subscriptions.map((subscription) => (
              <tr key={subscription.subscription_id}>
                <td><code>{subscription.subscription_id.slice(0, 16)}…</code></td>
                <td><code>{subscription.user_id.slice(0, 12)}…</code><br /><code>{subscription.tenant_id.slice(0, 12)}…</code></td>
                <td>{subscription.plan_id}</td>
                <td>{subscription.period === "monthly" ? "月度" : "年度"}</td>
                <td><span className={`pill ${subscription.status}`}>{cloudSkillSubscriptionStatusLabel(subscription.status)}</span></td>
                <td>{new Date(subscription.starts_at).toLocaleDateString("zh-CN")} — {new Date(subscription.expires_at).toLocaleDateString("zh-CN")}</td>
                <td><code>{subscription.source_order_id.slice(0, 14)}…</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function CloudSkillOrders(props: { orders: AdminOrder[] }): JSX.Element {
  const statusCounts = useMemo(() => props.orders.reduce<Record<string, number>>((counts, order) => {
    counts[order.status] = (counts[order.status] ?? 0) + 1;
    return counts;
  }, {}), [props.orders]);
  return (
    <>
      <h2>Cloud Skill 订阅订单</h2>
      <p className="muted page-intro">只读对账视图，用于追踪订阅订单和退款状态；金额变更必须由受控的账务服务完成。</p>
      <div className="stats">
        <Stat value={props.orders.length} label="订单总数" />
        <Stat value={statusCounts.paid ?? 0} label="已完成" />
        <Stat value={statusCounts.refunded ?? 0} label="已退款" />
      </div>
      <div className="card mt table-scroll">
        <table>
          <thead><tr><th>订单号</th><th>用户 / 租户</th><th>方案</th><th>周期</th><th>金额</th><th>状态</th><th>时间</th></tr></thead>
          <tbody>
            {props.orders.length === 0 && <tr><td colSpan={7} className="empty-cell">暂无云端 Skill 订单</td></tr>}
            {props.orders.map((order) => (
              <tr key={order.order_id}>
                <td><code>{order.order_id.slice(0, 16)}…</code></td>
                <td><code>{order.user_id.slice(0, 12)}…</code>{order.tenant_id && <><br /><code>{order.tenant_id.slice(0, 12)}…</code></>}</td>
                <td>{order.plan_id ?? "—"}</td>
                <td>{order.period === "monthly" ? "月度" : order.period === "yearly" ? "年度" : "—"}</td>
                <td>{yuan(order.amount_fen)}</td>
                <td><span className={`pill ${order.status}`}>{cloudSkillOrderStatusLabel(order.status)}</span></td>
                <td>{new Date(order.created_at).toLocaleString("zh-CN")}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted mt">支付通道尚未接入；正式开通前，后台不会展示或生成内部支付标记。</p>
      </div>
    </>
  );
}

function CloudArtifactReleases(props: {
  pluginReleases: CloudArtifactRelease[];
  cliReleases: CloudArtifactRelease[];
  onUpload: (surface: CloudArtifactSurface, version: string, file: File) => Promise<void>;
  onRollout: (
    surface: CloudArtifactSurface,
    release: CloudArtifactRelease,
    status: "active" | "paused",
    basisPoints: number,
  ) => void;
  onWithdraw: (surface: CloudArtifactSurface, release: CloudArtifactRelease) => void;
}): JSX.Element {
  return (
    <>
      <h2>Cloud Plugin / CLI 发布</h2>
      <p className="muted page-intro">两条签名 tgz 发布线相互独立，均不进入 Manager 安装包。新版本默认暂停。</p>
      <CloudArtifactUploadForm onUpload={props.onUpload} />
      <CloudArtifactTable
        title="OpenClaw Cloud Plugin"
        surface="cloud-plugin"
        releases={props.pluginReleases}
        onRollout={props.onRollout}
        onWithdraw={props.onWithdraw}
      />
      <CloudArtifactTable
        title="longhub-cloud CLI"
        surface="cloud-cli"
        releases={props.cliReleases}
        onRollout={props.onRollout}
        onWithdraw={props.onWithdraw}
      />
    </>
  );
}

function CloudArtifactTable(props: {
  title: string;
  surface: CloudArtifactSurface;
  releases: CloudArtifactRelease[];
  onRollout: (
    surface: CloudArtifactSurface,
    release: CloudArtifactRelease,
    status: "active" | "paused",
    basisPoints: number,
  ) => void;
  onWithdraw: (surface: CloudArtifactSurface, release: CloudArtifactRelease) => void;
}): JSX.Element {
  return (
    <div className="card table-scroll">
      <h3>{props.title}</h3>
      <table>
        <thead><tr><th>版本</th><th>文件 / SHA-256</th><th>签名</th><th>发布策略</th><th>下载</th><th>操作</th></tr></thead>
        <tbody>
          {props.releases.length === 0 && <tr><td colSpan={6} className="empty-cell">暂无版本</td></tr>}
          {props.releases.map((release, index) => {
            const latest = index === 0;
            const withdrawn = Boolean(release.withdrawn_at);
            return (
              <tr key={release.manifest.version}>
                <td><strong>{release.manifest.version}</strong><br /><span className="muted">#{release.manifest.sequence}</span></td>
                <td>{release.manifest.filename}<br /><code title={release.manifest.sha256}>{release.manifest.sha256.slice(0, 16)}…</code></td>
                <td><code>{release.manifest.signature_key_id}</code><br /><span className={`pill ${withdrawn ? "revoked" : "active"}`}>{withdrawn ? "已撤回" : release.manifest.product_surface}</span></td>
                <td>{release.manifest.rollout.status === "paused" ? "已暂停" : `灰度 ${release.manifest.rollout.basis_points / 100}%`}</td>
                <td>{withdrawn ? "—" : <a href={release.url}>下载</a>}</td>
                <td><div className="row compact-actions">
                  {[500, 2_500, 10_000].map((basisPoints) => (
                    <button
                      key={basisPoints}
                      className="btn"
                      disabled={!latest || withdrawn || (release.manifest.rollout.status === "active" && release.manifest.rollout.basis_points === basisPoints)}
                      onClick={() => props.onRollout(props.surface, release, "active", basisPoints)}
                    >{basisPoints / 100}%</button>
                  ))}
                  <button
                    className="btn"
                    disabled={!latest || withdrawn || release.manifest.rollout.status === "paused"}
                    onClick={() => props.onRollout(props.surface, release, "paused", release.manifest.rollout.basis_points)}
                  >暂停</button>
                  <button
                    className="btn danger"
                    disabled={withdrawn}
                    onClick={() => {
                      if (window.confirm(`确认撤回 ${release.manifest.product_surface}@${release.manifest.version}？`)) {
                        props.onWithdraw(props.surface, release);
                      }
                    }}
                  >撤回</button>
                </div></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CloudArtifactUploadForm(props: {
  onUpload: (surface: CloudArtifactSurface, version: string, file: File) => Promise<void>;
}): JSX.Element {
  const [surface, setSurface] = useState<CloudArtifactSurface>("cloud-plugin");
  const [version, setVersion] = useState("0.2.1");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const normalizedVersion = version.trim();
  const validVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(normalizedVersion);
  const expected = validVersion
    ? surface === "cloud-plugin"
      ? `longhub-openclaw-cloud-plugin-${normalizedVersion}.tgz`
      : `longhub-cloud-cli-${normalizedVersion}.tgz`
    : surface === "cloud-plugin"
      ? "longhub-openclaw-cloud-plugin-x.y.z.tgz"
      : "longhub-cloud-cli-x.y.z.tgz";
  const validFile = file?.name === expected;

  return (
    <div className="card">
      <h3>上传签名发布候选</h3>
      <div className="form-grid">
        <label>发布面<select value={surface} onChange={(event) => {
          const next = event.target.value as CloudArtifactSurface;
          setSurface(next);
          setVersion(next === "cloud-plugin" ? "0.2.1" : "0.1.2");
          setFile(null);
        }}><option value="cloud-plugin">Cloud Plugin</option><option value="cloud-cli">Cloud CLI</option></select></label>
        <label>版本<input value={version} onChange={(event) => setVersion(event.target.value)} /></label>
        <label>tgz<input type="file" accept=".tgz,application/gzip" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label>
      </div>
      <p className="muted">固定文件名：<code>{expected}</code></p>
      <button className="btn" disabled={busy || !validVersion || !validFile} onClick={() => {
        if (!file || busy || !validVersion || !validFile) return;
        setBusy(true);
        void props.onUpload(surface, normalizedVersion, file).finally(() => setBusy(false));
      }}>{busy ? "上传中…" : "上传并保持暂停"}</button>
    </div>
  );
}

function ManagerReleases(props: {
  releases: ManagerRelease[];
  onUpload: (version: string, file: File) => Promise<void>;
  onRollout: (release: ManagerRelease, basisPoints: number) => void;
  onPause: (release: ManagerRelease) => void;
}): JSX.Element {
  return (
    <>
      <h2>Manager 版本</h2>
      <p className="muted page-intro">LongHub Manager 免费分发。版本发布只影响 Manager 本身，不替换或删除用户的原生 OpenClaw。</p>
      <p className="notice page-intro">发布面只接受产品身份为 LongHub Manager 的签名制品。</p>
      <ManagerUploadForm onUpload={props.onUpload} />
      <div className="card table-scroll">
        <table>
          <thead><tr><th>版本</th><th>制品身份</th><th>文件</th><th>大小</th><th>上传人</th><th>上传时间</th><th>发布策略</th><th>下载</th><th>操作</th></tr></thead>
          <tbody>
            {props.releases.length === 0 && <tr><td colSpan={9} className="empty-cell">暂无版本</td></tr>}
            {props.releases.map((release) => (
              <tr key={release.manifest.version}>
                <td>{release.manifest.version} · #{release.manifest.sequence}</td>
                <td>
                  <span className="pill active">LongHub Manager</span>
                </td>
                <td>{release.manifest.filename}</td>
                <td>{(release.manifest.size / 1024 / 1024).toFixed(1)} MB</td>
                <td>{release.uploaded_by}</td>
                <td>{new Date(release.uploaded_at).toLocaleString("zh-CN")}</td>
                <td>
                  {release.manifest.rollout.status === "paused"
                    ? `已暂停（保留 ${(release.manifest.rollout.basis_points / 100).toFixed(2)}%）`
                    : `灰度 ${(release.manifest.rollout.basis_points / 100).toFixed(2)}%`}
                  <br /><span className="muted">#{release.manifest.sequence} · 回滚：{release.manifest.rollback_data_strategy === "snapshot_required" ? "恢复快照" : "向后兼容"}</span>
                </td>
                <td><a href={release.url}>下载</a></td>
                <td><div className="row compact-actions">
                  {[500, 2_500, 10_000].map((basisPoints) => (
                    <button
                      key={basisPoints}
                      className="btn"
                      disabled={
                        props.releases.find((item) => item.manifest.channel === release.manifest.channel)?.manifest.version !== release.manifest.version ||
                        (release.manifest.rollout.status === "active" && release.manifest.rollout.basis_points === basisPoints)
                      }
                      onClick={() => props.onRollout(release, basisPoints)}
                    >{basisPoints / 100}%</button>
                  ))}
                  <button
                    className="btn danger"
                    disabled={
                      props.releases.find((item) => item.manifest.channel === release.manifest.channel)?.manifest.version !== release.manifest.version ||
                      release.manifest.rollout.status === "paused"
                    }
                    onClick={() => props.onPause(release)}
                  >暂停</button>
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted mt">新上传版本默认暂停；灰度和暂停操作会写入审计日志。</p>
      </div>
    </>
  );
}

function Audits(props: { audits: AdminAudit[] }): JSX.Element {
  return (
    <>
      <h2>审计日志</h2>
      <p className="muted page-intro">所有订阅、设备、模型路由和发布变更都应可追溯。</p>
      <div className="card table-scroll">
        <table>
          <thead><tr><th>操作者</th><th>动作</th><th>详情</th><th>时间</th></tr></thead>
          <tbody>
            {props.audits.length === 0 && <tr><td colSpan={4} className="empty-cell">暂无日志</td></tr>}
            {props.audits.map((audit) => (
              <tr key={audit.audit_id}>
                <td>{audit.actor}</td><td>{audit.action}</td><td>{audit.detail ? JSON.stringify(audit.detail) : "—"}</td>
                <td>{new Date(audit.created_at).toLocaleString("zh-CN")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ManagerUploadForm(props: { onUpload: (version: string, file: File) => Promise<void> }): JSX.Element {
  const [version, setVersion] = useState("1.0.0");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const normalizedVersion = version.trim();
  const validVersion = isValidManagerVersion(normalizedVersion);
  const expectedFilename = validVersion
    ? managerInstallerFilename(normalizedVersion)
    : "LongHub-Manager-Setup-x.y.z.exe";
  const validFile = file?.name === expectedFilename;

  const upload = async (): Promise<void> => {
    if (!file || !validVersion || !validFile || busy) return;
    setBusy(true);
    try {
      await props.onUpload(normalizedVersion, file);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h3>上传 LongHub Manager 安装包</h3>
      <div className="row">
        <input style={{ width: 110 }} placeholder="版本 x.y.z" value={version} onChange={(event) => setVersion(event.target.value)} />
        <input type="file" accept=".exe" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
        <button className="btn" disabled={busy || !validVersion || !validFile} onClick={() => void upload()}>{busy ? "上传中…" : "上传并暂停"}</button>
      </div>
      <p className="muted mt">文件名必须为 <code>{expectedFilename}</code>。上传后保持暂停，并在制品身份校验通过后再调整灰度。</p>
      {file && !validFile && <p className="error">所选文件名与版本不匹配，不能上传。</p>}
    </div>
  );
}

function ModelConfigForm(props: { config: AdminModelConfig; onSave: (body: Record<string, unknown>) => void; onTest: () => void }): JSX.Element {
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
      <p className="muted">仅云端 Executor 使用此路由；Manager 和用户自己的 OpenClaw 不会看到真实上游模型或密钥。</p>
      {!props.config.encryption_ready && <p className="error">服务端尚未配置加密密钥，当前不能保存 API Key。</p>}
      <label className="switch-row"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />启用云端执行模型路由</label>
      <label className="switch-row"><input type="checkbox" checked={emergencyDisabled} onChange={(event) => setEmergencyDisabled(event.target.checked)} />紧急暂停该路由</label>
      <div className="form-grid">
        <label>路由 ID<input value={configId} onChange={(event) => setConfigId(event.target.value)} /></label>
        <label>作用域<select value={scopeType} onChange={(event) => setScopeType(event.target.value as AdminModelConfig["scope_type"])}><option value="global">全局</option><option value="tenant">租户</option><option value="plan">订阅方案</option><option value="device">设备</option></select></label>
        <label>作用域 ID<input value={scopeId} disabled={scopeType === "global"} onChange={(event) => setScopeId(event.target.value)} /></label>
        <label>兼容接口 Base URL<input placeholder="https://api.example.com/v1" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></label>
        <label>上游模型 ID<input placeholder="例如 gpt-4.1" value={modelId} onChange={(event) => setModelId(event.target.value)} /></label>
        <label>展示名称<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
        <label>接口格式<select value={apiType} onChange={(event) => setApiType(event.target.value as AdminModelConfig["api_type"])}><option value="openai-completions">Chat Completions</option><option value="openai-responses">Responses</option></select></label>
        <label>上下文窗口<input type="number" min="1" value={contextWindow} onChange={(event) => setContextWindow(event.target.value)} /></label>
        <label>最大输出 Token<input type="number" min="1" value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} /></label>
        <label>上游超时（毫秒）<input type="number" min="1" value={timeoutMs} onChange={(event) => setTimeoutMs(event.target.value)} /></label>
        <label>失败重试（0–2）<input type="number" min="0" max="2" value={maxRetries} onChange={(event) => setMaxRetries(event.target.value)} /></label>
        <label>设备每分钟请求<input type="number" min="1" value={rate} onChange={(event) => setRate(event.target.value)} /></label>
        <label>设备每日 Token<input type="number" min="1" value={dailyTokens} onChange={(event) => setDailyTokens(event.target.value)} /></label>
        <label>租户每月 Token<input type="number" min="1" value={monthlyTokens} onChange={(event) => setMonthlyTokens(event.target.value)} /></label>
        <label>设备并发<input type="number" min="1" value={concurrency} onChange={(event) => setConcurrency(event.target.value)} /></label>
        <label className="span-2">上游 API Key<input type="password" autoComplete="new-password" placeholder={props.config.has_api_key ? "已安全保存；留空表示不更换" : "请输入上游 API Key"} value={apiKey} onChange={(event) => setApiKey(event.target.value)} /></label>
      </div>
      <div className="row mt">
        <button className="btn" disabled={!valid || !props.config.encryption_ready} onClick={() => props.onSave({
          config_id: configId,
          scope_type: scopeType,
          scope_id: scopeType === "global" ? "-" : scopeId,
          enabled,
          emergency_disabled: emergencyDisabled,
          base_url: baseUrl,
          model_id: modelId,
          display_name: displayName,
          api_type: apiType,
          context_window: Number(contextWindow),
          max_tokens: Number(maxTokens),
          request_timeout_ms: Number(timeoutMs),
          max_retries: Number(maxRetries),
          device_requests_per_minute: Number(rate),
          device_daily_tokens: Number(dailyTokens),
          tenant_monthly_tokens: Number(monthlyTokens),
          max_device_concurrency: Number(concurrency),
          ...(apiKey ? { api_key: apiKey } : {}),
        })}>保存配置</button>
        <button className="btn ghost" disabled={!props.config.enabled || !props.config.has_api_key} onClick={props.onTest}>测试连接</button>
        {props.config.updated_at && <span className="muted">上次更新：{new Date(props.config.updated_at).toLocaleString("zh-CN")}</span>}
      </div>
    </div>
  );
}
