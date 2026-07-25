"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const net = require("node:net");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { spawn, spawnSync } = require("node:child_process");
const { loadEnvironment, ENV_LOADED_MARKER } = require("./env");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_LAVALINK_VERSION = "4.2.2";
const MINIMUM_JAR_BYTES = 50_000_000;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0", "::"]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function missingKeys(env, keys) {
  return keys.filter((key) => !env[key] || String(env[key]).trim() === "");
}

function sanitizeHost(raw) {
  return String(raw || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^wss?:\/\//i, "")
    .replace(/\/+$/, "")
    .replace(/^\[|\]$/g, "");
}

function isLocalLavalinkHost(host) {
  return LOCAL_HOSTS.has(sanitizeHost(host).toLowerCase());
}

function normalizeConnectionHost(host) {
  const normalized = sanitizeHost(host);
  if (normalized === "0.0.0.0") return "127.0.0.1";
  if (normalized === "::") return "::1";
  return normalized;
}

function parseJavaMajor(output) {
  const value = String(output || "");
  const match = value.match(/version\s+"([^"]+)"/i) || value.match(/(?:openjdk|java)\s+([0-9][^\s]*)/i);
  if (!match) return null;
  const parts = match[1].split(/[._-]/).map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(parts[0])) return null;
  return parts[0] === 1 && Number.isFinite(parts[1]) ? parts[1] : parts[0];
}

function resolveJarPath(env) {
  const configured = String(env.LAVALINK_JAR || "lavalink.jar").trim();
  return path.isAbsolute(configured) ? configured : path.join(ROOT, configured);
}

function markerPathFor(jarPath) {
  return path.join(path.dirname(jarPath), ".lavalink-version");
}

function validJarSize(jarPath) {
  try {
    return fs.statSync(jarPath).isFile() && fs.statSync(jarPath).size >= MINIMUM_JAR_BYTES;
  } catch {
    return false;
  }
}

function javaVersion() {
  const result = spawnSync("java", ["-version"], { encoding: "utf8" });
  if (result.error) {
    throw new Error(`Java is unavailable: ${result.error.message}`);
  }
  const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  const major = parseJavaMajor(output);
  if (!major || major < 17) {
    throw new Error(`Java 17 or newer is required; detected: ${output.split("\n")[0] || "unknown"}`);
  }
  return { major, output: output.split("\n")[0] };
}

async function downloadToFile(url, destination, options = {}) {
  const attempts = options.attempts || 3;
  const timeoutMs = options.timeoutMs || 300_000;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const temporary = `${destination}.download`;
    await fsp.rm(temporary, { force: true });
    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "user-agent": "Stoney-Music-bootstrap/2.1" },
      });
      if (!response.ok || !response.body) {
        throw new Error(`download returned HTTP ${response.status}`);
      }
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary, { mode: 0o644 }));
      if (!validJarSize(temporary)) {
        throw new Error("downloaded Lavalink file is missing or unexpectedly small");
      }
      await fsp.rename(temporary, destination);
      return;
    } catch (error) {
      lastError = error;
      await fsp.rm(temporary, { force: true });
      if (attempt < attempts) {
        console.warn(`⚠️ Lavalink download attempt ${attempt}/${attempts} failed: ${error.message}`);
        await sleep(attempt * 1_000);
      }
    }
  }

  throw new Error(`Could not download Lavalink: ${lastError?.message || lastError}`);
}

async function ensureLavalinkJar(env) {
  const version = String(env.LAVALINK_VERSION || DEFAULT_LAVALINK_VERSION).trim();
  const jarPath = resolveJarPath(env);
  const markerPath = markerPathFor(jarPath);
  const markerVersion = await fsp.readFile(markerPath, "utf8").then((value) => value.trim()).catch(() => "");

  if (validJarSize(jarPath) && markerVersion === version) {
    console.log(`✅ Lavalink ${version} is already installed.`);
    return { version, jarPath };
  }

  const url = `https://github.com/lavalink-devs/Lavalink/releases/download/${version}/Lavalink.jar`;
  console.log(`⬇️ Downloading official Lavalink ${version}...`);
  await downloadToFile(url, jarPath);
  await fsp.writeFile(markerPath, `${version}\n`, "utf8");
  console.log(`✅ Lavalink ${version} installed.`);
  return { version, jarPath };
}

function probeTcp(host, port, timeoutMs = 1_000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

async function waitForLavalink({ host, port, child = null, timeoutMs = 120_000, probe = probeTcp }) {
  const started = Date.now();
  console.log(`⏳ Waiting for Lavalink at ${host}:${port}...`);

  while (Date.now() - started < timeoutMs) {
    if (await probe(host, port)) {
      console.log("✅ Lavalink is accepting connections.");
      return;
    }
    if (child && child.exitCode !== null) {
      throw new Error(`Lavalink exited before becoming ready (code ${child.exitCode}).`);
    }
    await sleep(500);
  }

  throw new Error(`Timed out after ${Math.ceil(timeoutMs / 1_000)}s waiting for Lavalink at ${host}:${port}.`);
}

function parseJavaOptions(raw) {
  const text = String(raw || "-Xms256M -Xmx900M").trim();
  return text ? text.split(/\s+/) : [];
}

function spawnLavalink(jarPath, env) {
  const args = [...parseJavaOptions(env.JAVA_OPTS), "-jar", jarPath];
  console.log(`🎧 Starting Lavalink ${env.LAVALINK_VERSION || DEFAULT_LAVALINK_VERSION}...`);
  return spawn("java", args, {
    cwd: ROOT,
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });
}

function spawnBot(env) {
  const configured = String(env.STONEY_BOT_ENTRY || path.join("src", "index.js"));
  const entry = path.isAbsolute(configured) ? configured : path.join(ROOT, configured);
  console.log("🚀 Starting Stoney Music bot...");
  return spawn(process.execPath, [entry], {
    cwd: ROOT,
    env: { ...env, [ENV_LOADED_MARKER]: "1" },
    stdio: ["ignore", "inherit", "inherit"],
  });
}

function hasChildExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child, timeoutMs) {
  if (hasChildExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

async function terminateChild(child, label) {
  if (hasChildExited(child)) return;
  child.kill("SIGTERM");
  const stoppedGracefully = await waitForChildExit(child, 5_000);
  if (!stoppedGracefully && !hasChildExited(child)) {
    console.warn(`⚠️ ${label} did not stop after SIGTERM; sending SIGKILL.`);
    child.kill("SIGKILL");
    await waitForChildExit(child, 1_000);
  }
}

async function run() {
  loadEnvironment();

  const env = process.env;
  env.LAVALINK_HOST = sanitizeHost(env.LAVALINK_HOST || "127.0.0.1");
  env.LAVALINK_PORT = String(env.LAVALINK_PORT || "2333").trim();
  env.LAVALINK_SECURE = String(env.LAVALINK_SECURE || "false").trim().toLowerCase();
  env.LAVALINK_VERSION = String(env.LAVALINK_VERSION || DEFAULT_LAVALINK_VERSION).trim();

  const missing = missingKeys(env, ["DISCORD_TOKEN", "MUSIC_TEXT_CHANNEL_ID", "LAVALINK_PASSWORD"]);
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);

  const port = Number.parseInt(env.LAVALINK_PORT, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`LAVALINK_PORT must be an integer from 1 to 65535; received ${env.LAVALINK_PORT}.`);
  }

  let lavalink = null;
  let bot = null;
  let shuttingDown = false;

  const shutdown = async (code, reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (reason) console.log(`🧹 ${reason}`);
    await Promise.all([
      terminateChild(bot, "Discord bot"),
      terminateChild(lavalink, "Lavalink"),
    ]);
    process.exitCode = code;
  };

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => void shutdown(0, `Received ${signal}; stopping Stoney Music services...`));
  }

  try {
    if (isLocalLavalinkHost(env.LAVALINK_HOST)) {
      const detectedJava = javaVersion();
      console.log(`☕ ${detectedJava.output}`);
      const installed = await ensureLavalinkJar(env);
      lavalink = spawnLavalink(installed.jarPath, env);
      lavalink.once("error", (error) => void shutdown(1, `Lavalink failed to start: ${error.message}`));
    } else {
      console.log(`🌐 Using external Lavalink node at ${env.LAVALINK_HOST}:${port}.`);
    }

    const waitSeconds = Number.parseInt(env.LAVALINK_WAIT_TIMEOUT || "120", 10);
    if (!Number.isInteger(waitSeconds) || waitSeconds < 1) {
      throw new Error(`LAVALINK_WAIT_TIMEOUT must be a positive number of seconds; received ${env.LAVALINK_WAIT_TIMEOUT}.`);
    }

    await waitForLavalink({
      host: normalizeConnectionHost(env.LAVALINK_HOST),
      port,
      child: lavalink,
      timeoutMs: waitSeconds * 1_000,
    });

    bot = spawnBot(env);
    bot.once("error", (error) => void shutdown(1, `Discord bot failed to start: ${error.message}`));

    if (lavalink) {
      lavalink.once("exit", (code, signal) => {
        if (shuttingDown) return;
        const detail = signal ? `signal ${signal}` : `code ${code}`;
        void shutdown(1, `Lavalink stopped unexpectedly (${detail}).`);
      });
    }

    bot.once("exit", (code, signal) => {
      if (shuttingDown) return;
      const detail = signal ? `signal ${signal}` : `code ${code}`;
      const exitCode = Number.isInteger(code) && code !== 0 ? code : 1;
      void shutdown(exitCode, `Discord bot stopped unexpectedly (${detail}).`);
    });
  } catch (error) {
    if (shuttingDown) return;
    console.error("❌ Stoney Music bootstrap startup failed:", error?.stack || error);
    await shutdown(1, "Stopping partially started Stoney Music services...");
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error("❌ Stoney Music bootstrap failed:", error?.stack || error);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_LAVALINK_VERSION,
  MINIMUM_JAR_BYTES,
  downloadToFile,
  ensureLavalinkJar,
  isLocalLavalinkHost,
  missingKeys,
  normalizeConnectionHost,
  parseJavaMajor,
  parseJavaOptions,
  probeTcp,
  run,
  sanitizeHost,
  waitForLavalink,
};
