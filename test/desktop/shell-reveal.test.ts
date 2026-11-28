import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { DesktopHost, HostLinkStatus, HostState } from "../../src/desktop/protocol";

const READY: HostState = { phase: "ready", protocol: 1, cli: "test" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** A host whose link status the test drives; `state` answers the shell's `call("state")`. */
function fakeHost(state: HostState) {
  let push: (status: HostLinkStatus, detail?: { error?: string }) => void = () => {};
  const host: DesktopHost = {
    send: () => true,
    onMessage: () => () => {},
    onStatus: (callback) => {
      push = callback;
      callback("connecting");
      return () => {};
    },
    call: (async () => state) as DesktopHost["call"],
    onEvent: () => () => {},
  };
  return { host, push: (status: HostLinkStatus, detail?: { error?: string }) => push(status, detail) };
}

async function mount(state: HostState) {
  const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
  const reveal = vi.fn();
  Object.assign(window, { cgsDesktop: { platform: "linux", glass: false, window: { reveal, minimize() {}, toggleMaximize() {}, close() {}, setCompact() {}, isMaximized: async () => false, onMaximized: () => () => {} } } });
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { DesktopShell } = await import("../../src/desktop/state");
  const { host, push } = fakeHost(state);
  const root = createRoot(document.getElementById("root") as unknown as HTMLElement);
  await act(async () => {
    root.render(createElement(DesktopShell, { host, app: createElement("p", { id: "the-app" }, "app") }));
  });
  return { document, reveal, push, unmount: () => act(async () => root.unmount()) };
}

test("starting up shows nothing and keeps the window hidden until the app is ready", async () => {
  const shell = await mount(READY);
  try {
    expect(shell.document.getElementById("root")?.textContent).toBe("");
    expect(shell.reveal).not.toHaveBeenCalled();
    await act(async () => shell.push("ready"));
    expect(shell.document.getElementById("the-app")).not.toBeNull();
    expect(shell.reveal).toHaveBeenCalledTimes(1);
  } finally {
    await shell.unmount();
  }
});

test("a failure the user must act on shows the window at once instead of waiting", async () => {
  const shell = await mount(READY);
  try {
    await act(async () => shell.push("down", { error: "cgs_not_found" }));
    expect(shell.reveal).toHaveBeenCalledTimes(1);
    expect(shell.document.querySelector("[data-host-state='missing']")).not.toBeNull();
  } finally {
    await shell.unmount();
  }
});

test("a link that is only reconnecting stays invisible", async () => {
  const shell = await mount(READY);
  try {
    await act(async () => shell.push("down", { error: "link_down" }));
    expect(shell.reveal).not.toHaveBeenCalled();
    expect(shell.document.getElementById("root")?.textContent).toBe("");
  } finally {
    await shell.unmount();
  }
});
