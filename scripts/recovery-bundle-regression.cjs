"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const { PassThrough, Readable } = require("node:stream"),
  {
    seal,
    consume,
    quarantined,
    rewriteReferences,
  } = require("../server/core/recoveryBundle");
test("authenticated streaming backup restores exact rows into an independent target and detects damage before writes", async () => {
  const source = new Map([
    ["users/example", { username: "Example" }],
    [
      "storeWalletLedger/txn",
      { uid: "example", before: 100, delta: -20, after: 80 },
    ],
  ]);
  const rows = [...source].map(([path, fields]) => ({
    type: "document",
    path,
    fields,
  }));
  rows.push(
    { type: "auth", uid: "example" },
    { type: "asset", name: "image" },
    { type: "data", value: "Ynl0ZXM=" },
  );
  const target = new Map(),
    key = crypto.randomBytes(32),
    stream = new PassThrough(),
    chunks = [];
  stream.on("data", (c) => chunks.push(c));
  const manifest = await seal(rows, stream, key, {
      source: "local-source",
      id: "fixture-snapshot",
    }),
    ciphertext = Buffer.concat(chunks);
  assert.ok(!ciphertext.includes(Buffer.from("Example")));
  let n = 0;
  await consume(
    () => Readable.from([ciphertext]),
    key,
    manifest,
    (r) => {
      n++;
      if (r.type === "document") target.set(r.path, r.fields);
    },
  );
  assert.deepEqual(target, source);
  assert.equal(n, 5);
  const bad = Buffer.from(ciphertext);
  bad[Math.floor(bad.length / 2)] ^= 1;
  let writes = 0;
  await assert.rejects(
    consume(
      () => Readable.from([bad]),
      key,
      manifest,
      () => writes++,
    ),
  );
  assert.equal(writes, 0);
  await assert.rejects(
    consume(
      () => Readable.from([ciphertext]),
      key,
      { ...manifest, header: { ...manifest.header, source: "other" } },
      () => writes++,
    ),
  );
  assert.equal(writes, 0);
});
test("isolated recovery excludes operational access, sends and stale blocks and remaps only internal references", () => {
  for (const c of [
    "adminUsers",
    "storeAdminSessions",
    "storeEmailOutbox",
    "storeAccountRemovalJobs",
    "storeRegistrationBlocks",
    "storeCustomerSessions",
  ])
    assert.equal(quarantined(c), true, c);
  for (const c of ["storeOrders", "storeWalletLedger", "storeProductDetails"])
    assert.equal(quarantined(c), false, c);
  const obj = {
    owner: {
      referenceValue: "projects/old/databases/(default)/documents/users/1",
    },
  };
  assert.equal(
    rewriteReferences(obj, "old", "new").owner.referenceValue,
    "projects/new/databases/(default)/documents/users/1",
  );
  assert.throws(() => rewriteReferences(obj, "other", "new"));
});

test("recovery checks archived financial parent ownership, viewable orders and quarantined wallet profiles", async () => {
  const { verifyBusinessRelations } = require("./recovery-drill.cjs");
  const archive = { uid: "buyer", totalKurus: 100 },
    rows = {
      storeOrders: { new: archive },
      storeOrderArchives: { former: { order: archive } },
      storeWalletLedger: { payment: { uid: "buyer", orderId: "former" } },
      storeDeliveries: { new: { uid: "buyer" } },
      users: {
        buyer: {
          storeBalanceKurus: 200,
          storeBalanceHeldKurus: 50,
          storeAccountStatus: "security_locked",
        },
      },
    };
  const doc = (id, row) => ({ id, exists: !!row, data: () => row });
  const db = {
    collection: (name) => ({
      doc: (id) => ({ get: async () => doc(id, rows[name]?.[id]) }),
      async *stream() {
        for (const [id, row] of Object.entries(rows[name] || {}))
          yield doc(id, row);
      },
    }),
  };
  assert.deepEqual(await verifyBusinessRelations(db), {
    ledgerOrders: 1,
    deliveries: 1,
    walletProfiles: 1,
    orderViews: 1,
  });
  rows.storeWalletLedger.payment.uid = "different";
  await assert.rejects(verifyBusinessRelations(db), {
    code: "RECOVERY_LEDGER_ORDER_OWNER_MISMATCH",
  });
});
