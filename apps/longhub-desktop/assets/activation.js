const form = document.querySelector("#activation-form");
const input = document.querySelector("#activation-code");
const button = document.querySelector("#submit");
const message = document.querySelector("#message");
const device = document.querySelector("#device");
const deviceId = new URLSearchParams(location.search).get("device");
if (deviceId) device.textContent = `设备：${deviceId}`;

input.addEventListener("input", () => {
  input.value = input.value.toUpperCase();
  message.textContent = "";
  message.className = "message";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  button.disabled = true;
  button.textContent = "正在激活…";
  message.textContent = "";
  try {
    if (!window.longhubActivation || typeof window.longhubActivation.submit !== "function") {
      throw new Error("ACTIVATION_BRIDGE_UNAVAILABLE");
    }
    const result = await Promise.race([
      window.longhubActivation.submit(input.value),
      new Promise((_, reject) => setTimeout(() => reject(new Error("ACTIVATION_TIMEOUT")), 20_000)),
    ]);
    if (result.ok) {
      message.textContent = "激活成功，正在进入龙枢…";
      message.className = "message success";
      return;
    }
    message.textContent = result.message || "激活失败，请检查授权码";
  } catch {
    message.textContent = "激活服务暂时不可用，请重试或重新打开龙枢";
  }
  message.className = "message error";
  button.disabled = false;
  button.textContent = "立即激活";
});
