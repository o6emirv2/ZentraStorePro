"use strict";
const crypto = require("node:crypto");
const GATE_VERSION = 82;
function credentialRevision() {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        "zentra-admin-six-stage-v82",
        require("../config/env").adminUids.slice().sort(),
        require("../config/env").adminEmails.slice().sort(),
        require("./adminTransientStore").memory
          ? require("./adminTransientStore").bootId
          : "",
        ...[
          "ADMIN_GATE_FOUR_SALT_HEX",
          "ADMIN_GATE_FOUR_HASH_HEX",
          "ADMIN_GATE_FIVE_SALT_HEX",
          "ADMIN_GATE_FIVE_HASH_HEX",
          "ADMIN_TOTP_SECRET_BASE32",
          "ADMIN_TOTP_PERSONAL_ONLY",
        ].map((key) => String(process.env[key] || "")),
      ]),
    )
    .digest("hex");
}
async function currentSessionPolicy(uid, email) {
  const policy = await require("./adminStoreService").resolveStaffPolicy(
    uid,
    email,
  );
  if(!policy)return null;
  const {db}=require("../config/firebaseAdmin").initFirebaseAdmin();
  const factor=(await require("./adminFactorVault").reference(db,uid).get()).data();
  if(factor?.revocationPending)return null;
  return {
        factorVersion: factor?.version||0,
        gateVersion: GATE_VERSION,
        policyVersion: Number(policy.policyVersion || 0),
        credentialRevision: credentialRevision(),
      };
}
async function sessionPolicyMatches(row) {
  if (
    !row ||
    row.gateVersion !== GATE_VERSION ||
    row.credentialRevision !== credentialRevision()
  )
    return false;
  const current = await currentSessionPolicy(row.uid, row.email);
  return !!current && row.policyVersion === current.policyVersion && (row.factorVersion||0)===current.factorVersion;
}
module.exports = {
  GATE_VERSION,
  credentialRevision,
  currentSessionPolicy,
  sessionPolicyMatches,
};
