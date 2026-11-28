"use strict";
const crypto = require("node:crypto");
const { initFirebaseAdmin } = require("../config/firebaseAdmin");
const { createWorker } = require("./workerScheduler");
const { record } = require("./notificationEvents");
const { invalidateCreatedAtPageCache, indexMissing } = require("./firestorePagination");
const C = require("../commerce/common");
const collection = "storeSystemAnnouncementJobs";
const batchSize = 40;
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fingerprint = (value) =>
  hash(
    JSON.stringify({
      enabled: value.enabled === true,
      title: value.title || "",
      message: value.message || "",
    }),
  );
const byteOrder = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

function schedule(tx, db, value, previous = {}) {
  if (!value.enabled || fingerprint(value) === fingerprint(previous)) return;
  const ref = db.collection(collection).doc(crypto.randomUUID()),
    now = Date.now();
  tx.create(ref, {
    id: ref.id,
    fingerprint: fingerprint(value),
    title: value.title || "Sistem duyurusu",
    message: value.message || "",
    cursor: "",
    state: "pending",
    availableAt: now,
    createdAt: now,
  });
}

async function dueJobs(db, admin, now) {
  const pending = db.collection(collection).where("state", "==", "pending");
  try {
    return (await pending.where("availableAt", "<=", now).orderBy("availableAt").limit(3).get())
      .docs;
  } catch (error) {
    if (!indexMissing(error)) throw error;
    // Serve existing jobs even while the composite index is being built.
    const byId = pending.orderBy(admin.firestore.FieldPath.documentId()).limit(60);
    let page = await byId.get();
    for (;;) {
      const due = page.docs.filter((doc) => doc.data().availableAt <= now);
      if (due.length || page.size < 60) return due.slice(0, 3);
      page = await byId.startAfter(page.docs.at(-1).id).get();
    }
  }
}

async function processPage(db, admin, job) {
  const ref = job.ref;
  if (job.data().source === "manual")
    return require("./verifiedBroadcast").publishPage(db, ref, job.data());
  return db.runTransaction(async (tx) => {
    const row = (await tx.get(ref)).data(),
      now = Date.now();
    if (!row || row.state !== "pending" || row.availableAt > now) return 0;
    if (row.endsAt && row.endsAt <= now) {
      tx.update(ref, { state: "expired", updatedAt: now });
      return 0;
    }
    if (row.source !== "manual") {
      const settings = (await tx.get(db.collection("storefrontSettings").doc("main"))).data();
      if (fingerprint(settings?.announcement || {}) !== row.fingerprint) {
        tx.update(ref, { state: "cancelled", updatedAt: now });
        return 0;
      }
    }
    const profiles = db.collection("storeCommerceProfiles");
    let users, more;
    if (row.group === "selected") {
      const targets = [...new Set(row.uids || [])]
        .sort(byteOrder)
        .filter((uid) => !row.cursor || byteOrder(uid, row.cursor) > 0);
      users = await Promise.all(
        targets.slice(0, batchSize).map((uid) => tx.get(profiles.doc(uid))),
      );
      more = targets.length > batchSize;
    } else {
      let query = profiles.orderBy(admin.firestore.FieldPath.documentId()).limit(batchSize + 1);
      if (row.cursor) query = query.startAfter(row.cursor);
      const page = await tx.get(query);
      users = page.docs.slice(0, batchSize);
      more = page.size > batchSize;
    }
    const entries = await Promise.all(
      users.map(async (user) => {
        const prefs = user.data()?.preferences || {};
        const site = prefs.campaignNotifications === true && row.channels?.site !== false;
        const email = prefs.emailCampaignNotifications === true && row.channels?.email !== false;
        if (!site && !email) return null;
        const uid = user.id,
          key = hash([uid, "system_announcement", ref.id].join("\0"));
        const [account, inbox, outbox] = await Promise.all([
          tx.get(db.collection("users").doc(uid)),
          site ? tx.get(db.collection("storeNotifications").doc(key)) : null,
          email ? tx.get(db.collection("storeEmailOutbox").doc(key)) : null,
        ]);
        if (!account.exists || account.data()?.storeAccountStatus === "suspended") return null;
        return { uid, site: site && !inbox?.exists, email: email && !outbox?.exists };
      }),
    );
    let siteQueued = row.siteQueued || 0,
      emailQueued = row.emailQueued || 0,
      skipped = row.skipped || 0;
    for (const target of entries) {
      if (!target) {
        skipped++;
        continue;
      }
      if (!target.site && !target.email) continue;
      record(tx, db, {
        ...target,
        type: "system_announcement",
        key: ref.id,
        data: { title: row.title, message: row.message, campaignId: ref.id },
        now,
      });
      if (target.site) siteQueued++;
      if (target.email) emailQueued++;
    }
    tx.update(ref, {
      siteQueued,
      emailQueued,
      skipped,
      cursor: users.at(-1)?.id || row.cursor || "",
      state: more ? "pending" : "completed",
      updatedAt: now,
      lastError: "",
      failures: 0,
      attempts: (row.attempts || 0) + 1,
    });
    return entries.length;
  });
}

async function run() {
  const { db, admin } = initFirebaseAdmin();
  if (!db) return 0;
  const jobs = await dueJobs(db, admin, Date.now());
  for (const job of jobs) {
    try {
      await processPage(db, admin, job);
    } catch (error) {
      if (require("./workerScheduler").quotaError(error)) throw error;
      const code = String(error.code || "CAMPAIGN_PROCESS_FAILED").slice(0, 80);
      const recordedFailure = await db.runTransaction(async (tx) => {
        const row = (await tx.get(job.ref)).data();
        if (
          row?.state !== "pending" ||
          row.cursor !== job.data().cursor ||
          row.scanPage !== job.data().scanPage ||
          row.revision !== job.data().revision ||
          row.availableAt > Date.now()
        )
          return false;
        const failures = (row.failures || 0) + 1;
        tx.update(job.ref, {
          state: failures >= 6 ? "needs_review" : "pending",
          failures,
          attempts: (row.attempts || 0) + 1,
          lastError: code,
          updatedAt: Date.now(),
          availableAt: Date.now() + Math.min(600000, 2000 * 2 ** failures),
        });
        return true;
      });
      if (recordedFailure)
        require("./errorLogger").logError(error, { event: "system.announcements", source: job.id });
    }
  }
  if (jobs.length) {
    invalidateCreatedAtPageCache(collection);
    require("../email/service").wake();
  }
  return jobs.length;
}
const worker = createWorker({
  run,
  idleMs: 30000,
  onError: (error) => require("./errorLogger").logError(error, { event: "system.announcements" }),
});

async function createDraft(input, actor) {
  C.object(input, [
    "title",
    "message",
    "group",
    "uids",
    "channels",
    "audience",
    "startsAt",
    "endsAt",
    "mode",
    "requestKey",
  ]);
  const title = C.text(input.title, 120, { required: true }),
    message = C.text(input.message, 1000, { required: true }),
    group = C.choice(input.group, ["all", "selected"]);
  C.array(input.uids, 200);
  const uids = [...new Set(input.uids.map((x) => C.uid(x)))].sort(byteOrder);
  if (group === "selected" && !uids.length) C.fail("CAMPAIGN_TARGET_REQUIRED");
  C.object(input.channels, ["site", "email"]);
  const channels = { site: C.flag(input.channels.site), email: C.flag(input.channels.email) };
  const audience = C.choice(input.audience ?? "subscribed", ["subscribed", "verified"]);
  if (!channels.site && !channels.email) C.fail("CAMPAIGN_CHANNEL_REQUIRED");
  const startsAt = C.integer(input.startsAt || 0, 0, 8640000000000000),
    endsAt = C.integer(input.endsAt || 0, 0, 8640000000000000);
  const mode = C.choice(input.mode || "draft", ["draft", "now", "scheduled"]);
  const key = input.requestKey ? C.id(input.requestKey) : "";
  if (mode !== "draft" && !key) C.fail("CAMPAIGN_REQUEST_KEY_REQUIRED");
  const db = C.db(),
    ref = db
      .collection(collection)
      .doc(key ? hash([actor.uid, key].join("\0")) : crypto.randomUUID());
  const content = { title, message, group, uids, channels, startsAt, endsAt, mode };
  const signature = hash(JSON.stringify({ ...content, audience }));
  const result = await db.runTransaction(async (tx) => {
    const old = (await tx.get(ref)).data();
    if (old) {
      const replayOfOlderClient = input.audience === undefined && old.signature === hash(JSON.stringify(content));
      if (old.signature !== signature && !replayOfOlderClient) C.fail("CAMPAIGN_REQUEST_CHANGED", 409);
      return old;
    }
    const now = Date.now(),
      availableAt = mode === "now" ? now : Math.max(startsAt, now);
    if ((mode === "scheduled" && startsAt <= now) || (endsAt && endsAt <= availableAt))
      C.fail("CAMPAIGN_DATE_INVALID");
    const row = {
      id: ref.id,
      source: "manual",
      audience,
      title,
      message,
      group,
      uids,
      channels,
      availableAt,
      startsAt,
      endsAt,
      mode,
      signature,
      state: mode === "draft" ? "draft" : "pending",
      revision: 1,
      cursor: "",
      createdAt: now,
      createdBy: actor.uid,
      ...(mode !== "draft" ? { approvedBy: actor.uid } : {}),
    };
    tx.create(ref, row);
    C.audit(tx, db, "store.notification-campaign." + mode, actor, { campaignId: ref.id });
    return row;
  });
  invalidateCreatedAtPageCache(collection);
  if (result.state === "pending") worker.wake();
  return result;
}

async function setState(id, input, actor) {
  C.object(input, ["expectedRevision", "state"]);
  const requested = C.choice(input.state, ["pending", "cancelled", "recover"]),
    recover = requested === "recover",
    state = recover ? "pending" : requested,
    db = C.db(),
    ref = db.collection(collection).doc(C.id(id));
  const result = await db.runTransaction(async (tx) => {
    const row = (await tx.get(ref)).data();
    if (!row || row.source !== "manual") C.fail("CAMPAIGN_NOT_FOUND", 404);
    if (
      row.revision === input.expectedRevision + 1 &&
      (recover ? row.recoveredRevision === row.revision : row.state === state)
    )
      return row;
    C.requireRevision(row.revision, input.expectedRevision);
    if (
      (recover &&
        !(
          row.state === "completed" &&
          !row.audience &&
          row.skipped > 0 &&
          !row.siteQueued &&
          !row.emailQueued
        )) ||
      (state === "pending" && !recover && !["draft", "needs_review"].includes(row.state)) ||
      (state === "cancelled" &&
        !["draft", "pending", "completed", "needs_review"].includes(row.state))
    )
      C.fail("CAMPAIGN_STATE_INVALID", 409);
    if (state === "pending" && row.endsAt && row.endsAt <= Date.now())
      C.fail("CAMPAIGN_DATE_INVALID");
    const next = {
      ...row,
      state,
      revision: row.revision + 1,
      updatedAt: Date.now(),
      approvedBy: actor.uid,
      ...(recover
        ? {
            recoveredRevision: row.revision + 1,
            previousSkipped: row.skipped,
            audience: "subscribed",
            scanPage: 0,
            scanned: 0,
            skipped: 0,
            skipReasons: {},
            targetOffset: 0,
            authCursor: "",
            availableAt: Date.now(),
            failures: 0,
            lastError: "",
          }
        : {}),
      ...(row.state === "needs_review" ? { availableAt: Date.now(), failures: 0 } : {}),
    };
    tx.set(ref, next);
    C.audit(tx, db, "store.notification-campaign." + requested, actor, { campaignId: id });
    return next;
  });
  invalidateCreatedAtPageCache(collection);
  if (state === "pending") worker.wake();
  return result;
}
const mailGroups = {
  pending: ["queued", "retry", "sending", "verifying"],
  accepted: ["accepted", "delayed"],
  delivered: ["delivered"],
  attention: ["failed", "bounced", "complained", "suppressed", "skipped", "needs_review"],
};
async function mailTotals(db, query, page) {
  const entries = Object.entries(mailGroups);
  if (page.size <= 25)
    return Object.fromEntries(
      entries.map(([key, states]) => [
        key,
        page.docs.filter((doc) => states.includes(doc.data().state)).length,
      ]),
    );
  try {
    return await db.runTransaction(
      async (tx) =>
        Object.fromEntries(
          await Promise.all(
            entries.map(async ([key, states]) => {
              const q =
                states.length === 1
                  ? query.where("state", "==", states[0])
                  : query.where("state", "in", states);
              return [key, (await tx.get(q.count())).data().count];
            }),
          ),
        ),
      { readOnly: true },
    );
  } catch (error) {
    if (indexMissing(error)) return null;
    throw error;
  }
}
async function trace(id, channel, cursor = "") {
  const db = C.db(),
    campaignId = C.id(id);
  const job = (await db.collection(collection).doc(campaignId).get()).data();
  if (!job) C.fail("CAMPAIGN_NOT_FOUND", 404);
  C.choice(channel, ["site", "email"]);
  const cfg = require("../email/config").configuration(),
    site = channel === "site";
  const field = site ? "campaignId" : "data.campaignId",
    rows = db.collection(site ? "storeNotifications" : "storeEmailOutbox");
  let query = rows
    .where(field, "==", campaignId)
    .orderBy(initFirebaseAdmin().admin.firestore.FieldPath.documentId());
  if (cursor) query = query.startAfter(C.id(cursor));
  const [page, total] = await Promise.all([
    query.limit(26).get(),
    cursor ? null : rows.where(field, "==", campaignId).count().get(),
  ]);
  const recorded = site ? job.siteQueued || 0 : job.emailQueued || 0;
  return {
    channel,
    total: total?.data().count ?? null,
    delivery:
      !site && !cursor ? await mailTotals(db, rows.where(field, "==", campaignId), page) : null,
    recorded,
    emailReady: cfg.enabled && cfg.configured,
    worker: worker.status(),
    items: page.docs.slice(0, 25).map((doc) => {
      const row = doc.data();
      const nextAttemptAt = !site && row.availableAt < 8640000000000000 ? row.availableAt : 0;
      const waiting = ["queued", "retry", "sending", "verifying"].includes(row.state);
      const stale =
        !site && waiting && Number.isFinite(nextAttemptAt) && Date.now() - nextAttemptAt > 120000;
      const configError = !cfg.enabled
        ? "EMAIL_NOTIFICATIONS_DISABLED"
        : !cfg.configured
          ? "EMAIL_NOT_CONFIGURED"
          : "";
      return {
        id: doc.id,
        uid: row.uid,
        state: site ? "published" : row.state,
        stale,
        attempts: site ? 1 : row.attempts || 0,
        failureCode: row.failureCode || (!site && waiting ? configError : ""),
        nextAttemptAt,
        updatedAt: row.updatedAt || row.publishedAt || row.createdAt || 0,
        providerId: row.providerId || "",
      };
    }),
    nextCursor: page.size > 25 ? page.docs[24].id : "",
  };
}
module.exports = { schedule, run, worker, createDraft, setState, trace };
