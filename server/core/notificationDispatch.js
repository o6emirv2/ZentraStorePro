"use strict";
const crypto = require("node:crypto");
const digest = (value) => crypto.createHash("sha256").update(value).digest();
let running;
function authorized(header, secret = process.env.NOTIFICATION_DISPATCH_SECRET) {
  if (
    typeof secret !== "string" ||
    secret.length < 32 ||
    typeof header !== "string" ||
    !header.startsWith("Bearer ") ||
    header.length > 1024
  )
    return false;
  return crypto.timingSafeEqual(digest(secret), digest(header.slice(7)));
}
async function dispatch(req, res, next) {
  res.setHeader("Cache-Control", "no-store");
  if (!authorized(req.get("authorization")))
    return res.status(403).json({ ok: false, code: "DISPATCH_FORBIDDEN" });
  if (!require("../config/firebaseAdmin").initFirebaseAdmin().db)
    return res.status(503).json({ ok: false, code: "STORE_STORAGE_UNAVAILABLE" });
  try {
    if (!running)
      running = (async () => {
        const [campaigns, invitations] = await Promise.allSettled([
          require("./systemAnnouncements").run(),
          require("../commerce/reviewInvitations").run(),
        ]);
        const emailJobs = await require("../email/service").run();
        if (campaigns.status === "rejected") throw campaigns.reason;
        if (invitations.status === "rejected") throw invitations.reason;
        return { campaignsChecked: campaigns.value, invitationsChecked: invitations.value, emailJobsChecked: emailJobs };
      })().finally(() => {
        running = null;
      });
    res.json({ ok: true, ...(await running) });
  } catch (error) {
    next(error);
  }
}
module.exports = { authorized, dispatch };
