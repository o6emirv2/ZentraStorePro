"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const { applicationFixture } = require("./helpers/application-fixture.cjs");
const blockingConfig = { blockingFunctions: { triggers: {} } },
  root = "/api/admin/store/members/";
let f, owner;
function totp(seed, time = Date.now()) {
  const digits = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
    binary = [...seed]
      .map((c) => digits.indexOf(c).toString(2).padStart(5, "0"))
      .join("");
  const secret = Buffer.from(binary.match(/.{8}/g).map((x) => parseInt(x, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 30000)));
  const hash = crypto.createHmac("sha1", secret).update(counter).digest();
  return String(
    (hash.readUInt32BE(hash.at(-1) & 15) & 0x7fffffff) % 1000000,
  ).padStart(6, "0");
}
function ok(response) {
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}
async function member(uid) {
  f.users.set(uid, {
    ...f.users.get("member"),
    uid,
    email: uid + "@zentra.invalid",
    generation: 0,
  });
  await f.db
    .collection("users")
    .doc(uid)
    .set({ username: uid, storeAccountStatus: "active", storeBalanceKurus: 0 });
}
async function post(path, body) {
  return f.request(path, { ...owner, method: "POST", body });
}
before(async () => {
  process.env.ACCOUNT_BLOCKLIST_KEY = crypto.randomBytes(32).toString("hex");
  process.env.ADMIN_TOTP_ENCRYPTION_KEY = crypto
    .randomBytes(32)
    .toString("hex");
  for (const [id, name] of [
    ["CREATE", "storeBeforeCreate"],
    ["SIGNIN", "storeBeforeSignIn"],
  ])
    process.env["ACCOUNT_BLOCKING_" + id + "_URL"] =
      "https://example-fixture.cloudfunctions.net/" + name;
  process.env.EMAIL_NOTIFICATIONS_ENABLED = "true";
  process.env.RESEND_API_KEY =
    "re_" + crypto.randomBytes(30).toString("base64url");
  f = await applicationFixture({ blockingConfig });
  owner = await f.openAdmin();
});
after(async () => {
  await f?.close();
});
test("archive records preserve captured spending and real delivery timestamp through account and order APIs", async () => {
  const uid = "archivefixture";
  await member(uid);
  const paid = {
    uid,
    paymentMethod: "wallet",
    createdAt: 10,
    totalKurus: 201,
    paymentState: "paid",
    paidAt: 11,
    status: "delivered",
    delivery: { status: "delivered", deliveredAt: 21 },
  };
  const archives = f.db.collection("storeOrderArchives"),
    orders = f.db.collection("storeOrders");
  await archives.doc("former").set({ order: paid });
  await archives.doc("duplicate").set({ order: paid });
  await orders
    .doc("duplicate")
    .set({
      ...paid,
      totalKurus: 303,
      delivery: { status: "delivered", deliveredAt: 34 },
    });
  const info = ok(
    await f.request("/api/admin/store/users/resolve?identifier=" + uid, owner),
  ).user;
  assert.equal(info.orderCount, 2);
  assert.equal(info.totalSpendKurus, 504);
  assert.equal(info.lastDeliveryAt, 34);
  const listing = ok(await f.request(root + uid + "/orders", owner)).result
    .items;
  assert.equal(listing.length, 2);
  assert.equal(listing.find((v) => v.id === "former").archived, true);
  assert.equal(listing.find((v) => v.id === "duplicate").amount, 303);
});
test("approved account notice sends both representations once and records provider acceptance independently of delivery", async () => {
  const uid = "mailfixture";
  await member(uid);
  const base = root + uid + "/notice/";
  const p = ok(
    await post(base + "preview", {
      template: "information",
      reason: "Hesap kaydınız incelendi.",
    }),
  ).result;
  ok(await f.adminWrite(owner, base + "send", "POST", { id: p.id }));
  const row = (
    await f.db.collection("storeEmailOutbox").where("uid", "==", uid).get()
  ).docs[0];
  let calls = 0;
  const id = crypto.randomUUID(),
    fetcher = async (url, options) => {
      assert.equal(url, "https://api.resend.com/emails");
      const msg = JSON.parse(options.body);
      assert.ok(msg.html.includes("Hesap kaydınız incelendi."));
      assert.ok(msg.text.includes("Hesap kaydınız incelendi."));
      calls++;
      return { ok: true, status: 200, json: async () => ({ id }) };
    };
  const email = require("../server/email/service");
  await email.processMessage(f.db, row.ref, { fetcher });
  await email.processMessage(f.db, row.ref, { fetcher });
  assert.equal(calls, 1);
  const history = ok(await f.request(root + uid + "/notices", owner)).result
    .items[0];
  assert.equal(history.state, "accepted");
  assert.equal(history.providerId, id);
});
test("ban requires the registered provider hooks, survives ambiguous Auth deletion and refuses re-registration", async () => {
  const uid = "blockedfixture",
    email = uid + "@zentra.invalid",
    path = root + uid + "/removal/";
  await member(uid);
  const reaction = f.db.collection("storeProductReactions").doc("older-like"),
    counter = f.db.collection("storeProductCommunity").doc("older-product");
  await reaction.set({
    actor: "member:" + require("../server/commerce/common").hash(uid),
    liked: true,
    productId: "older-product",
  });
  await counter.set({ likes: 1 });
  const p = ok(await post(path + "preview", { mode: "ban" })).result;
  const command = {
    mode: "ban",
    token: p.token,
    totp: f.totp(Date.now() + 30000),
    reason: "Test hesabı için kalıcı kayıt engeli",
  };
  assert.equal(
    (await f.adminWrite(owner, path + "confirm", "POST", command)).status,
    503,
  );
  assert.equal(
    (await f.db.collection("storeAccountRemovalJobs").doc(uid).get()).exists,
    false,
  );
  blockingConfig.blockingFunctions.triggers = {
    beforeCreate: { functionUri: process.env.ACCOUNT_BLOCKING_CREATE_URL },
    beforeSignIn: { functionUri: process.env.ACCOUNT_BLOCKING_SIGNIN_URL },
  };
  const job = ok(
    await f.adminWrite(owner, path + "confirm", "POST", command),
  ).result;
  assert.equal(job.state, "pending");
  const reg = require("../functions/registry"),
    removal = require("../server/core/memberRemoval");
  await assert.rejects(reg.check(f.db, email.toUpperCase()), {
    code: "REGISTRATION_UNAVAILABLE",
  });
  const key = reg.emailKey(email),
    block = (
      await f.db.collection("storeRegistrationBlocks").doc(key).get()
    ).data();
  assert.equal(block.reference, job.id);
  assert.ok(!JSON.stringify(block).includes(email));
  const ref = f.db.collection("storeAccountRemovalJobs").doc(uid);
  while ((await ref.get()).data().step <= removal.erase.length)
    await removal.processJob(ref);
  const original = f.auth.deleteUser;
  let calls = 0;
  f.auth.deleteUser = async (id) => {
    calls++;
    await original(id);
    throw Object.assign(Error("ambiguous operation"), {
      code: "NETWORK_INTERRUPTION",
    });
  };
  try {
    await assert.rejects(removal.processJob(ref), {
      code: "NETWORK_INTERRUPTION",
    });
    assert.equal((await ref.get()).data().state, "pending");
    await removal.processJob(ref);
  } finally {
    f.auth.deleteUser = original;
  }
  assert.equal(calls, 1);
  assert.equal((await reaction.get()).exists, false);
  assert.equal((await counter.get()).data().likes, 0);
  assert.equal((await ref.get()).data().state, "completed");
  await assert.rejects(f.auth.getUser(uid), { code: "auth/user-not-found" });
  await assert.rejects(reg.check(f.db, email), {
    code: "REGISTRATION_UNAVAILABLE",
  });
});
test("factor enrollment, one-use recovery, encrypted storage, replay and paginated session revocation", async () => {
  const vault = require("../server/core/adminFactorVault"),
    service = require("../server/core/adminTotpService");
  const uid = "finance",
    credentials = vault.createCredentials();
  const staff = f.db.collection("adminUsers").doc(uid);
  if (!(await staff.get()).exists)
    await staff.set({ active: true, role: "finance" });
  const sessions = f.db.collection("storeAdminSessions");
  await Promise.all(
    Array.from({ length: 305 }, (_, i) =>
      sessions.doc("archived-session-" + i).set({ uid }),
    ),
  );
  const secret = credentials.seed;
  const result = await vault.replace({
    uid,
    password: f.password,
    oldCode: f.totp(),
    newCredentials: credentials,
    newCode: totp(secret),
  });
  assert.equal(result.revision, 1);
  const data = (await vault.reference(f.db, uid).get()).data();
  assert.ok(!JSON.stringify(data).includes(secret));
  assert.ok(!JSON.stringify(data).includes(credentials.recovery));
  assert.equal(data.revocationPending, false);
  assert.ok(
    (await sessions.where("uid", "==", uid).get()).docs.every(
      (d) => d.data().revokedAt,
    ),
  );
  assert.equal(
    (await service.verifyAdminTotp({ uid, code: totp(secret) })).factorVersion,
    1,
  );
  await assert.rejects(service.verifyAdminTotp({ uid, code: totp(secret) }), {
    code: "ADMIN_TOTP_REPLAY",
  });
  const next = vault.createCredentials();
  const recover = {
    uid,
    password: f.password,
    recovery: credentials.recovery,
    newCredentials: next,
    newCode: totp(next.seed),
  };
  assert.equal((await vault.replace(recover)).revision, 2);
  await assert.rejects(vault.replace(recover), {
    code: "ADMIN_FACTOR_RECOVERY_REJECTED",
  });
  assert.equal(
    (await service.verifyAdminTotp({ uid, code: totp(next.seed) }))
      .factorVersion,
    2,
  );
});
test("read-only integration diagnostics validate service identities and keep provider secrets out of output", async () => {
  const { diagnose } = require("../server/core/providerDiagnostics");
  const missing = await diagnose({}, () => {
    throw Error("unexpected");
  });
  assert.ok(missing.every((x) => x.state === "unverified"));
  const env = {
    RENDER_SERVICE_ID: "srv-example",
    RENDER_DIAGNOSTICS_TOKEN: "fake-render",
    SHOPIER_READ_TOKEN: "fake-shopier",
    SHOPIER_SHOP_NAME: "fixture",
    TELEGRAM_BOT_TOKEN: "10001:fixture",
  };
  const probes = await diagnose(env, async (url, opts) => {
    assert.equal(opts.method, "GET");
    return {
      ok: true,
      json: async () =>
        url.includes("render.com")
          ? { id: "srv-example" }
          : url.includes("shopier.com")
            ? { name: "different", access: true }
            : { ok: true, result: { is_bot: true, id: 10001 } },
    };
  });
  assert.deepEqual(
    probes.map((x) => x.state),
    ["passed", "failed", "passed"],
  );
  assert.ok(!JSON.stringify(probes).includes("fake-"));
  assert.ok(!JSON.stringify(probes).includes("10001"));
});
