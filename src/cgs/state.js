"use strict";
// <agentDir>/cgs/state.json: { appliedPreset, lastKnownTier, dismissedTier } (each a preset id or null).
// Plus the pure decision logic for the "your tier changed" bubble.

const fsp = require("node:fs/promises");
const path = require("node:path");
const { writeFileAtomic } = require("./fs-util");

const PRESET_IDS = ["free", "go", "pro", "dedicated"];
const PRESET_NAMES = { free: "Free", go: "Go", pro: "Pro", dedicated: "独享" };

/** A known tier/preset id, or null. */
function normalizeTier(value) {
  return typeof value === "string" && PRESET_IDS.includes(value) ? value : null;
}

function statePath(agentDir) {
  return path.join(agentDir, "cgs", "state.json");
}

const EMPTY_STATE = Object.freeze({ appliedPreset: null, lastKnownTier: null, dismissedTier: null });

function sanitize(raw) {
  const data = raw && typeof raw === "object" ? raw : {};
  return {
    appliedPreset: normalizeTier(data.appliedPreset),
    lastKnownTier: normalizeTier(data.lastKnownTier),
    dismissedTier: normalizeTier(data.dismissedTier),
  };
}

/** Missing or unreadable file → all-null state. */
async function readState(agentDir) {
  try {
    return sanitize(JSON.parse(await fsp.readFile(statePath(agentDir), "utf8")));
  } catch {
    return { ...EMPTY_STATE };
  }
}

/** Merge `patch` (only the three known keys) into the stored state; returns the new state. */
async function updateState(agentDir, patch) {
  const next = sanitize({ ...(await readState(agentDir)), ...patch });
  await writeFileAtomic(statePath(agentDir), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/**
 * Pure. Should the "tier changed" bubble show? Only for a signed-in user whose detected tier is a
 * known preset that is neither the applied preset nor one they already chose to keep.
 */
function decideBubble({ signedIn, tier, appliedPreset, dismissedTier }) {
  const t = normalizeTier(tier);
  if (!signedIn || !t) return null;
  if (t === normalizeTier(appliedPreset) || t === normalizeTier(dismissedTier)) return null;
  return { tier: t, name: PRESET_NAMES[t] };
}

module.exports = { PRESET_IDS, PRESET_NAMES, normalizeTier, statePath, readState, updateState, decideBubble };
