"use strict";
const crypto = require("node:crypto");
const { initFirebaseAdmin } = require("../config/firebaseAdmin");
const sessionKey = decoded => /^[A-Za-z0-9_-]{24,80}$/.test(decoded?.zentraSessionId || "") ? "s:"+decoded.zentraSessionId : "a:"+Math.trunc(Number(decoded?.auth_time || 0)*1000);
const key = (uid, value) => crypto.createHash("sha256").update(uid + "\0" + (typeof value === "number" ? "a:"+Math.trunc(value) : value)).digest("hex");
async function assertAccess(decoded) {
  const { db } = initFirebaseAdmin();
  if (!db) throw Object.assign(new Error("AUTH_UNAVAILABLE"), { code: "AUTH_UNAVAILABLE", statusCode: 503 });
  const authTime = Number(decoded.auth_time || 0) * 1000;
  const revoked = (await db.collection("storeCustomerAuthRevocations").doc(key(decoded.uid, sessionKey(decoded))).get()).data();
  if(revoked && !revoked.alertedAt) await db.runTransaction(async tx=>{
    const ref=db.collection("storeCustomerAuthRevocations").doc(key(decoded.uid,authTime)),row=(await tx.get(ref)).data();
    if(row && !row.alertedAt){tx.update(ref,{alertedAt:Date.now()});require("./notificationEvents").record(tx,db,{uid:decoded.uid,type:"suspicious_login",key:ref.id,data:{message:"Sonlandırılan bir oturumla hesabınıza erişim denemesi engellendi."}});}
  });
  if (revoked) throw Object.assign(new Error("AUTH_INVALID"), { code: "AUTH_INVALID", statusCode: 401 });
}
module.exports = { key, sessionKey, assertAccess };
