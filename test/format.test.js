"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { escapeDiscordMarkdown, safeHttpUrl, safeTrackDescription } = require("../src/format");

test("track metadata cannot inject Discord formatting or mentions", () => {
  const text = safeTrackDescription({
    title: "**@everyone** [click](bad)",
    uri: "https://example.test/watch?(one)",
  });

  assert.doesNotMatch(text, /@everyone/);
  assert.match(text, /@\u200beveryone/);
  assert.match(text, /\\\*\\\*/);
  assert.match(text, /%28one%29/);
});

test("non-http track URIs are never rendered as masked links", () => {
  assert.equal(
    safeTrackDescription({ title: "Unsafe", uri: "javascript:alert(1)" }),
    "Unsafe"
  );
  assert.equal(safeHttpUrl("file:///tmp/audio.mp3"), null);
});

test("markdown escaping is deterministic", () => {
  assert.equal(escapeDiscordMarkdown("a_b`c"), "a\\_b\\`c");
});
