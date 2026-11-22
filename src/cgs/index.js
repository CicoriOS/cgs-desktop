"use strict";

const { prepareAgentDir, getLoginState, readCredentials, notifyModelsChanged } = require("./config-writer");
const { CgsController } = require("./controller");
const { TIER_IDS, TIER_NAMES } = require("./state");

// The server the build points at; CGS_BASE_URL overrides it (e.g. a local new-api for testing).
const CGS_BASE_URL = process.env.CGS_BASE_URL || "https://ai.tmp.cnklp.cn";

/** Startup popup rule: whenever CGS is not signed in; every build signs in through CGS. */
async function needsStartupLogin(agentDir) {
  return !(await getLoginState(agentDir)).signedIn;
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
