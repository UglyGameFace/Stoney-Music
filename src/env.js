"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ENV_LOADED_MARKER = "STONEY_ENV_LOADED";

function normalizeCandidate(candidate) {
  if (!candidate) return null;
  const absolute = path.resolve(candidate);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function defaultCandidates(cwd = process.cwd()) {
  return [
    path.join(cwd, ".env"),
    "/home/user_discloud/.env",
    "/home/node/.env",
  ];
}

function loadEnvironment(options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const candidates = options.candidates || defaultCandidates(options.cwd);
  const force = options.force === true;

  if (!force && env[ENV_LOADED_MARKER] === "1") {
    return { loaded: false, file: null, skipped: true };
  }

  const seen = new Set();
  for (const candidate of candidates) {
    const normalized = normalizeCandidate(candidate);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    if (!fs.existsSync(normalized) || !fs.statSync(normalized).isFile()) continue;

    const dotenv = options.dotenv || require("dotenv");
    const result = dotenv.config({
      path: normalized,
      override: false,
      quiet: true,
      processEnv: env,
    });
    if (result.error) throw result.error;

    env[ENV_LOADED_MARKER] = "1";
    logger.log(`✅ Loaded environment file: ${normalized}`);
    return { loaded: true, file: normalized, skipped: false };
  }

  env[ENV_LOADED_MARKER] = "1";
  return { loaded: false, file: null, skipped: false };
}

module.exports = {
  ENV_LOADED_MARKER,
  defaultCandidates,
  loadEnvironment,
  normalizeCandidate,
};
