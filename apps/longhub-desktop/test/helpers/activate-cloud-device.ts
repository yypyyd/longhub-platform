export async function activateCloudDevice(
  baseUrl: string,
  adminToken: string,
  deviceToken: string,
  packIds: string[] = [],
): Promise<void> {
  const created = await fetch(`${baseUrl}/v1/admin/activation-codes`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify({ label: "Desktop 自动化", max_uses: 1, expires_in_days: 30, pack_ids: packIds }),
  });
  if (!created.ok) throw new Error(`测试授权码创建失败: HTTP ${created.status}`);
  const { code } = await created.json() as { code: string };
  const activated = await fetch(`${baseUrl}/v1/devices/activate`, {
    method: "POST",
    headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!activated.ok) throw new Error(`测试设备激活失败: HTTP ${activated.status}`);
}
