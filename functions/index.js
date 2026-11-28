"use strict";
const {
  beforeUserCreated,
  beforeUserSignedIn,
} = require("firebase-functions/v2/identity");
const { HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { check } = require("./registry");
initializeApp();
const key = defineSecret("ACCOUNT_BLOCKLIST_KEY");
async function allowed(event) {
  try {
    await check(getFirestore(), event.data?.email);
  } catch (error) {
    throw new HttpsError(
      error.statusCode === 403 ? "permission-denied" : "unavailable",
      "Hesap işlemi tamamlanamadı.",
    );
  }
}
exports.storeBeforeCreate = beforeUserCreated({ secrets: [key] }, allowed);
exports.storeBeforeSignIn = beforeUserSignedIn({ secrets: [key] }, allowed);
