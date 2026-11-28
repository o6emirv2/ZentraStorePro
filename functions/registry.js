"use strict";
const { createHmac } = require("node:crypto");
const fail = (code, statusCode) =>
  Object.assign(new Error(code), { code, statusCode });
function emailKey(email, key = process.env.ACCOUNT_BLOCKLIST_KEY) {
  if (!key || Buffer.byteLength(key) < 32)
    throw fail("REGISTRATION_CONTROL_UNAVAILABLE", 503);
  if (
    typeof email !== "string" ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  )
    throw fail("REGISTRATION_UNAVAILABLE", 403);
  return createHmac("sha256", key)
    .update("zentra-email-v1\0" + email.trim().normalize("NFC").toLowerCase())
    .digest("hex");
}
const marker = (key) =>
  createHmac("sha256", key).update("zentra-registration-key-v1").digest("hex");
async function check(db, email, read = (ref) => ref.get()) {
  const config = (
    await read(db.collection("storeRegistrationPolicy").doc("current"))
  ).data();
  if (!config?.active) return;
  const id = emailKey(email),
    key = process.env.ACCOUNT_BLOCKLIST_KEY;
  if (config.keyId !== marker(key))
    throw fail("REGISTRATION_CONTROL_UNAVAILABLE", 503);
  if ((await read(db.collection("storeRegistrationBlocks").doc(id))).exists)
    throw fail("REGISTRATION_UNAVAILABLE", 403);
}
module.exports = { check, emailKey, marker };
