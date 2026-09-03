"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");
const protocol = require("../lib/companion-protocol.js");

const executable = path.resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("Usage: node scripts/probe-native-host.cjs <installed-executable>");

const child = spawn(executable, ["--native-host"], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
let buffer = Buffer.alloc(0);
const pending = new Map();

child.stdout.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (buffer.length < length + 4) break;
    const message = JSON.parse(buffer.subarray(4, length + 4).toString("utf8"));
    buffer = buffer.subarray(length + 4);
    pending.get(message.requestId)?.(message);
    pending.delete(message.requestId);
  }
});

function send(action, payload = {}) {
  const requestId = protocol.createId("release-probe");
  const message = protocol.createRequest(action, payload, requestId);
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  child.stdin.write(Buffer.concat([header, body]));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`Native host did not answer ${action}.`));
    }, 10_000);
    pending.set(requestId, (reply) => {
      clearTimeout(timer);
      if (reply.success === false) reject(new Error(reply.message || reply.error));
      else resolve(reply.payload);
    });
  });
}

async function main() {
  const before = await send(protocol.ACTIONS.STATUS);
  if (!before.installed) throw new Error("Native host did not recognize the installed application.");
  const opened = await send(protocol.ACTIONS.OPEN, { context: { kind: "release-test" } });
  if (!opened.opened) throw new Error("Native host did not launch the application.");
  let status;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    status = await send(protocol.ACTIONS.STATUS);
    if (status.running) break;
  }
  if (!status?.running) throw new Error("Installed application did not connect back to the Native Messaging broker.");
  console.log(`Native Messaging accepted: companion ${status.version || "unknown"}, engineReady=${status.engineReady}.`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
}).finally(() => {
  child.stdin.end();
  child.kill();
});
