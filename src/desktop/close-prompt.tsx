// The close prompt (ADR 0046 §5): the window's close button asks whether to keep running in the tray or quit, with a
// "don't ask again" box. Electron's main process owns the decision; this is only the dialog. Mounted in App so it also
// works on the startup pages and in the demo.
import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { desktop } from "../ui/desktop";

export function ClosePrompt() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [remember, setRemember] = useState(false);
  const shell = desktop?.shell;

  useEffect(() => {
    if (!shell) return;
    return shell.onClosePrompt(() => {
      setRemember(false);
      setOpen(true);
    });
  }, [shell]);

  if (!open || !shell) return null;
  const answer = (action: "background" | "quit" | "cancel") => {
    setOpen(false);
    shell.answerClose({ action, remember });
  };

  return (
    <div className="close-prompt-backdrop" data-close-prompt>
      <div className="close-prompt" role="dialog" aria-modal="true" aria-labelledby="close-prompt-title">
        <h2 id="close-prompt-title" className="close-prompt-title">{t("shell.close.title")}</h2>
        <p className="close-prompt-body">{t("shell.close.body")}</p>
        <label className="close-prompt-remember">
          <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
          <span>{t("shell.close.remember")}</span>
        </label>
        <div className="close-prompt-actions">
          <button type="button" className="close-prompt-cancel" onClick={() => answer("cancel")}>
            {t("shell.close.cancel")}
          </button>
          <button type="button" className="close-prompt-quit" onClick={() => answer("quit")}>
            {t("shell.close.quit")}
          </button>
          <button type="button" className="close-prompt-background" data-close-action="background" onClick={() => answer("background")} autoFocus>
            {t("shell.close.background")}
          </button>
        </div>
      </div>
    </div>
  );
}
