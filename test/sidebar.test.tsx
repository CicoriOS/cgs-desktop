import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { createClient } from "../src/core/client";
import { t } from "../src/i18n";
import { ClientProvider } from "../src/ui/client-context";
import { Sidebar } from "../src/ui/Sidebar";
import { fakeHost, tick } from "./core/fake";

test("with no workspace the only primary action is Add workspace", async () => {
  const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const add = vi.fn();
  const spawn = vi.fn(fakeHost.openChild);
  const client = createClient(() => { throw new Error("must not attach without a workspace"); }, {
    ...fakeHost, info: async () => ({ cwd: "" }), children: async () => [], openChild: spawn,
  });
  const root = createRoot(document.getElementById("root") as unknown as HTMLElement);
  try {
    await act(async () => {
      root.render(<ClientProvider client={client}><Sidebar onAddWorkspace={add} onNavigate={() => {}} /></ClientProvider>);
      await tick();
    });
    const buttons = document.querySelectorAll(".side-top button");
    expect(buttons.length).toBe(1);
    expect(buttons[0]?.textContent).toBe(t("side.addWorkspace"));
    expect(buttons[0]?.classList.contains("primary")).toBe(true);
    await act(async () => buttons[0]?.dispatchEvent(new window.Event("click", { bubbles: true })));
    expect(add).toHaveBeenCalledOnce();
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    client.close();
    vi.unstubAllGlobals();
  }
});