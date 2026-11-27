import { useEffect } from "react";
import { useActions } from "./client-context";
import { desktop } from "./desktop";
import { dirName } from "./right/paths";

export interface DroppedItem {
  path: string;
  directory: boolean;
  image: boolean;
}

export interface DropPlan {
  /** Directories to register as workspaces, in order; the last one ends up open. */
  workspaces: string[];
  /** Files to attach to the message box as @ references. */
  refs: string[];
}

/** The attribute that marks the part of the page a file dropped on it becomes a workspace from (the sidebar). */
export const WORKSPACE_DROP = "workspace";

/**
 * What a drop means. Folders always become workspaces. Files become references in the message box; pictures dropped anywhere but the
 * sidebar are left to the box, which attaches them as images. Dropped on the sidebar, the first file's folder becomes the workspace
 * (a new chat opens in it) and every file is referenced there.
 */
export function planDrop(items: DroppedItem[], onSidebar: boolean): DropPlan {
  const files = items.filter((item) => !item.directory);
  const workspaces = items.filter((item) => item.directory).map((item) => item.path);
  if (onSidebar && files.length) workspaces.push(dirName(files[0]!.path));
  const referenced = onSidebar ? files : files.filter((item) => !item.image);
  return { workspaces, refs: referenced.map((item) => item.path) };
}

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
const isOnSidebar = (e: DragEvent) => e.target instanceof Element && e.target.closest(`[data-drop="${WORKSPACE_DROP}"]`) !== null;

/** Desktop only: files and folders dropped on the window become workspaces and references (the browser has no paths to offer). */
export function useFileDrop() {
  const actions = useActions();
  useEffect(() => {
    const shell = desktop;
    if (!shell) return;
    const root = document.documentElement;
    const setTarget = (on: boolean) => (on ? (root.dataset.dropTarget = WORKSPACE_DROP) : delete root.dataset.dropTarget);
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.target instanceof Element && e.target.closest("#settings")) return;
      setTarget(isOnSidebar(e));
    };
    const leave = (e: DragEvent) => e.relatedTarget === null && setTarget(false);
    const drop = (e: DragEvent) => {
      setTarget(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (!hasFiles(e) || !files.length) return;
      e.preventDefault();
      if (e.target instanceof Element && e.target.closest("#settings")) return;
      const onSidebar = isOnSidebar(e);
      void shell.inspectDrop(files).then(async (paths) => {
        const plan = planDrop(paths.map((p, i) => ({ ...p, image: files[i]!.type.startsWith("image/") })), onSidebar);
        for (const dir of plan.workspaces) await actions.addWorkspace(dir);
        if (plan.refs.length) actions.restoreDraft("", undefined, plan.refs);
      });
    };
    document.addEventListener("dragover", over);
    document.addEventListener("dragleave", leave);
    document.addEventListener("drop", drop);
    return () => {
      document.removeEventListener("dragover", over);
      document.removeEventListener("dragleave", leave);
      document.removeEventListener("drop", drop);
      setTarget(false);
    };
  }, [actions]);
}
