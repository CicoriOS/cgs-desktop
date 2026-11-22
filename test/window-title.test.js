"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { windowTitle } = require("../src/main/window-title");

test("the app name leads the window title, followed by the conversation or project", () => {
  assert.equal(windowTitle("Fix login bug - CGS Desktop"), "CGS Desktop - Fix login bug");
  assert.equal(windowTitle("ompweb-desktop - CGS Desktop"), "CGS Desktop - ompweb-desktop");
  assert.equal(windowTitle("a - b - CGS Desktop"), "CGS Desktop - a - b");
});

test("a page without a name of its own, or a foreign title, stays as it is", () => {
  assert.equal(windowTitle("CGS Desktop"), "CGS Desktop");
  assert.equal(windowTitle(""), "CGS Desktop");
  assert.equal(windowTitle(" - CGS Desktop"), "CGS Desktop");
  assert.equal(windowTitle("Something else"), "Something else");
});
