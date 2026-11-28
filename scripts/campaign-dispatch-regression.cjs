"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { applicationFixture } = require("./helpers/application-fixture.cjs");
const endpoint = "/api/admin/store/commerce/notification-campaigns";
const options = (mode = "now", extra = {}) => ({
  title: "Teslimat testi",
  message: "Seçilen test hesabı için bildirim.",
  mode,
  group: "selected",
  uids: ["member"],
  channels: { site: true, email: true },
  startsAt: 0,
  endsAt: 0,
  requestKey: crypto.randomUUID(),
  ...extra,
});
let f, session, campaigns, email;
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
before(async () => {
  f = await applicationFixture({ transientStore: "memory", rateLimitStore: "memory" });
  campaigns = require("../server/core/systemAnnouncements");
  email = require("../server/email/service");
  f.db.records.set("storeCommerceProfiles/member", {
    preferences: { campaignNotifications: true, emailCampaignNotifications: true },
  });
  session = await f.openAdmin();
  process.env.RESEND_API_KEY = "re_" + crypto.randomBytes(24).toString("hex");
});
after(async () => {
  await f?.close();
});
async function create(input) {
  const response = await f.adminWrite(session, endpoint, "POST", input);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.result;
}
async function channel(job, name) {
  return campaigns.trace(job.id, name);
}
async function findEmail(job) {
  await campaigns.run();
  const trace = await channel(job, "email");
  assert.equal(trace.total, 1);
  return f.db.collection("storeEmailOutbox").doc(trace.items[0].id);
}
test("immediate campaigns survive disabled email, duplicate clicks, provider throttling and retries", async () => {
  process.env.EMAIL_NOTIFICATIONS_ENABLED = "false";
  const input = options(),
    job = await create(input);
  assert.equal((await create(input)).id, job.id);
  await Promise.all([campaigns.run(), campaigns.run()]);
  const trace = await f.request(endpoint + "/" + job.id + "/trace?channel=email", session);
  assert.equal(trace.status, 200);
  assert.equal(trace.body.result.emailReady, false);
  assert.equal(trace.body.result.total, 1);
  const site = await channel(job, "site");
  assert.equal(site.total, 1);
  assert.equal(site.items[0].state, "published");
  const inbox = await f.request("/api/store/notifications?inbox=1", { uid: "member" });
  assert(inbox.body.notifications.some((n) => n.title === input.title));
  const ref = await findEmail(job),
    providerId = crypto.randomUUID(),
    calls = [];
  process.env.EMAIL_NOTIFICATIONS_ENABLED = "true";
  const fetcher = async (url, request) => {
    calls.push({ url, request });
    if (request.method === "POST")
      return calls.length === 1 ? json({}, 429) : json({ id: providerId });
    return json({ id: providerId, last_event: "delivered" });
  };
  await email.processMessage(f.db, ref, { fetcher });
  assert.equal((await ref.get()).data().state, "retry");
  await ref.update({ availableAt: 0 });
  await Promise.all([
    email.processMessage(f.db, ref, { fetcher }),
    email.processMessage(f.db, ref, { fetcher }),
  ]);
  assert.equal((await ref.get()).data().state, "accepted");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].request.body, calls[1].request.body);
  assert.equal(
    calls[0].request.headers["Idempotency-Key"],
    calls[1].request.headers["Idempotency-Key"],
  );
  await ref.update({ availableAt: 0 });
  await email.processMessage(f.db, ref, { fetcher });
  assert.equal((await channel(job, "email")).items[0].state, "delivered");
  assert.equal((await channel(job, "site")).total, 1);
});
test("scheduled jobs stay durable across a worker restart; existing inbox receipts are never overwritten", async () => {
  const at = Date.now() + 360000;
  const job = await create(options("scheduled", { startsAt: at }));
  await campaigns.run();
  assert.equal((await channel(job, "site")).total, 0);
  const ref = f.db.collection("storeSystemAnnouncementJobs").doc(job.id);
  assert.equal((await ref.get()).data().availableAt, at);
  const rowId = crypto
    .createHash("sha256")
    .update(["member", "system_announcement", job.id].join("\0"))
    .digest("hex");
  const receipt = f.db.collection("storeNotifications").doc(rowId);
  await receipt.set({ uid: "member", campaignId: job.id, createdAt: 22, read: true, readAt: 23 });
  const clock = Date.now;
  try {
    Date.now = () => at + 100;
    delete require.cache[require.resolve("../server/core/systemAnnouncements")];
    const restarted = require("../server/core/systemAnnouncements");
    await restarted.run();
    await restarted.run();
    assert.equal((await ref.get()).data().state, "completed");
    assert.equal((await receipt.get()).data().readAt, 23);
    assert.equal((await channel(job, "email")).total, 1);
  } finally {
    Date.now = clock;
  }
});
test("a lost provider response is correlated by job tag and recipient, without another send", async () => {
  const job = await create(options()),
    ref = await findEmail(job),
    id = crypto.randomUUID(),
    unrelated = crypto.randomUUID();
  let posted = 0,
    lookups = 0;
  const fetcher = async (url, request) => {
    if (request.method === "POST") {
      posted++;
      throw new Error("Response lost");
    }
    lookups++;
    if (url.includes("?"))
      return json({
        has_more: false,
        data: [unrelated, id].map((emailId) => ({
          id: emailId,
          created_at: new Date().toISOString(),
          to: ["member@zentra.invalid"],
        })),
      });
    return json({
      id: url.split("/").at(-1),
      last_event: "delivered",
      tags: [{ name: "zentra_job", value: url.endsWith(id) ? ref.id : "other" }],
    });
  };
  await email.processMessage(f.db, ref, { fetcher });
  assert.equal((await ref.get()).data().state, "verifying");
  await ref.update({ availableAt: 0 });
  await email.processMessage(f.db, ref, { fetcher });
  const row = (await ref.get()).data();
  assert.equal(row.providerId, id);
  assert.equal(row.state, "delivered");
  assert.equal(posted, 1);
  assert.equal(lookups, 3);
});
test("a completed provider lookup can retry the identical protected payload, whereas a failed lookup cannot resend", async () => {
  const job = await create(options()),
    ref = await findEmail(job),
    calls = [];
  let lookupAvailable = false;
  const fetcher = async (url, request) => {
    if (request.method === "POST") {
      calls.push(request);
      if (calls.length === 1) throw Error("Timeout");
      return json({ id: crypto.randomUUID() });
    }
    return lookupAvailable ? json({ has_more: false, data: [] }) : json({}, 403);
  };
  await email.processMessage(f.db, ref, { fetcher });
  await ref.update({ availableAt: 0 });
  await email.processMessage(f.db, ref, { fetcher });
  assert.equal((await ref.get()).data().state, "verifying");
  assert.equal(calls.length, 1);
  lookupAvailable = true;
  await ref.update({ availableAt: 0 });
  await email.processMessage(f.db, ref, { fetcher });
  assert.equal((await ref.get()).data().state, "retry");
  await ref.update({ availableAt: 0 });
  await email.processMessage(f.db, ref, { fetcher });
  assert.equal((await ref.get()).data().state, "accepted");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body, calls[1].body);
  assert.equal(calls[0].headers["Idempotency-Key"], calls[1].headers["Idempotency-Key"]);
});
test("campaign creation, tracing and dispatch enforce their distinct authority checks", async () => {
  assert.equal(
    (await f.request(endpoint, { uid: "member", method: "POST", body: options() })).status,
    403,
  );
  const job = await create(options("draft"));
  assert.equal(
    (await f.request(endpoint + "/" + job.id + "/trace", { uid: "member" })).status,
    403,
  );
  assert.equal(
    (await f.request("/internal/notifications/dispatch", { method: "POST", body: {} })).status,
    403,
  );
  process.env.EMAIL_NOTIFICATIONS_ENABLED = "false";
  process.env.NOTIFICATION_DISPATCH_SECRET = crypto.randomBytes(32).toString("hex");
  const result = await f.request("/internal/notifications/dispatch", {
    method: "POST",
    headers: { Authorization: "Bearer " + process.env.NOTIFICATION_DISPATCH_SECRET },
    body: {},
  });
  assert.equal(result.status, 200);
  assert(Number.isInteger(result.body.campaignsChecked));
  assert.equal(
    (await f.adminWrite(session, endpoint, "POST", options("scheduled", { startsAt: 1 }))).status,
    400,
  );
});
