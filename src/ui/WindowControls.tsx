import { Copy, Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { desktop } from "./desktop";

/** Minimize, maximize and close at the right end of our own title bar (desktop shell only: the window has no frame of its own). */
export function WindowControls() {
  const t = useT();
  const win = desktop?.window;
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!win) return;
    void win.isMaximized().then(setMaximized);
    return win.onMaximized(setMaximized);
  }, [win]);
  if (!win) return null;
  return (
    <div className="win-controls">
      <button type="button" title={t("win.minimize")} aria-label={t("win.minimize")} onClick={win.minimize}>
        <Minus className="i" />
      </button>
      <button type="button" title={maximized ? t("win.restore") : t("win.maximize")} aria-label={maximized ? t("win.restore") : t("win.maximize")} onClick={win.toggleMaximize}>
        {maximized ? <Copy className="i" /> : <Square className="i" />}
      </button>
      <button type="button" className="close" title={t("win.close")} aria-label={t("win.close")} onClick={win.close}>
        <X className="i" />
      </button>
    </div>
  );
}
