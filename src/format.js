"use strict";

function escapeDiscordMarkdown(value) {
  return String(value || "")
    .replace(/@/g, "@\u200b")
    .replace(/([\\`*_{}\[\]()#+\-.!|>~])/g, "\\$1");
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return url.toString().replace(/\(/g, "%28").replace(/\)/g, "%29");
  } catch {
    return null;
  }
}

function safeTrackDescription(track) {
  const title = escapeDiscordMarkdown(track?.title || "Unknown title");
  const uri = safeHttpUrl(track?.uri);
  return uri ? `[${title}](${uri})` : title;
}

module.exports = { escapeDiscordMarkdown, safeHttpUrl, safeTrackDescription };
