import { useEffect, useState } from "react";
import { useClientState } from "./client-context";

const SHOW_MS = 4500;

export function Toast() {
  const toast = useClientState((s) => s.toast);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!toast) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), SHOW_MS);
    return () => clearTimeout(t);
  }, [toast]);
  return visible && toast ? <div id="toast" role="status">{toast.text}</div> : null;
}
