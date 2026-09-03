const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const PROTOCOL = require("../lib/companion-protocol.js");

const HOST = path.join(__dirname, "..", "companion", "native-host.cjs");

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

function request(action, requestId, payload = {}) {
  return PROTOCOL.createRequest(action, payload, requestId);
}

function readNative(stream) {
  let buffer = Buffer.alloc(0);
  const waiting = [];
  const queued = [];
  stream.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) break;
      const value = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
      buffer = buffer.subarray(4 + length);
      const waiter = waiting.shift();
      if (waiter) waiter.resolve(value);
      else queued.push(value);
    }
  });
  return () => new Promise((resolve, reject) => {
    if (queued.length) {
      resolve(queued.shift());
      return;
    }
    const timer = setTimeout(() => reject(new Error("Native Messaging 响应超时")), 5000);
    waiting.push({
      resolve(value) { clearTimeout(timer); resolve(value); },
    });
  });
}

function spawnHost(env = {}) {
  return spawn(process.execPath, [HOST], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

function channelFor(pid) {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\video-digest-companion-${pid}`
    : path.join(os.tmpdir(), `video-digest-companion-${pid}.sock`);
}

async function connectWithRetry(channel) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await new Promise((resolve, reject) => {
        const socket = net.createConnection(channel, () => resolve(socket));
        socket.once("error", reject);
      });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

function stop(child) {
  child.stdin.end();
  if (!child.killed) child.kill();
}

test("Native Messaging host 解析分片帧并返回未安装状态", async () => {
  const child = spawnHost({ VIDEO_DIGEST_COMPANION_EXE: path.join(os.tmpdir(), "missing-video-digest.exe") });
  const next = readNative(child.stdout);
  try {
    const body = frame(request(PROTOCOL.ACTIONS.STATUS, "status-1"));
    child.stdin.write(body.subarray(0, 2));
    child.stdin.write(body.subarray(2, 9));
    child.stdin.write(body.subarray(9));
    const reply = await next();
    assert.equal(reply.requestId, "status-1");
    assert.equal(reply.success, true);
    assert.equal(reply.payload.installed, false);
    assert.equal(reply.payload.running, false);
  } finally {
    stop(child);
  }
});

test("Native Messaging host 关联请求、转发事件，并支持桌面端重连", async () => {
  const child = spawnHost();
  const next = readNative(child.stdout);
  let first;
  let second;
  try {
    first = await connectWithRetry(channelFor(child.pid));
    first.destroy();
    await new Promise((resolve) => setTimeout(resolve, 40));
    second = await connectWithRetry(channelFor(child.pid));

    let appBuffer = "";
    const forwarded = new Promise((resolve) => second.on("data", (chunk) => {
      appBuffer += String(chunk);
      const line = appBuffer.split(/\r?\n/).find(Boolean);
      if (line) resolve(JSON.parse(line));
    }));
    child.stdin.write(frame(request(PROTOCOL.ACTIONS.LIST_TASKS, "tasks-1", { limit: 5 })));
    const appRequest = await forwarded;
    assert.equal(appRequest.requestId, "tasks-1");
    assert.equal(appRequest.payload.limit, 5);

    second.write(`${JSON.stringify({
      protocol: PROTOCOL.PROTOCOL,
      version: PROTOCOL.VERSION,
      type: "response",
      requestId: "tasks-1",
      success: true,
      payload: { tasks: [{ id: "task-1" }] },
    })}\n`);
    assert.deepEqual((await next()).payload.tasks, [{ id: "task-1" }]);

    second.write(`${JSON.stringify({
      protocol: PROTOCOL.PROTOCOL,
      version: PROTOCOL.VERSION,
      type: "event",
      event: PROTOCOL.EVENTS.TASK_CHANGED,
      payload: { task: { id: "task-1", state: "running" } },
    })}\n`);
    const event = await next();
    assert.equal(event.type, "event");
    assert.equal(event.payload.task.state, "running");
  } finally {
    first?.destroy();
    second?.destroy();
    stop(child);
  }
});

test("Native Messaging host 拒绝超过 64MB 的帧和未连接转发", async () => {
  const disconnected = spawnHost();
  const next = readNative(disconnected.stdout);
  try {
    disconnected.stdin.write(frame(request(PROTOCOL.ACTIONS.LIST_TASKS, "missing-app")));
    const reply = await next();
    assert.equal(reply.success, false);
    assert.equal(reply.error, "COMPANION_NOT_RUNNING");
  } finally {
    stop(disconnected);
  }

  const oversized = spawnHost();
  const header = Buffer.alloc(4);
  header.writeUInt32LE(64 * 1024 * 1024 + 1);
  const exit = new Promise((resolve) => oversized.once("exit", resolve));
  oversized.stdin.write(header);
  assert.equal(await exit, 1);
});
