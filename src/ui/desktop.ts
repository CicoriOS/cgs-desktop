// What the Electron shell tells the page (desktop/preload.cjs). Absent in a browser: code that needs it branches on `desktop`, so the
// web build and the desktop build stay one source (ADR 0032).
import type { DesktopHost, DesktopShell, DesktopUpdater } from "../desktop/protocol";

interface CgsDesktop {
  platform: string;
  systemLocale?: string;
  glass: boolean;
  /** The desktop app's own version as semver (`1.3.0`); the experience package is its `N.M` (ADR 0048). */
  appVersion?: string;
  /** The local host link (Electron main <-> sidecar); see cgsconnect/local-channel.md §8. */
  host?: DesktopHost;
  /** Desktop updates (ADR 0046 §6); absent in a browser and in the demo. */
  updater?: DesktopUpdater;
  /** CLI sync, close prompt and notification clicks (ADR 0046 §3, §5). */
  shell?: DesktopShell;
  window: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
    /** A small window for the sign-in pages (true), or the app's normal size again (false). */
    setCompact(compact: boolean): void;
    /** The window starts hidden; call this once there is something for the user to see. */
    reveal(): void;
    isMaximized(): Promise<boolean>;
    /** Calls back when the window is maximized or restored; returns the way to stop listening. */
    onMaximized(listener: (maximized: boolean) => void): () => void;
  };
  /** The paths behind dropped File objects, in order, and whether each is a folder. */
  inspectDrop(files: File[]): Promise<{ path: string; directory: boolean }[]>;
}

declare global {
  interface Window {
    cgsDesktop?: CgsDesktop;
  }
}

export const desktop: CgsDesktop | undefined = typeof window === "undefined" ? undefined : window.cgsDesktop;
