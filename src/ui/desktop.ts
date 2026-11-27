// What the Electron shell tells the page (desktop/preload.cjs). Absent in a browser: code that needs it branches on `desktop`, so the
// web build and the desktop build stay one source (ADR 0032).
interface CgsDesktop {
  platform: string;
  glass: boolean;
  window: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
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
