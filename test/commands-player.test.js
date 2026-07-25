"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildCommands } = require("../src/commands");
const { COMMAND_ORDER, SETUP_PANEL_VERSION } = require("../src/setup-panel");

function command(commands, name) {
  return commands.find((item) => item.name === name);
}

test("public command surface includes autoplay and one advanced player command group", () => {
  const commands = buildCommands();
  assert.deepEqual(
    commands.map((item) => item.name).sort(),
    ["autoplay", "filter", "loop", "nowplaying", "play", "player", "queue", "setup", "skip", "stop", "volume"]
  );
  assert.equal(commands.length, 11);
});

test("advanced player group exposes every precision and queue operation", () => {
  const player = command(buildCommands(), "player");
  const subcommands = player.options.map((option) => option.name).sort();
  assert.deepEqual(subcommands, [
    "clear",
    "disconnect",
    "move",
    "mute",
    "pause",
    "previous",
    "remove",
    "replay",
    "resume",
    "seek",
    "show",
    "shuffle",
  ]);

  const seek = player.options.find((option) => option.name === "seek");
  assert.equal(seek.options[0].name, "position");
  assert.equal(seek.options[0].required, true);

  const move = player.options.find((option) => option.name === "move");
  assert.deepEqual(move.options.map((option) => option.name), ["position", "destination"]);
});

test("filter command includes basic and advanced Lavalink presets", () => {
  const filter = command(buildCommands(), "filter");
  const choices = filter.options[0].choices.map((choice) => choice.value).sort();
  assert.deepEqual(choices, [
    "bassboost",
    "clear",
    "karaoke",
    "lowpass",
    "nightcore",
    "rotation",
    "tremolo",
    "vaporwave",
    "vibrato",
  ]);
});

test("setup panel advertises the complete command surface and uses a new panel version", () => {
  assert.deepEqual(COMMAND_ORDER, [
    "setup",
    "play",
    "queue",
    "nowplaying",
    "autoplay",
    "player",
    "skip",
    "stop",
    "volume",
    "loop",
    "filter",
  ]);
  assert.equal(SETUP_PANEL_VERSION, "4");
});
