"use strict";
const { initFirebaseAdmin } = require("../config/firebaseAdmin");
const MESSAGE = "Daha iyi bir alışveriş deneyimi için mağazamızda bakım yapıyoruz. Lütfen kısa bir süre sonra yeniden deneyin.";

// Read only public status fields. No catalogue cache: changes work across instances.
async function readStatus() {
  const { db } = initFirebaseAdmin();
  if (!db) throw Object.assign(new Error("STORE_STORAGE_UNAVAILABLE"), { code: "STORE_STORAGE_UNAVAILABLE", statusCode: 503 });
  const [store, commerce] = await Promise.all([
    db.collection("storefrontSettings").doc("main").get(),
    db.collection("storeCommerceSettings").doc("main").get(),
  ]);
  const a = store.data() || {}, b = commerce.data() || {};
  return {
    maintenance: a.maintenance === true || b.maintenance?.catalog === true,
    message: typeof b.maintenance?.message === "string" && b.maintenance.message.trim() ? b.maintenance.message.trim().slice(0, 240) : MESSAGE,
    checkedAt: Date.now(),
  };
}

// Concurrent storefront polls share only an in-flight read. Completed results never mask an admin change.
let pendingStatus;
function status() {
  if (!pendingStatus) pendingStatus = readStatus().finally(() => { pendingStatus = undefined; });
  return pendingStatus;
}
async function publicStatus(req, res, next) {
  try {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.json({ ok: true, ...(await status()) });
  } catch (error) { next(error); }
}

async function protectMutations(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (!req.headers.authorization && !req.headers.cookie) return next();
  if (!initFirebaseAdmin().db) return next();
  try {
    if ((await readStatus()).maintenance) {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Retry-After", "5");
      return res.status(503).json({ ok: false, error: "STORE_MAINTENANCE_ACTIVE" });
    }
    next();
  } catch (error) { next(error); }
}
module.exports = { MESSAGE, status, publicStatus, protectMutations };
