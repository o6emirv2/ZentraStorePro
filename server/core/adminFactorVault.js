"use strict";
const crypto = require("node:crypto");
const { initFirebaseAdmin } = require("../config/firebaseAdmin");
const { recordMutationAudit } = require("./storeMutationAudit");
function fail(code, statusCode = 409) {
  throw Object.assign(new Error(code), { code, statusCode });
}
function vaultKeys() {
  const parse = (v) =>
    typeof v === "string" && /^[a-f0-9]{64}$/i.test(v)
      ? Buffer.from(v, "hex")
      : null;
  const current = parse(process.env.ADMIN_TOTP_ENCRYPTION_KEY);
  if (!current) fail("ADMIN_FACTOR_VAULT_UNAVAILABLE", 503);
  const previous = parse(process.env.ADMIN_TOTP_PREVIOUS_ENCRYPTION_KEY);
  return [current, ...(previous ? [previous] : [])];
}
function fingerprint(key) {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 24);
}
function seal(uid, seed) {
  const key = vaultKeys()[0],
    iv = crypto.randomBytes(12),
    cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("zentra-admin-factor-v1/" + uid));
  const bytes = Buffer.concat([cipher.update(seed, "ascii"), cipher.final()]);
  return {
    keyId: fingerprint(key),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    bytes: bytes.toString("base64"),
  };
}
function open(uid, value) {
  try {
    const key = vaultKeys().find((k) => fingerprint(k) === value.keyId);
    if (!key) fail("ADMIN_FACTOR_VAULT_UNAVAILABLE", 503);
    const d = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(value.iv, "base64"),
    );
    d.setAAD(Buffer.from("zentra-admin-factor-v1/" + uid));
    d.setAuthTag(Buffer.from(value.tag, "base64"));
    return Buffer.concat([
      d.update(Buffer.from(value.bytes, "base64")),
      d.final(),
    ]).toString("ascii");
  } catch {
    fail("ADMIN_FACTOR_VAULT_UNAVAILABLE", 503);
  }
}
const reference = (db, uid) => db.collection("storeAdminFactors").doc(uid);
function recoveryHash(uid, code) {
  return crypto
    .createHash("sha256")
    .update("zentra-admin-recovery-v1\0" + uid + "\0" + code)
    .digest();
}
function recoveryMatches(uid, code, stored) {
  if (
    typeof code !== "string" ||
    !/^[a-zA-Z0-9_-]{43}$/.test(code) ||
    !/^[a-f0-9]{64}$/.test(stored || "")
  )
    return false;
  return crypto.timingSafeEqual(
    recoveryHash(uid, code),
    Buffer.from(stored, "hex"),
  );
}
function createCredentials() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
    raw = crypto.randomBytes(20),
    bits = [...raw].map((x) => x.toString(2).padStart(8, "0")).join("");
  return {
    seed: bits
      .match(/.{5}/g)
      .map((x) => alphabet[parseInt(x, 2)])
      .join(""),
    recovery: crypto.randomBytes(32).toString("base64url"),
  };
}
async function replace({
  uid,
  password,
  oldCode,
  recovery,
  newCredentials,
  newCode,
}) {
  const { auth, db } = initFirebaseAdmin(),
    totp = require("./adminTotpService");
  if (!db || !auth || !uid || uid.includes("/"))
    fail("ADMIN_FACTOR_VAULT_UNAVAILABLE", 503);
  vaultKeys();
  const u = await auth.getUser(uid),
    policy = await require("./adminStoreService").resolveStaffPolicy(
      uid,
      u.email,
    );
  if (!policy?.active || u.disabled || u.emailVerified !== true)
    fail("ADMIN_REQUIRED", 403);
  await require("./adminGateService").verifyFirebasePassword(
    { uid, email: u.email },
    password,
  );
  const ref = reference(db, uid),
    previous = (await ref.get()).data() || {},
    version = previous.version || 0;
  if (recovery) {
    if (!recoveryMatches(uid, recovery, previous.recoveryHash))
      fail("ADMIN_FACTOR_RECOVERY_REJECTED", 403);
  } else {
    const proof = await totp.verifyAdminTotp({ uid, code: oldCode });
    if (!proof.verified || proof.replayed || proof.factorVersion !== version)
      fail("ADMIN_TOTP_REQUIRED", 403);
  }
  if (
    !/^[A-Z2-7]{32}$/.test(newCredentials?.seed || "") ||
    !/^[a-zA-Z0-9_-]{43}$/.test(newCredentials?.recovery || "") ||
    !totp.matchesCode(newCredentials.seed, newCode)
  )
    fail("ADMIN_FACTOR_NEW_CODE_INVALID", 403);
  const sealed = seal(uid, newCredentials.seed),
    hash = recoveryHash(uid, newCredentials.recovery).toString("hex"),
    now = Date.now();
  const revision = await db.runTransaction(async (tx) => {
    const row = (await tx.get(ref)).data() || {};
    if (
      (row.version || 0) !== version ||
      (recovery && !recoveryMatches(uid, recovery, row.recoveryHash))
    )
      fail("ADMIN_FACTOR_ALREADY_CHANGED");
    tx.set(ref, {
      sealed,
      recoveryHash: hash,
      version: version + 1,
      createdAt: row.createdAt || now,
      changedAt: now,
      revocationPending: true,
    });
    recordMutationAudit(
      tx,
      db,
      recovery ? "admin.factor.recovered" : "admin.factor.rotated",
      { uid },
      { targetUid: uid, revision: version + 1 },
    );
    return version + 1;
  });
  await finalize(uid);
  return { revision };
}
async function finalize(uid) {
  const { db, auth } = initFirebaseAdmin(),
    ref = reference(db, uid),
    row = (await ref.get()).data();
  if (!row?.revocationPending) return;
  await auth.revokeRefreshTokens(uid);
  await require("./adminSessionRegistry").revokeAdminSessionsForUser(uid);
  await db.runTransaction(async (tx) => {
    const v = (await tx.get(ref)).data();
    if (v?.version === row.version)
      tx.update(ref, { revocationPending: false, revokedAt: Date.now() });
  });
}
module.exports = { reference, open, createCredentials, replace, finalize };
