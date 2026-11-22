"use strict";

const APP_NAME = "CGS Desktop";
const NAMED = /^(?:(.*\S)\s+)?-\s+CGS Desktop$/s;

/**
 * ompweb titles its page "<conversation or project> - <app name>" and keeps resetting document.title to that, so the page
 * title itself cannot be reordered. The native window title is derived from it here instead: "CGS Desktop - <conversation
 * or project>", or just the app name while the page has no name of its own.
 */
function windowTitle(pageTitle) {
  const title = String(pageTitle ?? "").trim();
  if (title === "" || title === APP_NAME) return APP_NAME;
  const named = NAMED.exec(title);
  if (named) return named[1] ? `${APP_NAME} - ${named[1]}` : APP_NAME;
  return title;
}

module.exports = { windowTitle, APP_NAME };
