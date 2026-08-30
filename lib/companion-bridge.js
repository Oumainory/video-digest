/**
 * Native Messaging 客户端。
 *
 * 扩展不直接接触 localhost、端口或 Python。桌面安装包注册一个 Native
 * Messaging host，service worker 只通过 request/response 和事件与它通信。
 * 该模块把端口生命周期、超时和断线统一收口，业务层只需要调用 request。
 */
var BILI_COMPANION_BRIDGE = (() => {
  const PROTOCOL =
    typeof BILI_COMPANION !== "undefined"
      ? BILI_COMPANION
      : require("./companion-protocol.js");

  const DEFAULT_TIMEOUT_MS = 30_000;

  function createCompanionBridge({
    connectNative,
    hostName = PROTOCOL.HOST_NAME,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onEvent = () => {},
  } = {}) {
    if (typeof connectNative !== "function") {
      throw new Error("伴生软件桥接需要 connectNative。");
    }

    let port = null;
    let connecting = null;
    const pending = new Map();

    function clearPort(target) {
      if (port !== target) return;
      port = null;
      connecting = null;
    }

    function rejectPending(error) {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      pending.clear();
    }

    function handleMessage(message) {
      if (!PROTOCOL.isProtocolMessage(message)) return;

      const requestId = String(message.requestId || "");
      if (message.type === "event" && !requestId) {
        try {
          onEvent(message.event, message.payload || {});
        } catch (error) {
          // 事件消费者不能把 Native Messaging 的读取循环打断。
        }
        return;
      }

      const entry = pending.get(requestId);
      if (!entry) return;
      pending.delete(requestId);
      clearTimeout(entry.timer);
      if (message.type === "error" || message.success === false) {
        const error = new Error(
          String(message.message || message.error || "桌面软件请求失败。"),
        );
        error.code = String(message.error || "COMPANION_REQUEST_FAILED");
        entry.reject(error);
        return;
      }
      entry.resolve(message.payload ?? message);
    }

    function handleDisconnect(target) {
      const message = target?.error?.message || "桌面识别软件未运行或连接已断开。";
      const error = new Error(message);
      error.code = "COMPANION_DISCONNECTED";
      clearPort(target);
      rejectPending(error);
    }

    function ensurePort() {
      if (port) return port;
      if (connecting) return connecting;
      connecting = Promise.resolve().then(() => {
        let target;
        try {
          target = connectNative(hostName);
        } catch (error) {
          const wrapped = new Error(
            "没有检测到桌面识别软件，请先安装官方伴生程序。",
          );
          wrapped.code = "COMPANION_NOT_INSTALLED";
          throw wrapped;
        }
        if (!target?.postMessage || !target?.onMessage?.addListener) {
          const error = new Error("桌面识别软件连接不可用。");
          error.code = "COMPANION_UNAVAILABLE";
          throw error;
        }
        target.onMessage.addListener(handleMessage);
        target.onDisconnect?.addListener(() => handleDisconnect(target));
        port = target;
        return target;
      }).finally(() => {
        connecting = null;
      });
      return connecting;
    }

    async function request(action, payload = {}, { timeout = timeoutMs } = {}) {
      const target = await ensurePort();
      const requestId = PROTOCOL.createId("request");
      const message = PROTOCOL.createRequest(action, payload, requestId);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          const error = new Error("桌面软件响应超时，请确认软件仍在运行。");
          error.code = "COMPANION_TIMEOUT";
          reject(error);
        }, Math.max(100, Number(timeout) || DEFAULT_TIMEOUT_MS));
        pending.set(requestId, { resolve, reject, timer });
        try {
          target.postMessage(message);
        } catch (error) {
          clearTimeout(timer);
          pending.delete(requestId);
          const wrapped = new Error("无法把请求发送给桌面软件。");
          wrapped.code = "COMPANION_SEND_FAILED";
          reject(wrapped);
        }
      });
    }

    function close() {
      const target = port;
      clearPort(target);
      rejectPending(Object.assign(new Error("伴生软件连接已关闭。"), {
        code: "COMPANION_CLOSED",
      }));
      try {
        target?.disconnect?.();
      } catch (error) {}
    }

    return { request, close, getPort: () => port };
  }

  return { createCompanionBridge, DEFAULT_TIMEOUT_MS };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = BILI_COMPANION_BRIDGE;
}
