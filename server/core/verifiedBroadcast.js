"use strict";
const { initFirebaseAdmin } = require("../config/firebaseAdmin");
const { record } = require("./notificationEvents");
const { hash } = require("../commerce/common");

const PAGE_SIZE = 40;
function identityReason(user) {
  if (!user) return "missing";
  if (user.disabled) return "disabled";
  if (user.emailVerified !== true) return "unverified";
  if (typeof user.email !== "string" || !user.email.trim()) return "address";
  if (!user.uid || /[\/\\\x00-\x1f]/.test(user.uid) || [".", ".."].includes(user.uid))
    return "identity";
  return "";
}
async function pageFor(auth, row) {
  if (row.group !== "selected") {
    const { users, pageToken } = await auth.listUsers(PAGE_SIZE, row.authCursor || undefined);
    return { users: users.map((user) => ({ uid: user.uid, user })), next: pageToken || "" };
  }
  const targets = row.uids.slice(row.targetOffset || 0, (row.targetOffset || 0) + PAGE_SIZE);
  if (!targets.length) return { users: [], next: "" };
  const result = await auth.getUsers(targets.map((uid) => ({ uid })));
  const accounts = new Map(result.users.map((user) => [user.uid, user]));
  return {
    users: targets.map((uid) => ({ uid, user: accounts.get(uid) })),
    next: (row.targetOffset || 0) + targets.length < row.uids.length ? "selected" : "",
  };
}

async function publishPage(db, ref, original) {
  const { auth } = initFirebaseAdmin();
  if (!auth) throw Object.assign(new Error("AUTH_UNAVAILABLE"), { code: "AUTH_UNAVAILABLE" });
  const page = await pageFor(auth, original);
  return db.runTransaction(async (tx) => {
    const row = (await tx.get(ref)).data(),
      now = Date.now();
    if (
      row?.state !== "pending" ||
      row.availableAt > now ||
      row.revision !== original.revision ||
      (row.scanPage || 0) !== (original.scanPage || 0)
    )
      return 0;
    if (row.endsAt && row.endsAt <= now) {
      tx.update(ref, { state: "expired", updatedAt: now });
      return 0;
    }
    const audience = row.audience === "verified" ? "verified" : "subscribed";
    const channels = row.channels || { site: true, email: true };
    const reasons = { ...(row.scanPage ? row.skipReasons : {}) };
    let skipped = row.scanPage ? row.skipped || 0 : 0;
    let siteQueued = row.scanPage ? row.siteQueued || 0 : 0;
    let emailQueued = row.scanPage ? row.emailQueued || 0 : 0;
    const targets = await Promise.all(
      page.users.map(async ({ uid, user }) => {
        const reason = identityReason(user);
        if (reason) return { reason };
        const key = hash(uid, "system_announcement", ref.id);
        const [account, profile] = await Promise.all([
          tx.get(db.collection("users").doc(uid)),
          audience === "subscribed" ? tx.get(db.collection("storeCommerceProfiles").doc(uid)) : null,
        ]);
        if (account.data()?.storeAccountStatus === "suspended") return { reason: "suspended" };
        const prefs = profile?.data()?.preferences || {};
        const site = channels.site && (audience === "verified" || prefs.campaignNotifications === true);
        const email = channels.email && (audience === "verified" || prefs.emailCampaignNotifications === true);
        if (!site && !email) return { reason: "preferences" };
        const [inbox, outbox] = await Promise.all([
          site ? tx.get(db.collection("storeNotifications").doc(key)) : null,
          email ? tx.get(db.collection("storeEmailOutbox").doc(key)) : null,
        ]);
        return { uid, site: site && !inbox?.exists, email: email && !outbox?.exists, countSite: site, countEmail: email };
      }),
    );
    for (const target of targets) {
      if (target.reason) {
        skipped++;
        reasons[target.reason] = (reasons[target.reason] || 0) + 1;
        continue;
      }
      if (target.site || target.email)
        record(tx, db, {
          ...target,
          type: "system_announcement",
          key: ref.id,
          data: {
            title: row.title,
            message: row.message,
            campaignId: ref.id,
            audience,
          },
          now,
        });
      if (target.countSite) siteQueued++;
      if (target.countEmail) emailQueued++;
    }
    tx.update(ref, {
      audience,
      scanPage: (row.scanPage || 0) + 1,
      scanned: (row.scanPage ? row.scanned || 0 : 0) + targets.length,
      siteQueued,
      emailQueued,
      skipped,
      skipReasons: reasons,
      authCursor: row.group === "selected" ? "" : page.next,
      targetOffset: (row.targetOffset || 0) + targets.length,
      state: page.next ? "pending" : "completed",
      failures: 0,
      attempts: (row.attempts || 0) + 1,
      lastError: "",
      updatedAt: now,
    });
    return targets.length;
  });
}
module.exports = { publishPage };
