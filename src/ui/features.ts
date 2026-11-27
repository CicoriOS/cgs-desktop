import { desktop } from "./desktop";

/**
 * Surface differences between desktop, the local web client, and Connect.
 * - attachButton: the "+" in the message box, an image picker (the connect PWA, where there is no clipboard or drag and drop on a phone; the web build attaches images by paste and drop).
 * - rightPanel: the right sidebar for the file viewer and Git changes (needs local file access).
 * - settings: opened from the sidebar gear on desktop and Connect. Host-only controls need the relevant capabilities.
 */
export const FEATURES = {
  attachButton: import.meta.env.MODE === "connect",
  rightPanel: desktop !== undefined,
  settings: desktop !== undefined || import.meta.env.MODE === "connect",
};
