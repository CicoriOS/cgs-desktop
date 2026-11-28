import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { initialState } from "../src/core/reducer";
import type { Actions, ChildStatus, Client, ClientState } from "../src/core/types";
import { getLocale, setLocale, t } from "../src/i18n";
import { ClientProvider } from "../src/ui/client-context";
import { Sidebar } from "../src/ui/Sidebar";

const original = getLocale();

afterEach(() => {
  setLocale(original);
  vi.unstubAllGlobals();
});

function fakeClient(state: ClientState): Client {
  const actions = { openSession: vi.fn(async () => {}), newSession: vi.fn(async () => {}), notify: vi.fn() } as unknown as Actions;
  return {
    getState: () => state,
    subscribe: () => () => {},
    actions,
    raw: { frames: () => [], subscribe: () => () => {} },
    close: () => {},
  };
}

function child(id: string, title: string, updatedAt: number, controller?: ChildStatus["controller"]): ChildStatus {
  return { id, cwd: "/work", sessionPath: `/sessions/${id}.jsonl`, title, updatedAt, ring: "idle", level: "high", unseen: false, ...(controller ? { controller } : {}) };
}

test("the sidebar marks conversations another client controls, not this window's own", async () => {
  const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("zh");

  const state: ClientState = {
    ...initialState(),
    connection: "ready",
    activeCwd: "/work",
    sessionFile: "/sessions/phone.jsonl",
    title: "From the phone",
    workspaces: [
      {
        cwd: "/work",
        sessions: [
          { path: "/sessions/phone.jsonl", id: "phone", title: "From the phone", updatedAt: 2 },
          { path: "/sessions/mine.jsonl", id: "mine", title: "My desktop control", updatedAt: 1 },
        ],
      },
    ],
    children: [child("phone", "From the phone", 2, { kind: "remote", name: "iPhone 15 Pro", mine: false }), child("mine", "My desktop control", 1, { kind: "desktop", name: "CGS Desktop", mine: true })],
  };
  const client = fakeClient(state);
  const root = createRoot(document.getElementById("root") as unknown as HTMLElement);
  try {
    await act(async () => {
      root.render(
        createElement(ClientProvider, {
          client,
          children: createElement(Sidebar, { onAddWorkspace: () => {}, onNavigate: () => {}, onOpenSettings: () => {} }),
        }),
      );
    });
    const dots = [...document.querySelectorAll(".sess .ctrl")];
    expect(dots).toHaveLength(1);
    expect(dots[0]?.getAttribute("title")).toBe(t("control.sideBadge", { name: "iPhone 15 Pro" }));
    const rows = [...document.querySelectorAll(".sess")];
    const mineRow = rows.find((row) => row.textContent?.includes("My desktop control"));
    expect(mineRow).toBeDefined();
    expect(mineRow?.querySelector(".ctrl")).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

test("a client that only reads the device's list shows pinned workspaces first with a mark, and offers no menu to change them", async () => {
  const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("zh");
  const state: ClientState = {
    ...initialState(),
    connection: "ready",
    workspacesLoaded: true,
    workspaces: [
      { cwd: "/w/recent", sessions: [{ path: "/s/r.jsonl", id: "r", title: "r", updatedAt: 9 }] },
      { cwd: "/w/older-pin", sessions: [], pinnedAt: 100 },
      { cwd: "/w/newer-pin", sessions: [], pinnedAt: 200 },
    ],
  };
  const root = createRoot(document.getElementById("root") as unknown as HTMLElement);
  try {
    await act(async () => {
      root.render(createElement(ClientProvider, { client: fakeClient(state), children: createElement(Sidebar, { onAddWorkspace: () => {}, onNavigate: () => {}, onOpenSettings: () => {} }) }));
    });
    const heads = [...document.querySelectorAll(".ws-head")];
    expect(heads.map((h) => h.getAttribute("title"))).toEqual(["/w/newer-pin", "/w/older-pin", "/w/recent"]);
    expect(heads.map((h) => h.querySelector(".pin") !== null)).toEqual([true, true, false]);
    heads[0]!.dispatchEvent(new window.Event("contextmenu", { bubbles: true, cancelable: true }));
    expect(document.getElementById("ws-menu")).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});
