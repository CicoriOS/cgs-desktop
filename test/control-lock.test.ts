import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { initialState } from "../src/core/reducer";
import type { Actions, Client, ClientState, Controller } from "../src/core/types";
import { getLocale, setLocale, t } from "../src/i18n";
import { ClientProvider } from "../src/ui/client-context";
import { Composer } from "../src/ui/composer/Composer";

const original = getLocale();

afterEach(() => {
  setLocale(original);
  vi.unstubAllGlobals();
});

/** The composer only needs `control` and `takeControl` from the client for this test. */
function fakeClient(state: () => ClientState, takeControl: () => void): Client {
  const actions = { takeControl } as unknown as Actions;
  return {
    getState: state,
    subscribe: () => () => {},
    actions,
    raw: { frames: () => [], subscribe: () => () => {} },
    close: () => {},
  };
}

test("a conversation controlled elsewhere covers the composer, and a click takes it over", async () => {
  const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("zh");

  let current: ClientState = { ...initialState(), control: { controller: { kind: "remote", name: "iPhone 15 Pro" }, you: false } };
  const takeControl = vi.fn();
  const client = fakeClient(() => current, takeControl);
  const root = createRoot(document.getElementById("root") as unknown as HTMLElement);
  try {
    const render = async () => {
      await act(async () => {
        root.render(createElement(ClientProvider, { client, children: createElement(Composer) }));
      });
    };
    const lock = () => document.querySelector(".control-lock");

    await render();
    expect(lock()).not.toBeNull();
    expect(lock()?.textContent).toContain(t("control.remote"));
    expect(lock()?.textContent).toContain(t("control.takeOver"));

    await act(async () => lock()?.dispatchEvent(new window.Event("click", { bubbles: true })));
    expect(takeControl).toHaveBeenCalledOnce();

    // Another kind of controller is named: the wording for a person or the desktop.
    const desk: Controller = { kind: "desktop", name: "MacBook" };
    current = { ...current, control: { controller: desk, you: false } };
    await render();
    expect(lock()?.textContent).toContain(t("control.taken", { name: "MacBook" }));

    // The one who controls the conversation writes: no cover.
    current = { ...current, control: { controller: desk, you: true } };
    await render();
    expect(lock()).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});
