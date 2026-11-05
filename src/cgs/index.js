"use strict";

const { prepareAgentDir, getLoginState, readCredentials, notifyModelsChanged } = require("./config-writer");
const { detectThirdPartyCredentials, shouldShowStartupPopup } = require("./credential-detect");
const { CgsController } = require("./controller");
const { PRESET_IDS, PRESET_NAMES } = require("./state");

const CGS_BASE_URL = process.env.CGS_BASE_URL || "https://api.cicori.com";

/** Startup popup rule: only when neither CGS nor any third-party credentials are saved in the agentDir. */
async function needsStartupLogin(agentDir) {
  const login = await getLoginState(agentDir);
  if (login.signedIn) return false;
  return shouldShowStartupPopup({ cgsSignedIn: false, thirdParty: await detectThirdPartyCredentials(agentDir) });
}

module.exports = {
  CGS_BASE_URL,
  prepareAgentDir,
  getLoginState,
  readCredentials,
  notifyModelsChanged,
  needsStartupLogin,
  CgsController,
  PRESET_IDS,
  PRESET_NAMES,
};
