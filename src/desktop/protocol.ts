// The local host contract between the Electron shell and the page (ADR 0046), exactly as written down in
// cgsconnect/local-channel.md §8. The main process implements it in desktop/host-ipc.mjs + desktop/preload.cjs.
import type { MuxMessage } from "../connect/mux";

/** Link state of the main process <-> sidecar pair. */
export type HostLinkStatus = "connecting" | "ready" | "down" | "upgrade";

/** CLI bootstrap failures shown before the sidecar starts (ADR 0052). */
export type CliSyncErrorCode =
  | "bun_missing"
  | "install_failed"
  | "offline"
  | "bundle_missing"
  | "download_failed"
  | "extract_failed"
  | "toolchain_failed"
  | "version_unreadable"
  | "install_unverified"
  | "restart_cancelled"
  | "sync_failed";

/** `shell.syncState()` and `shell:sync`: startup progress of the CLI the sidecar will run. */
export type CliSyncPhase = "checking" | "installing" | "ready" | "error";

/** One Windows first-run component (ADR 0049 §1); absent on the other platforms. */
export interface ToolchainComponent {
  id: "chromium" | "git" | "python" | "llvm" | "rust" | "lsp";
  label: string;
  state: "pending" | "downloading" | "installing" | "done" | "failed";
  /** Bytes received and expected while `downloading`; 0 when unknown. */
  received: number;
  total: number;
}

export interface CliSyncState {
  phase: CliSyncPhase;
  /** The toolchain downloads that run beside the CLI install (Windows only). */
  components?: ToolchainComponent[];
  code?: CliSyncErrorCode | "cgs_not_found";
  /** Technical detail: versions, resolved paths, what to install by hand. */
  detail?: string;
  /** Streamed `bun add -g` output, newest last. */
  progress?: string[];
  /** stderr/stdout tail of the failed command (install or version read). */
  log?: string;
  /** The CLI the sidecar starts with, once `phase` is `ready`. */
  cgs?: string;
  version?: string;
  /** Every other `cgs` copy found on this machine (shadowing diagnosis). */
  shadowed?: string[];
  /** Set when `CGS_SIDECAR` bypassed the CLI (development and the smoke test). */
  bypassed?: boolean;
}

/** The phases the settings gear and the settings screen know (ADR 0046 §6). */
export type UpdaterPhase = "idle" | "available" | "downloading" | "downloaded" | "error";

export interface UpdaterStatus {
  phase: UpdaterPhase;
  version?: string;
  percent?: number;
  error?: string;
}

/** `window.cgsDesktop.updater` (cgsconnect/local-channel.md §8). Only the user installs; nothing downloads by itself. */
export interface DesktopUpdater {
  check(): Promise<{ version: string; available?: string }>;
  getAutoCheck(): Promise<boolean>;
  setAutoCheck(enabled: boolean): Promise<void>;
  status(): Promise<UpdaterStatus>;
  download(): Promise<void>;
  install(): Promise<void>;
  onStatus(cb: (status: UpdaterStatus) => void): () => void;
}

/** Where a notification click wants the page to go: the conversation that finished or needs attention. */
export interface ShellChildTarget {
  id: string;
  sessionPath?: string;
  cwd?: string;
}

/** `window.cgsDesktop.shell` (cgsconnect/local-channel.md §8): CLI sync, the close prompt and notification clicks. */
export interface DesktopShell {
  syncState(): Promise<CliSyncState>;
  onSync(cb: (state: CliSyncState) => void): () => void;
  /** Re-runs the CLI sync; a successful run starts the sidecar. */
  retry(): void;
  onOpenChild(cb: (target: ShellChildTarget) => void): () => void;
  /** The close button needs an answer (see `answerClose`). */
  onClosePrompt(cb: () => void): () => void;
  answerClose(answer: { action: "background" | "quit" | "cancel"; remember?: boolean }): void;
}

/** Extra context for a link state; the startup pages show the error and the sidecar's log tail. */
export interface HostLinkDetail {
  /** Stable error code (cgs_not_found, cgs_sidecar_invalid, sidecar_missing, spawn_failed, sidecar_exited, bad_handshake, handshake_timeout). */
  error?: string;
  /** Last lines of sidecar stderr and startup diagnostics. */
  log?: string;
  /** Set by `upgrade`: the protocol the sidecar announced; `cli` is its version. */
  protocol?: number;
  cli?: string;
}

/** `call('state')` and `event state` (cgsconnect/local-channel.md §6). */
export interface HostState {
  phase: "starting" | "signed-out" | "ready" | "error";
  error?: string;
  protocol: number;
  cli: string;
}

/** `window.cgsDesktop.host` (cgsconnect/local-channel.md §8). */
export interface DesktopHost {
  /** One MuxMessage for the sidecar; false when the link is not usable (nothing is queued). */
  send(message: MuxMessage): boolean;
  /** MuxMessages from the sidecar; returns the way to stop listening. */
  onMessage(callback: (message: MuxMessage) => void): () => void;
  /** Link state; returns the way to stop listening. Fires at once with the current state on subscribe. */
  onStatus(callback: (status: HostLinkStatus, detail?: HostLinkDetail) => void): () => void;
  /** A sidecar call; rejects with the error code as the message. */
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
  /** Events pushed by the sidecar (`state`, `account`, …); returns the way to stop listening. */
  onEvent(callback: (name: string, data: unknown) => void): () => void;
}

/** Runtime type test for `event state` / `call('state')` payloads. */
export function isHostState(value: unknown): value is HostState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return (state.phase === "starting" || state.phase === "signed-out" || state.phase === "ready" || state.phase === "error") && (state.error === undefined || typeof state.error === "string");
}
