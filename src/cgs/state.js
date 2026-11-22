"use strict";
// <agentDir>/cgs/state.json: { defaultsApplied, lastKnownTier }.
//   defaultsApplied  the default role mapping (config-writer DEFAULT_ROLES) was written once; later logins leave
//                    config.yml alone so the user's own choices stay.
//   lastKnownTier    the account tier last seen (display only).

const fsp = require("node:fs/promises");
const path = require("node:path");
const { writeFileAtomic } = require("./fs-util");

const TIER_IDS = ["free", "go", "pro", "dedicated"];
const TIER_NAMES = { free: "Free", go: "Go", pro: "Pro", dedicated: "独享" };

/** A known tier id, or null. */
function normalizeTier(value) {
  return typeof value === "string" && TIER_IDS.includes(value) ? value : null;
}

function statePath(agentDir) {
  return path.join(agentDir, "cgs", "state.json");
}

const EMPTY_STATE = Object.freeze({ defaultsApplied: false, lastKnownTier: null });

function sanitize(raw) {
  const data = raw && typeof raw === "object" ? raw : {};
  return {
    defaultsApplied: data.defaultsApplied === true,
    lastKnownTier: normalizeTier(data.lastKnownTier),
  };
}

/** Missing or unreadable file → the empty state. */
async function readState(agentDir) {
  try {
    return sanitize(JSON.parse(await fsp.readFile(statePath(agentDir), "utf8")));
  } catch {
    return { ...EMPTY_STATE };
  }
}

/** Merge `patch` (only the known keys) into the stored state; returns the new state. */
async function updateState(agentDir, patch) {
  const next = sanitize({ ...(await readState(agentDir)), ...patch });
  await writeFileAtomic(statePath(agentDir), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

module.exports = { TIER_IDS, TIER_NAMES, normalizeTier, statePath, readState, updateState };
