/**
 * Native Messaging host broker。
 *
 * Chrome/Edge 只会启动这个 stdio 进程。它负责启动已安装的桌面应用，并用
 * Windows named pipe / macOS Unix socket 把后续请求和识别结果转给桌面应用，
 * 所以扩展端不需要知道任何 localhost 地址。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");

function loadProtocol() {
  const candidates = [
    path.join(__dirname, "..", "lib", "companion-protocol.js"),
    path.join(__dirname, "lib", "companion-protocol.js"),
    process.resourcesPath && path.join(process.resourcesPath, "lib", "companion-protocol.js"),
  ].filter(Boolean);
  for (const file of candidates) {
    try { return require(file); } catch (error) {}
  }
  throw new Error("Native Messaging host 缺少共享通信协议。");
}

const protocol = loadProtocol();

// 安装后的 Native Messaging manifest 指向同一个桌面 exe。开发模式下，
// process.execPath 是 Electron，需要把 main.cjs 作为第一个参数补回去；
// 打包后 process.execPath 本身就是应用入口，不需要脚本参数。
const appPath = process.env.VIDEO_DIGEST_COMPANION_EXE || process.execPath;
const appArgs = process.defaultApp ? [
  path.join(__dirname, "main.cjs"),
  "--companion-app",
] : ["--companion-app"];
const channel = process.platform === "win32"
  ? `\\\\.\\pipe\\video-digest-companion-${process.pid}`
  : path.join(require("node:os").tmpdir(), `video-digest-companion-${process.pid}.sock`);

let appSocket = null;
let appBuffer = "";
let stdinBuffer = Buffer.alloc(0);

function writeNative(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

function response(requestId, payload) {
  writeNative({
    protocol: protocol.PROTOCOL,
    version: protocol.VERSION,
    type: "response",
    requestId,
    success: true,
    payload,
  });
}

function errorResponse(requestId, error) {
  writeNative({
    protocol: protocol.PROTOCOL,
    version: protocol.VERSION,
    type: "error",
    requestId,
    success: false,
    error: error.code || "COMPANION_REQUEST_FAILED",
    message: error.message || "桌面软件请求失败。",
  });
}

function sendToApp(message) {
  if (!appSocket || appSocket.destroyed) {
    const error = new Error("桌面软件尚未启动，请先打开伴生程序。");
    error.code = "COMPANION_NOT_RUNNING";
    throw error;
  }
  appSocket.write(`${JSON.stringify(message)}\n`);
}

function handleAppMessage(message) {
  if (!protocol.isProtocolMessage(message)) return;
  if (message.type === "event") {
    writeNative(message);
    return;
  }
  // 桌面端生成的响应已经带 requestId，原样转回扩展即可。
  writeNative(message);
}

function attachAppSocket(socket) {
  appSocket?.destroy();
  appSocket = socket;
  appBuffer = "";
  socket.on("data", (chunk) => {
    appBuffer += String(chunk);
    const lines = appBuffer.split(/\r?\n/);
    appBuffer = lines.pop() || "";
    for (const line of lines) {
      try { handleAppMessage(JSON.parse(line)); } catch (error) {}
    }
  });
  socket.on("close", () => {
    if (appSocket === socket) appSocket = null;
  });
  socket.on("error", () => {});
}

const server = net.createServer(attachAppSocket);
server.listen(channel);

function launch(payload) {
  if (!fs.existsSync(appPath)) {
    const error = new Error("没有找到桌面识别软件，请先安装官方伴生程序。");
    error.code = "COMPANION_NOT_INSTALLED";
    throw error;
  }
  const handoff = Buffer.from(JSON.stringify(payload || {}), "utf8").toString("base64url");
  const child = spawn(appPath, [
    ...appArgs,
    `--native-channel=${channel}`,
    `--handoff=${handoff}`,
  ], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  child.unref();
  return { opened: true };
}

async function handleRequest(message) {
  if (!protocol.isProtocolMessage(message) || message.type !== "request") return;
  try {
    if (message.action === protocol.ACTIONS.OPEN) {
      response(message.requestId, launch(message.payload));
      return;
    }
    if (message.action === protocol.ACTIONS.STATUS && (!appSocket || appSocket.destroyed)) {
      response(message.requestId, {
        installed: fs.existsSync(appPath),
        running: false,
        engineReady: false,
        version: "",
        models: [],
        activeTask: null,
      });
      return;
    }
    sendToApp(message);
  } catch (error) {
    errorResponse(message.requestId, error);
  }
}

function consumeStdin() {
  while (stdinBuffer.length >= 4) {
    const length = stdinBuffer.readUInt32LE(0);
    if (length < 0 || length > 64 * 1024 * 1024) {
      process.exit(1);
      return;
    }
    if (stdinBuffer.length < 4 + length) return;
    const body = stdinBuffer.subarray(4, 4 + length);
    stdinBuffer = stdinBuffer.subarray(4 + length);
    try { void handleRequest(JSON.parse(body.toString("utf8"))); } catch (error) {}
  }
}

process.stdin.on("data", (chunk) => {
  stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
  consumeStdin();
});
process.stdin.on("end", () => {
  appSocket?.destroy();
  server.close();
});
