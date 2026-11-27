import type { shellZh } from "./shell.zh";

export const shellEn: Record<keyof typeof shellZh, string> = {
  "shell.close.title": "Close the window?",
  "shell.close.body": "CGS Desktop can keep running in the background and reopen from the tray. Quitting interrupts running sessions.",
  "shell.close.remember": "Don't ask again",
  "shell.close.background": "Run in background",
  "shell.close.quit": "Quit",
  "shell.close.cancel": "Cancel",
  "shell.update.available": "Version {version} is available",
  "shell.update.downloading": "Downloading the update: {percent}%",
  "shell.update.downloaded": "Update {version} is ready",
  "shell.update.download": "Download",
  "shell.update.install": "Restart and install",
  "shell.update.error": "Update failed: {error}",
};
