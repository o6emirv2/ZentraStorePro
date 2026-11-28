"use strict";
const { test, before, after } = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const { applicationFixture } = require("./helpers/application-fixture.cjs");
let f, owner;
const prefix = "/api/admin/store/members";
before(async () => {
  f = await applicationFixture({
    transientStore: "memory",
    rateLimitStore: "memory",
  });
  owner = await f.openAdmin();
});
after(async () => {
  await f?.close();
});
const get = async (path, session = owner) => f.request(path, session);
const post = async (path, body) =>
  f.request(path, { ...owner, method: "POST", body });
function ok(r) {
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
async function make(uid, profile = {}) {
  f.users.set(uid, {
    uid,
    email: uid + "@zentra.invalid",
    emailVerified: true,
    disabled: false,
    generation: 0,
    password: f.password,
  });
  await f.db
    .collection("users")
    .doc(uid)
    .set({
      username: uid,
      storeAccountStatus: "active",
      storeBalanceKurus: 0,
      ...profile,
    });
}
test("authorized account facts use full Auth identity, true delivery and captured funds", async () => {
  await make("buyer");
  for (const [id, extra] of [
    [
      "delivered",
      {
        status: "delivered",
        paymentState: "paid",
        paidAt: 10,
        delivery: { status: "delivered", deliveredAt: 25 },
        updatedAt: 10000,
      },
    ],
    ["pending", { status: "pending", paymentState: "pending" }],
    ["failed", { status: "failed", paymentState: "rejected" }],
  ])
    await f.db
      .collection("storeOrders")
      .doc(id)
      .set({
        uid: "buyer",
        paymentMethod: "wallet",
        totalKurus: 550,
        createdAt: 1,
        ...extra,
      });
  const row = ok(
    await get("/api/admin/store/users/resolve?identifier=buyer"),
  ).user;
  assert.equal(row.uid, "buyer");
  assert.equal(row.email, "buyer@zentra.invalid");
  assert.equal(row.emailVerified, true);
  assert.equal(row.totalSpendKurus, 550);
  assert.equal(row.orderCount, 3);
  assert.equal(row.lastDeliveryAt, 25);
  const denied = await get("/api/admin/store/users/resolve?identifier=buyer", {
    uid: "member",
  });
  assert.ok(denied.status >= 400);
  assert.ok(!JSON.stringify(denied.body).includes("buyer@zentra.invalid"));
});
test("moderation, optimistic saving and separate audited private note travel through protected API", async () => {
  await make("changes");
  const path = "/api/admin/store/users/changes";
  const fresh = ok(
    await f.adminWrite(owner, path, "PATCH", {
      status: "purchase_blocked",
      adminNote: "Yalnız yönetim okuyabilir",
      expectedRevision: 0,
    }),
  ).user;
  assert.equal(fresh.accountStatus, "purchase_blocked");
  assert.equal(fresh.revision, 1);
  assert.equal(
    (
      await f.db.collection("storeInternalUserNotes").doc("changes").get()
    ).data().updatedBy,
    owner.uid,
  );
  assert.ok(
    !(await f.db.collection("users").doc("changes").get()).data()
      .storeAdminNote,
  );
  assert.ok(
    (
      await f.adminWrite(owner, path, "PATCH", {
        status: "active",
        adminNote: "Farklı",
        expectedRevision: 0,
      })
    ).status >= 400,
  );
  const events = ok(await get(prefix + "/changes/activity")).result.items;
  assert.ok(events.some((x) => x.action === "store.user.update"));
  const policy = require("../server/core/memberControl");
  assert.equal(
    policy.permitsRequest(
      { storeAccountStatus: "purchase_blocked" },
      { method: "POST", path: "/api/store/orders" },
    ),
    false,
  );
  assert.equal(
    policy.permitsRequest(
      { storeAccountStatus: "purchase_blocked" },
      { method: "POST", path: "/api/store/commerce/tickets" },
    ),
    true,
  );
});
test("13 notice templates require preview, verify transition, never copy the private note and deduplicate", async () => {
  const list = ok(await get(prefix + "/templates")).result;
  assert.equal(new Set(list.map((t) => t.id)).size, 13);
  const root = prefix + "/changes/notice/";
  assert.ok(
    (await post(root + "preview", { template: "reopened", reason: "Gerekçe" }))
      .status >= 400,
  );
  const p = ok(
    await post(root + "preview", {
      template: "shopping_blocked",
      reason: "Satış değerlendirmesi tamamlandı.",
    }),
  ).result;
  assert.match(p.text, /Satış değerlendirmesi/);
  assert.ok(!p.html.includes("Yalnız yönetim"));
  assert.equal(p.recipient, "changes@zentra.invalid");
  const one = ok(
      await f.adminWrite(owner, root + "send", "POST", { id: p.id }),
    ).result,
    two = ok(
      await f.adminWrite(owner, root + "send", "POST", { id: p.id }),
    ).result;
  assert.equal(one.id, two.id);
  assert.equal(
    (
      await f.db
        .collection("storeEmailOutbox")
        .where("uid", "==", "changes")
        .get()
    ).size,
    1,
  );
  assert.equal(
    ok(await get(prefix + "/changes/notices")).result.items[0].state,
    "queued",
  );
});
test("holds stop deletion, challenge binds mode and password plus fresh TOTP, private records removed while financial audit survives", async () => {
  const hold = ok(
    await post(prefix + "/member/removal/preview", { mode: "delete" }),
  ).result;
  assert.ok(hold.blockers.length);
  assert.equal(hold.token, "");
  await make("eraseperson");
  await f.db
    .collection("storeNotifications")
    .doc("marker")
    .set({ uid: "eraseperson" });
  await f.db
    .collection("storeWalletLedger")
    .doc("kept")
    .set({ uid: "eraseperson", createdAt: 10 });
  const api = prefix + "/eraseperson/removal/",
    p = ok(await post(api + "preview", { mode: "delete" })).result;
  assert.ok(p.token);
  const payload = {
    mode: "delete",
    token: p.token,
    reason: "Test hesabı kaldırma",
    totp: f.totp(Date.now() + 30000),
  };
  assert.ok((await post(api + "confirm", payload)).status >= 400);
  assert.ok(
    (
      await f.adminWrite(owner, api + "confirm", "POST", {
        ...payload,
        mode: "ban",
      })
    ).status >= 400,
  );
  const created = ok(
    await f.adminWrite(owner, api + "confirm", "POST", payload),
  ).result;
  assert.equal(created.state, "pending");
  assert.ok(
    (await f.adminWrite(owner, api + "confirm", "POST", payload)).status >= 400,
  );
  const mod = require("../server/core/memberRemoval"),
    ref = f.db.collection("storeAccountRemovalJobs").doc("eraseperson");
  for (let i = 0; i < mod.erase.length + 4; i++) await mod.processJob(ref);
  assert.equal((await ref.get()).data().state, "completed");
  assert.equal(
    (await f.db.collection("users").doc("eraseperson").get()).exists,
    false,
  );
  assert.equal(
    (await f.db.collection("storeNotifications").doc("marker").get()).exists,
    false,
  );
  await assert.rejects(f.auth.getUser("eraseperson"), {
    code: "auth/user-not-found",
  });
  assert.equal(
    (await f.db.collection("storeWalletLedger").doc("kept").get()).exists,
    true,
  );
});
test("keyed registry normalizes provider email and fails closed if the key changes", async () => {
  const reg = require("../functions/registry");
  const old = process.env.ACCOUNT_BLOCKLIST_KEY;
  try {
    process.env.ACCOUNT_BLOCKLIST_KEY = crypto.randomBytes(32).toString("hex");
    const key = reg.emailKey(" Example@Zentra.invalid ");
    assert.equal(key, reg.emailKey("example@zentra.invalid"));
    await f.db
      .collection("storeRegistrationPolicy")
      .doc("current")
      .set({
        active: true,
        keyId: reg.marker(process.env.ACCOUNT_BLOCKLIST_KEY),
      });
    await f.db
      .collection("storeRegistrationBlocks")
      .doc(key)
      .set({ reason: "Test" });
    await assert.rejects(reg.check(f.db, "example@zentra.invalid"), {
      code: "REGISTRATION_UNAVAILABLE",
    });
    await reg.check(f.db, "allowed@zentra.invalid");
    process.env.ACCOUNT_BLOCKLIST_KEY = crypto.randomBytes(32).toString("hex");
    await assert.rejects(reg.check(f.db, "allowed@zentra.invalid"), {
      code: "REGISTRATION_CONTROL_UNAVAILABLE",
    });
  } finally {
    if (old) process.env.ACCOUNT_BLOCKLIST_KEY = old;
    else delete process.env.ACCOUNT_BLOCKLIST_KEY;
    await f.db.collection("storeRegistrationPolicy").doc("current").delete();
  }
});
test("operation catalogue uses the caller's role and stores verified diagnostic result and timestamp", async () => {
  const list = ok(await get("/api/admin/store/tools")).result;
  assert.equal(list.length, 9);
  const result = ok(
    await f.adminWrite(owner, "/api/admin/store/tools/finance/run", "POST", {}),
  ).result;
  assert.ok(result.at && result.reference);
  assert.equal(
    ok(await get("/api/admin/store/tools")).result.find(
      (t) => t.id === "finance",
    ).last.reference,
    result.reference,
  );
  assert.ok(
    (await get("/api/admin/store/tools", { uid: "member" })).status >= 400,
  );
});
test("release and project-bound control evidence is validated independently; tampering and missing tests cannot yield full points", () => {
  const { requirements, validate } = require("../server/core/productionChecks"),
    { canonical } = require("../server/core/restoreVerification");
  const keys = crypto.generateKeyPairSync("ed25519"),
    target = {
      project: "fixture-only",
      service: "srv-fixture",
      digest: "1".repeat(64),
      publicKey: keys.publicKey.export({ format: "pem", type: "spki" }),
    };
  const report = {
    version: 1,
    kind: "sessions",
    project: target.project,
    service: target.service,
    sourceDigest: target.digest,
    at: Date.now(),
    runId: "test-run-0001",
    tests: requirements.sessions.map((id) => ({
      id,
      status: "passed",
      artifactHash: "2".repeat(64),
    })),
  };
  const sign = (r) => ({
    report: r,
    signature: crypto
      .sign(null, Buffer.from(JSON.stringify(canonical(r))), keys.privateKey)
      .toString("base64"),
  });
  assert.equal(validate(sign(report), "sessions", target).status, "passed");
  assert.equal(
    validate(
      sign({ ...report, tests: report.tests.slice(1) }),
      "sessions",
      target,
    ).status,
    "partial",
  );
  const e = sign(report);
  assert.equal(
    validate(
      { ...e, report: { ...report, at: report.at - 100 } },
      "sessions",
      target,
    ),
    null,
  );
  assert.equal(
    validate(e, "sessions", { ...target, service: "srv-other" }),
    null,
  );
});
