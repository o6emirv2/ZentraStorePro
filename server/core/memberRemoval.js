"use strict";
const crypto = require("node:crypto");
const C = require("../commerce/common");
const { initFirebaseAdmin } = require("../config/firebaseAdmin");
const { protectTarget, audit, field } = require("./memberControl");
const registry = require("../../functions/registry");
const { readStoredBalance, checkedBalance } = require("./storeMoney");
const { createWorker } = require("./workerScheduler");
const jobs = "storeAccountRemovalJobs",
  limit = 40,
  forever = 8640000000000000;
const erase = [
  ["storeMemberNoticePreviews", "uid"],
  ["storeRemovalConfirmations", "uid"],
  ["storeCommerceProfiles", "doc"],
  ["storeAccountVerifications", "doc"],
  ["storeEmailVerificationChallenges", "uid"],
  ["storeCustomerSessions", "uid"],
  ["storeCustomerAuthSessions", "uid"],
  ["storeCustomerAuthRevocations", "uid"],
  ["storeUserNotifications", "uid"],
  ["storeNotifications", "uid"],
  ["storeCommerceNotificationReceipts", "uid"],
  ["storeProductWatches", "uid"],
  ["storeRestockSubscriptions", "uid"],
  ["storeEmailOutbox", "uid"],
  ["storeAnalyticsEvents", "uid"],
  ["storeReviewParticipation", "uid"],
  ["storeReviewReplies", "uid"],
  ["storeReviews", "uid"],
  ["storeProductReactions", "actor"],
  ["storeProductReactionReceipts", "uid"],
  ["storeAccountRecoveryRequests", "uid"],
  ["storeAccountRecoveryTokens", "uid"],
  ["storeAccountRecoveryHeads", "doc"],
  ["storeAccountRecoverySendLocks", "doc"],
  ["storeMemberModerationIntents", "doc"],
  ["usernameRegistry", "uid"],
  ["storeSupportAttachments", "uid"],
  ["storeSupportTickets", "uid"],
  ["storeDataRequests", "uid"],
  ["storeReservationOwners", "uid"],
  ["storeAdminFactors", "doc"],
  ["adminUsers", "doc"],
  ["storeInternalUserNotes", "doc"],
  ["storeCustomerSessionRevocations", "doc"],
  ["users", "doc"],
];
const retained = [
  "storeOrders",
  "storeOrderArchives",
  "storeWalletLedger",
  "storeWalletAdjustments",
  "storeWalletRequests",
  "storeBalanceCodeRedemptions",
  "storeDeliveries",
  "storeMemberStatusHistory",
];
const idHash = (s) => crypto.createHash("sha256").update(s).digest("hex");
function source(db, name, uid, mode) {
  const base = db.collection(name);
  return mode === "doc"
    ? base.doc(uid)
    : base.where(mode, "==", mode === "actor" ? "member:" + C.hash(uid) : uid);
}
async function count(read, query) {
  const s = await read(query.count());
  return s.data().count;
}
async function obligations(db, uid, read = (ref) => ref.get()) {
  const [profile, orders, requests, reservations, refunds, holds] =
    await Promise.all([
      read(db.collection("users").doc(uid)),
      read(db.collection("storeOrders").where("uid", "==", uid)),
      read(
        db
          .collection("storeWalletRequests")
          .where("uid", "==", uid)
          .where("status", "==", "pending")
          .limit(1),
      ),
      read(db.collection("storeReservations").where("uid", "==", uid)),
      read(db.collection("storeCustomerRequests").where("uid", "==", uid)),
      read(
        db
          .collection("storeSecurityHolds")
          .where("uid", "==", uid)
          .where("active", "==", true)
          .limit(1),
      ),
    ]);
  const row = profile.data() || {},
    reasons = [];
  if (readStoredBalance(row) > 0)
    reasons.push("Kullanılabilir veya ayrılmış bakiye bulunuyor");
  if (checkedBalance(row.storeBalanceHeldKurus || 0) > 0)
    reasons.push("Bloke bakiye bulunuyor");
  if (checkedBalance(row.storeWalletDebtKurus || 0) > 0)
    reasons.push("İade nedeniyle kapatılacak tutar bulunuyor");
  if (
    orders.docs.some((d) => {
      const o = d.data();
      return (
        !["delivered", "cancelled", "payment_rejected", "refunded"].includes(
          o.status,
        ) ||
        ["pending", "processing", "requested"].includes(o.refundStatus) ||
        ["pending", "processing", "awaiting_payment", "reserved"].includes(
          o.paymentState,
        ) ||
        (o.status === "delivered" &&
          o.delivery?.status &&
          o.delivery.status !== "delivered")
      );
    })
  )
    reasons.push("Açık sipariş, teslimat, ödeme veya iade var");
  if (
    !requests.empty ||
    refunds.docs.some((d) =>
      ["open", "pending", "processing", "approved"].includes(d.data().status),
    )
  )
    reasons.push("Açık mali talep bulunuyor");
  if (
    reservations.docs.some((d) =>
      ["active", "held"].includes(d.data().status || d.data().state),
    )
  )
    reasons.push("Açık ürün rezervasyonu var");
  if (
    !holds.empty ||
    row.storeSecurityHold === true ||
    ["under_review", "security_locked"].includes(row.storeAccountStatus)
  )
    reasons.push("Güvenlik incelemesi açık");
  if (row.storeModerationIntent)
    reasons.push("Hesap durumu değişikliği sürüyor");
  return reasons;
}
async function providerReady() {
  const { app } = initFirebaseAdmin(),
    project = app?.options?.projectId;
  if (!project || !app?.options?.credential)
    C.fail("REGISTRATION_HOOK_UNVERIFIED", 503);
  const expected = [
    process.env.ACCOUNT_BLOCKING_CREATE_URL,
    process.env.ACCOUNT_BLOCKING_SIGNIN_URL,
  ];
  if (
    expected.some(
      (v) =>
        typeof v !== "string" ||
        !/^https:\/\/[a-z0-9.-]+\.(?:cloudfunctions\.net|run\.app)(?:\/[A-Za-z0-9_-]+)?$/.test(
          v,
        ),
    )
  )
    C.fail("REGISTRATION_HOOK_UNVERIFIED", 503);
  const { access_token } = await app.options.credential.getAccessToken();
  const res = await fetch(
    "https://identitytoolkit.googleapis.com/admin/v2/projects/" +
      encodeURIComponent(project) +
      "/config",
    {
      headers: { Authorization: "Bearer " + access_token },
      signal: AbortSignal.timeout(7000),
    },
  );
  if (!res.ok) C.fail("REGISTRATION_HOOK_UNVERIFIED", 503);
  const triggers = (await res.json()).blockingFunctions?.triggers;
  if (
    [
      triggers?.beforeCreate?.functionUri,
      triggers?.beforeSignIn?.functionUri,
    ].some((v, i) => v !== expected[i])
  )
    C.fail("REGISTRATION_HOOK_UNVERIFIED", 503);
}
async function preview(uid, mode, actor, session) {
  C.choice(mode, ["delete", "ban"]);
  await protectTarget(uid, actor);
  const { auth, db } = initFirebaseAdmin(),
    user = await auth.getUser(uid);
  const [blockers, personal, financial] = await Promise.all([
    obligations(db, uid),
    Promise.all(
      erase.map(async ([name, mode]) => {
        const q = source(db, name, uid, mode);
        return {
          name,
          count:
            mode === "doc"
              ? Number((await q.get()).exists)
              : await count((q) => q.get(), q),
        };
      }),
    ),
    Promise.all(
      retained.map(async (name) => ({
        name,
        count: await count(
          (q) => q.get(),
          db
            .collection(name)
            .where(
              name === "storeOrderArchives" ? "order.uid" : "uid",
              "==",
              uid,
            ),
        ),
      })),
    ),
  ]);
  const token = crypto.randomBytes(32).toString("base64url"),
    expiresAt = Date.now() + 180000;
  if (!blockers.length)
    await db
      .collection("storeRemovalConfirmations")
      .doc(idHash(token))
      .set({
        uid,
        actor: actor.uid,
        session,
        mode,
        expiresAt,
        purgeAfter: new Date(expiresAt + 86400000),
        emailHash: require("../email/config").addressHash(user.email),
        used: false,
      });
  return {
    uid,
    email: user.email,
    mode,
    personal,
    financial,
    blockers,
    expiresAt,
    token: blockers.length ? "" : token,
  };
}
async function start(uid, input, actor, session) {
  C.object(input, ["mode", "token", "totp", "reason"]);
  const mode = C.choice(input.mode, ["delete", "ban"]),
    reason = field(input.reason, 350);
  if (reason.length < 5) C.fail("MEMBER_REASON_REQUIRED", 400);
  await protectTarget(uid, actor);
  const { db, auth } = initFirebaseAdmin();
  const confirmation = db
      .collection("storeRemovalConfirmations")
      .doc(idHash(C.id(input.token))),
    claim = (await confirmation.get()).data();
  const valid = (c) =>
    c &&
    !c.used &&
    c.uid === uid &&
    c.actor === actor.uid &&
    c.session === session &&
    c.mode === mode &&
    c.expiresAt > Date.now();
  if (!valid(claim)) C.fail("MEMBER_CONFIRMATION_INVALID", 409);
  const user = await auth.getUser(uid);
  if (require("../email/config").addressHash(user.email) !== claim.emailHash)
    C.fail("MEMBER_CONFIRMATION_INVALID", 409);
  if (mode === "ban") {
    registry.emailKey(user.email);
    await providerReady();
  }
  const proof = await require("./adminTotpService").verifyAdminTotp({
    uid: actor.uid,
    code: input.totp,
  });
  if (!proof.verified || proof.replayed) C.fail("ADMIN_TOTP_REQUIRED", 403);
  const ref = db.collection(jobs).doc(uid),
    policy = db.collection("storeRegistrationPolicy").doc("current");
  await db.runTransaction(async (tx) => {
    const [fresh, old, settings, reasons] = await Promise.all([
      tx.get(confirmation),
      tx.get(ref),
      tx.get(policy),
      obligations(db, uid, (q) => tx.get(q)),
    ]);
    if (!valid(fresh.data()) || old.exists)
      C.fail("MEMBER_CONFIRMATION_INVALID", 409);
    if (reasons.length) C.fail("MEMBER_FINANCIAL_OR_SECURITY_HOLD", 409);
    const now = Date.now(),
      reference = crypto.randomUUID();
    if (mode === "ban") {
      const key = process.env.ACCOUNT_BLOCKLIST_KEY,
        keyId = registry.marker(key);
      if (settings.data()?.active && settings.data().keyId !== keyId)
        C.fail("REGISTRATION_CONTROL_UNAVAILABLE", 503);
      tx.set(policy, { active: true, keyId }, { merge: true });
      tx.set(
        db
          .collection("storeRegistrationBlocks")
          .doc(registry.emailKey(user.email)),
        { createdAt: now, actor: actor.uid, reference, reason, uid },
      );
    }
    tx.update(confirmation, { used: true });
    tx.set(
      db.collection("users").doc(uid),
      { storeDeletionId: reference },
      { merge: true },
    );
    tx.create(ref, {
      uid,
      reference,
      mode,
      actor: actor.uid,
      state: "pending",
      step: 0,
      createdAt: now,
      availableAt: now,
      removed: 0,
      attempts: 0,
      banId: mode === "ban" ? registry.emailKey(user.email) : "",
      emailHash: fresh.data().emailHash,
    });
    audit(tx, db, "store.user.removal.authorized", actor, uid, {
      mode,
      reason,
      reference,
    });
  });
  worker.wake();
  return publicJob((await ref.get()).data());
}
function publicJob(r) {
  if (!r) return null;
  return {
    id: r.reference,
    mode: r.mode,
    state: r.state,
    step: r.step,
    totalSteps: erase.length + 2,
    removed: r.removed || 0,
    lastError: r.lastError || "",
    attempts: r.attempts || 0,
    updatedAt: r.updatedAt || r.createdAt,
  };
}
async function removePage(db, ref, job) {
  const [name, mode] = erase[job.step - 1],
    q = source(db, name, job.uid, mode);
  if (name === "storeSupportAttachments") {
    const page = await q.limit(limit).get();
    for (const d of page.docs) {
      const row = d.data(),
        ticket = C.id(row.ticketId),
        id = C.id(d.id);
      const { admin, app } = initFirebaseAdmin(),
        file = admin
          .storage(app)
          .bucket()
          .file("support/" + job.uid + "/" + ticket + "/" + id);
      await file.delete({ ignoreNotFound: true });
      if ((await file.exists())[0])
        C.fail("MEMBER_STORAGE_CLEANUP_INCOMPLETE", 503);
    }
    const allowed = new Set(page.docs.map((d) => d.id));
    return db.runTransaction(async (tx) => {
      const live = (await tx.get(ref)).data();
      if (live.step !== job.step || live.state !== "pending") return;
      const confirmed = await tx.get(q.limit(limit));
      if (confirmed.docs.some((d) => !allowed.has(d.id))) return;
      for (const d of confirmed.docs) tx.delete(d.ref);
      tx.update(ref, {
        step: job.step + (confirmed.size < limit ? 1 : 0),
        removed: live.removed + confirmed.size,
        updatedAt: Date.now(),
      });
    });
  }
  return db.runTransaction(async (tx) => {
    const current = (await tx.get(ref)).data();
    if (current.state !== "pending" || current.step !== job.step) return;
    const snap = await tx.get(mode === "doc" ? q : q.limit(limit));
    const docs = mode === "doc" ? (snap.exists ? [snap] : []) : snap.docs;
    const counters = new Map();
    for (const doc of docs) {
      const d = doc.data(),
        id =
          name === "storeProductReactions" && d.liked
            ? ["storeProductCommunity", d.productId, "likes"]
            : name === "storeReviewReplies"
              ? ["storeReviews", d.reviewId, "replyCount"]
              : null;
      if (id && id[1]) {
        const key = id[0] + "/" + id[1],
          prior = counters.get(key);
        if (prior) prior.delta++;
        else {
          const r = db.collection(id[0]).doc(id[1]),
            data = (await tx.get(r)).data();
          counters.set(key, { r, data, field: id[2], delta: 1 });
        }
      }
    }
    async function leaves(parent, ancestors = 0) {
      if (ancestors > 100) C.fail("MEMBER_NESTED_DATA_INVALID", 409);
      for (const child of await parent.listCollections()) {
        const refs = await child.listDocuments(),
          targets = [];
        for (const entry of refs) {
          const deeper = await leaves(entry, ancestors + 1);
          if (deeper.length) return deeper;
          if ((await tx.get(entry)).exists) targets.push(entry);
          if (targets.length >= limit) break;
        }
        if (targets.length) return targets;
      }
      return [];
    }
    for (const parent of mode === "doc" ? [q] : docs.map((d) => d.ref)) {
      const nested = await leaves(parent);
      if (nested.length) {
        for (const entry of nested) tx.delete(entry);
        tx.update(ref, {
          removed: current.removed + nested.length,
          updatedAt: Date.now(),
        });
        return;
      }
    }
    for (const c of counters.values())
      if (c.data)
        tx.update(c.r, {
          [c.field]: Math.max(0, (c.data[c.field] || 0) - c.delta),
        });
    for (const doc of docs) {
      if (name === "storeReviews") {
        const d = doc.data();
        tx.set(doc.ref, {
          productId: d.productId,
          rating: d.rating || 0,
          title: "Silinen hesap",
          message: "Bu değerlendirme sahibinin hesabı silindi.",
          createdAt: d.createdAt || 0,
          replyCount: d.replyCount || 0,
          status: d.status || "hidden",
          verifiedPurchase: d.verifiedPurchase === true,
        });
      } else tx.delete(doc.ref);
    }
    tx.update(ref, {
      step: job.step + (docs.length < limit ? 1 : 0),
      removed: current.removed + docs.length,
      updatedAt: Date.now(),
      lastError: "",
    });
  });
}
async function processJob(ref) {
  const { db, auth } = initFirebaseAdmin(),
    job = (await ref.get()).data();
  if (!job || job.state !== "pending") return;
  if (job.step === 0) {
    if ((await obligations(db, job.uid)).length)
      C.fail("MEMBER_FINANCIAL_OR_SECURITY_HOLD", 409);
    if (
      job.banId &&
      (
        await db.collection("storeRegistrationBlocks").doc(job.banId).get()
      ).data()?.reference !== job.reference
    )
      C.fail("MEMBER_BLOCK_NOT_CONFIRMED", 409);
    const u = await auth.getUser(job.uid);
    if (require("../email/config").addressHash(u.email) !== job.emailHash)
      C.fail("MEMBER_IDENTITY_CHANGED", 409);
    await auth.updateUser(job.uid, { disabled: true });
    await auth.revokeRefreshTokens(job.uid);
    await require("./adminSessionRegistry").revokeAdminSessionsForUser(job.uid);
    if (!(await auth.getUser(job.uid)).disabled)
      C.fail("MEMBER_AUTH_SYNC_PENDING", 503);
  } else if (job.step <= erase.length) {
    await removePage(db, ref, job);
    return;
  } else {
    const person = db.collection("users").doc(job.uid);
    if ((await person.get()).exists) C.fail("MEMBER_CLEANUP_INCOMPLETE", 409);
    try {
      const u = await auth.getUser(job.uid);
      if (
        !u.disabled ||
        require("../email/config").addressHash(u.email) !== job.emailHash
      )
        C.fail("MEMBER_IDENTITY_CHANGED", 409);
      await auth.deleteUser(job.uid);
    } catch (error) {
      if (error.code !== "auth/user-not-found") throw error;
    }
    try {
      await auth.getUser(job.uid);
      C.fail("MEMBER_AUTH_REMOVAL_INCOMPLETE", 503);
    } catch (error) {
      if (error.code !== "auth/user-not-found") throw error;
    }
  }
  await db.runTransaction(async (tx) => {
    const cur = (await tx.get(ref)).data();
    if (cur.step !== job.step || cur.state !== "pending") return;
    const end = job.step > erase.length;
    tx.update(ref, {
      step: job.step + 1,
      attempts: 0,
      updatedAt: Date.now(),
      state: end ? "completed" : "pending",
      availableAt: end ? forever : Date.now(),
      lastError: "",
    });
    if (end)
      audit(
        tx,
        db,
        "store.user.removal.completed",
        { uid: job.actor },
        job.uid,
        { reference: job.reference, removed: job.removed },
      );
  });
}
async function run() {
  const { db } = initFirebaseAdmin();
  if (!db) return 0;
  const due = await db
    .collection(jobs)
    .where("availableAt", "<=", Date.now())
    .orderBy("availableAt")
    .limit(3)
    .get();
  for (const d of due.docs) {
    try {
      await processJob(d.ref);
    } catch (err) {
      await db.runTransaction(async (tx) => {
        const row = (await tx.get(d.ref)).data();
        if (row.state !== "pending" || row.step !== d.data().step) return;
        const attempts = (row.attempts || 0) + 1;
        tx.update(d.ref, {
          attempts,
          state: attempts >= 8 ? "needs_review" : "pending",
          lastError: String(err.code || "REMOVAL_FAILED").slice(0, 100),
          availableAt:
            attempts >= 8
              ? forever
              : Date.now() + Math.min(120000, 1000 * 2 ** attempts),
        });
      });
    }
  }
  return due.size;
}
async function resume(uid, actor) {
  const db = C.db(),
    ref = db.collection(jobs).doc(C.uid(uid));
  await db.runTransaction(async (tx) => {
    const row = (await tx.get(ref)).data();
    if (row?.state !== "needs_review") C.fail("MEMBER_JOB_NOT_PAUSED", 409);
    tx.update(ref, { state: "pending", availableAt: Date.now(), attempts: 0 });
    audit(tx, db, "store.user.removal.retry", actor, uid, {
      reference: row.reference,
    });
  });
  worker.wake();
  return publicJob((await ref.get()).data());
}
async function unblock(id, code, actor) {
  const db = C.db(),
    ref = db.collection("storeRegistrationBlocks").doc(C.id(id));
  const proof = await require("./adminTotpService").verifyAdminTotp({
    uid: actor.uid,
    code,
  });
  if (!proof.verified || proof.replayed) C.fail("ADMIN_TOTP_REQUIRED", 403);
  await db.runTransaction(async (tx) => {
    const row = (await tx.get(ref)).data();
    if (!row) C.fail("MEMBER_BLOCK_NOT_FOUND", 404);
    const job = (await tx.get(db.collection(jobs).doc(row.uid))).data();
    if (job && job.state !== "completed")
      C.fail("MEMBER_DELETION_IN_PROGRESS", 409);
    tx.delete(ref);
    audit(tx, db, "store.registration.unblocked", actor, row.uid, {
      reference: row.reference,
    });
  });
  return { removed: true };
}
const worker = createWorker({
  run,
  idleMs: 60000,
  activeMs: 300,
  onError: (err) =>
    require("./errorLogger").logError(err, { event: "member.removal" }),
});
module.exports = {
  obligations,
  preview,
  start,
  publicJob,
  processJob,
  resume,
  unblock,
  run,
  worker,
  erase,
  retained,
};
