"use strict";

const { prepareAgentDir, getLoginState, readCredentials, notifyModelsChanged } = require("./config-writer");
const { detectThirdPartyCredentials, shouldShowStartupPopup } = require("./credential-detect");
const { CgsController } = require("./controller");
const { TIER_IDS, TIER_NAMES } = require("./state");

// The server the build points at; CGS_BASE_URL overrides it (e.g. a local new-api for testing).
const CGS_BASE_URL = process.env.CGS_BASE_URL || "https://ai.tmp.cnklp.cn";

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
  TIER_IDS,
  TIER_NAMES,
};
