"use strict";
const { test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { applicationFixture } = require("./helpers/application-fixture.cjs");
const endpoint = "/api/admin/store/commerce/notification-campaigns";
let f, users, records;
before(async () => {
  f = await applicationFixture({ transientStore: "memory", rateLimitStore: "memory" });
  users = structuredClone([...f.users]);
  records = structuredClone([...f.db.records]);
});
beforeEach(() => {
  f.users.clear();
  for (const [k, v] of structuredClone(users)) f.users.set(k, v);
  f.db.records.clear();
  for (const [k, v] of structuredClone(records)) f.db.records.set(k, v);
});
after(async () => {
  await f?.close();
});
function identity(f, uid, flags = {}) {
  const record = {
    uid,
    email: uid + "@zentra.invalid",
    emailVerified: true,
    disabled: false,
    ...flags,
  };
  f.users.set(uid, record);
  f.db.records.set("users/" + uid, { username: uid, storeAccountStatus: "active" });
}
const input = () => ({
  audience: "verified",
  title: "Mağaza bakım saati",
  message: "Sipariş geçmişi bakım süresince erişime kapalı olacak.",
  mode: "now",
  group: "all",
  uids: [],
  channels: { site: true, email: true },
  startsAt: 0,
  endsAt: 0,
  requestKey: randomUUID(),
});
test("all 30 verified signups receive a visible notice and one accepted and delivered email even without campaign preferences", async (t) => {
  const { auth, db } = f,
    service = require("../server/core/systemAnnouncements"),
    email = require("../server/email/service"),
    inbox = require("../server/core/customerNotificationService");
  f.users.clear();
  for (let n = 0; n < 30; n++) {
    const uid = "buyer" + n;
    identity(f, uid);
    if (n % 3 !== 1)
      db.records.set("storeCommerceProfiles/" + uid, {
        preferences:
          n % 3 === 0 ? { campaignNotifications: false, emailCampaignNotifications: false } : {},
      });
  }
  const job = await service.createDraft(input(), { uid: "owneruid" }),
    ref = db.collection("storeSystemAnnouncementJobs").doc(job.id);
  await Promise.all([service.run(), service.run()]);
  const row = (await ref.get()).data();
  assert.deepEqual([row.scanned, row.skipped, row.siteQueued, row.emailQueued], [30, 0, 30, 30]);
  const sites = await db.collection("storeNotifications").where("campaignId", "==", job.id).get();
  assert.equal(new Set(sites.docs.map((doc) => doc.data().uid)).size, 30);
  for (const uid of ["buyer0", "buyer1", "buyer2"]) {
    assert((await inbox.summary(uid)).unread >= 1);
    const list = await inbox.list(uid, 20, "", { inboxOnly: true });
    assert(
      list.notifications.some((n) => n.title === row.title),
      uid,
    );
  }
  process.env.EMAIL_NOTIFICATIONS_ENABLED = "true";
  process.env.RESEND_API_KEY = "re_" + randomUUID().replaceAll("-", "");
  const sent = new Map();
  let submissions = 0;
  const provider = async (url, req) => {
    assert.equal(new URL(url).hostname, "api.resend.com");
    if (req.method === "POST") {
      const payload = JSON.parse(req.body);
      assert.equal(payload.subject, row.title);
      const to = Array.isArray(payload.to) ? payload.to[0] : payload.to;
      assert(!sent.has(to));
      submissions++;
      const id = randomUUID();
      sent.set(to, id);
      return Response.json({ id });
    }
    const id = url.split("/").at(-1);
    assert([...sent.values()].includes(id));
    return Response.json({ id, last_event: "delivered" });
  };
  const out = await db.collection("storeEmailOutbox").where("data.campaignId", "==", job.id).get();
  for (const doc of out.docs) {
    await email.processMessage(db, doc.ref, { fetcher: provider });
    assert.equal((await doc.ref.get()).data().state, "accepted");
    await doc.ref.update({ availableAt: 0 });
    await email.processMessage(db, doc.ref, { fetcher: provider });
    assert.equal((await doc.ref.get()).data().state, "delivered");
  }
  assert.equal(submissions, 30);
  assert.equal(sent.size, 30);
  assert.equal((await service.trace(job.id, "email")).total, 30);
  assert.deepEqual((await service.trace(job.id, "email")).delivery, {
    pending: 0,
    accepted: 0,
    delivered: 30,
    attention: 0,
  });
});
test("verified-user scan resumes across pages and workers, records exclusions, and keeps the scheduled time", async (t) => {
  const s = require("../server/core/systemAnnouncements");
  f.users.clear();
  for (let n = 0; n < 85; n++) identity(f, "customer" + String(n).padStart(3, "0"));
  identity(f, "unverified", { emailVerified: false });
  identity(f, "disabled", { disabled: true });
  identity(f, "suspended");
  f.db.records.get("users/suspended").storeAccountStatus = "suspended";
  const p = { ...input(), mode: "scheduled", startsAt: Date.now() + 60000 },
    job = await s.createDraft(p, { uid: "owneruid" }),
    ref = f.db.collection("storeSystemAnnouncementJobs").doc(job.id);
  await s.run();
  assert.equal((await s.trace(job.id, "site")).total, 0);
  await ref.update({ availableAt: 1 });
  const original = f.auth.listUsers;
  f.auth.listUsers = async () => {
    throw Object.assign(Error(), { code: "auth/internal-error" });
  };
  await s.run();
  assert.equal((await ref.get()).data().state, "pending");
  assert.equal((await ref.get()).data().skipped || 0, 0);
  f.auth.listUsers = original;
  await ref.update({ availableAt: 1 });
  await s.run();
  assert.equal((await ref.get()).data().scanned, 40);
  delete require.cache[require.resolve("../server/core/systemAnnouncements")];
  const restarted = require("../server/core/systemAnnouncements");
  await Promise.all([s.run(), restarted.run()]);
  await restarted.run();
  await s.run();
  const result = (await ref.get()).data();
  assert.equal(result.state, "completed");
  assert.deepEqual(
    [result.scanned, result.siteQueued, result.emailQueued, result.skipped],
    [88, 85, 85, 3],
  );
  assert.deepEqual(result.skipReasons, { disabled: 1, suspended: 1, unverified: 1 });
  assert.equal((await restarted.trace(job.id, "site")).total, 85);
});
test("authorized recovery of a legacy zero-send job preserves its identifier and existing receipts", async (t) => {
  const session = await f.openAdmin(),
    service = require("../server/core/systemAnnouncements");
  const id = "legacy-all-skipped",
    ref = f.db.collection("storeSystemAnnouncementJobs").doc(id);
  await ref.set({
    id,
    source: "manual",
    title: "Eski duyuru",
    message: "Mağaza güncellemesi",
    state: "completed",
    revision: 1,
    skipped: 30,
    emailQueued: 0,
    siteQueued: 0,
    group: "selected",
    uids: ["member", "missing-user"],
    channels: { site: true, email: false },
    availableAt: 1,
  });
  f.db.records.set("storeCommerceProfiles/member", { preferences: { campaignNotifications: true } });
  const params = { expectedRevision: 1, state: "recover" };
  assert.equal(
    (
      await f.request(endpoint + "/" + id + "/state", {
        uid: "member",
        method: "POST",
        body: params,
      })
    ).status,
    403,
  );
  const action = await f.adminWrite(session, endpoint + "/" + id + "/state", "POST", params);
  assert.equal(action.status, 200);
  const receiptId = require("../server/commerce/common").hash("member", "system_announcement", id);
  await f.db
    .collection("storeNotifications")
    .doc(receiptId)
    .set({ uid: "member", campaignId: id, title: "Önceden okundu", readAt: 9 });
  await service.run();
  await service.setState(id, params, { uid: "owneruid" });
  await service.run();
  const final = (await ref.get()).data();
  assert.equal(final.previousSkipped, 30);
  assert.deepEqual([final.id, final.siteQueued, final.emailQueued, final.skipped], [id, 1, 0, 1]);
  assert.equal(final.skipReasons.missing, 1);
  assert.equal((await f.db.collection("storeNotifications").doc(receiptId).get()).data().readAt, 9);
  await assert.rejects(() =>
    service.setState(
      id,
      { expectedRevision: final.revision, state: "recover" },
      { uid: "owneruid" },
    ),
  );
});

test("marketing checks each channel and respects consent withdrawn after queueing", async () => {
  const service = require("../server/core/systemAnnouncements");
  const mail = require("../server/email/service");
  f.users.clear();
  for (const uid of ["site", "mail", "neither"]) identity(f, uid);
  const profiles = f.db.collection("storeCommerceProfiles");
  await profiles.doc("site").set({ preferences: { campaignNotifications: true } });
  await profiles.doc("mail").set({ preferences: { emailCampaignNotifications: true } });
  const payload = input();
  delete payload.audience;
  const job = await service.createDraft(payload, { uid: "owneruid" });
  assert.equal(job.audience, "subscribed");
  await service.run();
  assert.deepEqual((await service.trace(job.id, "site")).items.map(r => r.uid), ["site"]);
  const outbox = (await service.trace(job.id, "email")).items;
  assert.deepEqual(outbox.map(r => r.uid), ["mail"]);
  await profiles.doc("mail").set({ preferences: { emailCampaignNotifications: false } });
  process.env.EMAIL_NOTIFICATIONS_ENABLED = "true";
  process.env.RESEND_API_KEY = "re_" + randomUUID().replaceAll("-", "");
  const ref = f.db.collection("storeEmailOutbox").doc(outbox[0].id);
  await mail.processMessage(f.db, ref, { fetcher: () => assert.fail("withdrawn consent") });
  assert.equal((await ref.get()).data().state, "skipped");
});
