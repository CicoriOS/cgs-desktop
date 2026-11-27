// Types for desktop/workspace.mjs, which the tests import as plain Node code (the module itself is untyped JavaScript).
import type { FileEntry, FilePreview, GitBranch, GitCommit, GitDiffTarget, GitFile, GitStatus, WorkspaceApi } from "../src/core/types";

export function listDirectory(cwd: string, dir?: string): Promise<FileEntry[]>;
export function readPreview(cwd: string, file: string): Promise<FilePreview>;
export function gitStatus(cwd: string): Promise<GitStatus>;
export function gitDiff(cwd: string, file: string, target: GitDiffTarget): Promise<string | undefined>;
export function gitStage(cwd: string, paths: string[] | "all"): Promise<void>;
export function gitUnstage(cwd: string, paths: string[] | "all"): Promise<void>;
export function gitDiscard(cwd: string, paths: string[]): Promise<void>;
export function gitCommit(cwd: string, message: string): Promise<void>;
export function gitFetch(cwd: string): Promise<void>;
export function gitPull(cwd: string): Promise<void>;
export function gitPush(cwd: string): Promise<void>;
export function gitBranches(cwd: string): Promise<GitBranch[]>;
export function gitCheckout(cwd: string, branch: string, create?: boolean): Promise<void>;
export function gitLog(cwd: string, limit: number): Promise<GitCommit[]>;
export function gitCommitFiles(cwd: string, hash: string): Promise<GitFile[]>;
export function watchWorkspace(cwd: string, listener: () => void): () => void;

export interface WorkspaceIpcMain {
  handle(channel: string, handler: (event: { sender: WorkspaceWebContents }, ...args: any[]) => unknown): void;
  on(channel: string, handler: (event: { sender: WorkspaceWebContents }, ...args: any[]) => void): void;
}

export interface WorkspaceWebContents {
  id: number;
  send(channel: string, ...args: unknown[]): void;
  on(event: "destroyed" | "did-start-loading", listener: () => void): void;
  isDestroyed(): boolean;
}

export function registerWorkspaceIpc(ipcMain: WorkspaceIpcMain): void;

export const workspaceMethods: { readonly [K in Exclude<keyof WorkspaceApi, "watch">]: WorkspaceApi[K] };
