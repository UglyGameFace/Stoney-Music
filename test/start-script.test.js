"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    const unavailable = () => {
      socket.destroy();
      resolve(false);
    };
    socket.once("error", unavailable);
    socket.once("timeout", unavailable);
  });
}

test("start.sh supervises the actual Java process and cleans it up when Node exits", { timeout: 15_000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stoney-start-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  fs.copyFileSync(path.join(root, "start.sh"), path.join(directory, "start.sh"));
  fs.copyFileSync(path.join(root, "application.yml"), path.join(directory, "application.yml"));
  fs.writeFileSync(path.join(directory, "lavalink.jar"), "");
  fs.truncateSync(path.join(directory, "lavalink.jar"), 50_000_000);
  fs.writeFileSync(path.join(directory, ".lavalink-version"), "4.2.2\n");

  const fakeBin = path.join(directory, "fake-bin");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(
    path.join(fakeBin, "java"),
    `#!/usr/bin/env bash\nif [ "\${1:-}" = "-version" ]; then\n  echo 'openjdk version "21.0.1"' >&2\n  exit 0\nfi\nexec /usr/bin/python3 -c 'import os,socket,time; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); s.bind(("127.0.0.1",int(os.environ["LAVALINK_PORT"]))); s.listen(); time.sleep(30)'\n`
  );
  fs.writeFileSync(
    path.join(fakeBin, "node"),
    "#!/usr/bin/env bash\nsleep 0.25\nexit 7\n"
  );
  fs.chmodSync(path.join(fakeBin, "java"), 0o755);
  fs.chmodSync(path.join(fakeBin, "node"), 0o755);

  const port = await getFreePort();
  const child = spawn("bash", ["start.sh"], {
    cwd: directory,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      DISCORD_TOKEN: "test-token-not-real",
      MUSIC_TEXT_CHANNEL_ID: "123456789012345678",
      LAVALINK_PASSWORD: "test-password-not-real",
      LAVALINK_HOST: "127.0.0.1",
      LAVALINK_PORT: String(port),
      LAVALINK_WAIT_TIMEOUT: "6",
    },
  });

  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  assert.equal(exitCode, 7, output);
  assert.match(output, /Lavalink port is open/);
  assert.match(output, /Starting Stoney Music bot/);
  assert.match(output, /Discord bot stopped unexpectedly/);
  assert.match(output, /Stopping Stoney Music services/);

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(await canConnect(port), false, "fake Lavalink process should be terminated");
});
