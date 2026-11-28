"use strict";
// Isolated provider contract fixture. All provider requests are intercepted in-process.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { applicationFixture } = require("./helpers/application-fixture.cjs");
const supplier = require("../server/suppliers/hilehanem-contract");
const nativeFetch = global.fetch,
  host = "offline-test.hilehanem.com";
const contract = {
  version: 1,
  documentationUrl: "https://" + host + "/fixture",
  authentication: {
    name: "Authorization",
    location: "header",
    prefix: "Bearer ",
  },
  idempotency: { header: "Idempotency-Key", guaranteed: true },
  operations: {
    balance: { method: "GET", path: "/fixture-account" },
    package: {
      method: "GET",
      path: "/fixture-package/{productId}/{packageId}",
    },
    lookup: { method: "GET", path: "/fixture-orders/{requestId}" },
    purchase: {
      method: "POST",
      path: "/fixture-orders",
      body: {
        productId: "{productId}",
        packageId: "{packageId}",
        quantity: "{quantity}",
        requestId: "{requestId}",
        limit: "{maximumCostMinor}",
      },
    },
  },
  fields: Object.fromEntries(
    [
      "balance",
      "currency",
      "productId",
      "packageId",
      "stock",
      "unitCostMinor",
      "state",
      "requestId",
      "quantity",
      "reference",
      "licenses",
      "purchaseCostMinor",
    ].map((k) => [k, "/" + k]),
  ),
  states: {
    completed: ["ok"],
    pending: ["waiting"],
    notFound: ["absent"],
    rejected: ["no-charge"],
  },
};
let f,
  dir,
  body,
  plan,
  product,
  mode,
  stock,
  balance,
  unitCost,
  calls,
  receipts,
  secret,
  environment;
const prefix = "HILEHANEM_";
before(async () => {
  f = await applicationFixture({
    rateLimitStore: "memory",
    transientStore: "memory",
  });
  const catalog =
    await require("../server/core/storeCatalogService").getEffectiveCatalog();
  product = catalog.products.find((p) => p.id === "kingmod");
  plan = product.plans[0];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "zentra-provider-"));
  fs.writeFileSync(path.join(dir, "contract.json"), JSON.stringify(contract));
  environment = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k.startsWith(prefix)),
  );
  secret = "hh_" + crypto.randomBytes(24).toString("hex");
  Object.assign(process.env, {
    HILEHANEM_API_BASE_URL: "https://" + host,
    HILEHANEM_API_KEY: secret,
    HILEHANEM_CONTRACT_FILE: path.join(dir, "contract.json"),
    HILEHANEM_PURCHASING_ENABLED: "true",
    HILEHANEM_PRODUCT_MAPPINGS: JSON.stringify([
      {
        zentraProductId: product.id,
        zentraPlanKey: plan.key,
        productId: "demo-product",
        packageId: "demo-package",
        currency: "USD",
        maximumUnitCostMinor: 650,
      },
    ]),
  });
  global.fetch = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.hostname !== host) return nativeFetch(url, options);
    assert.equal(options.headers.Authorization, "Bearer " + secret);
    assert.equal(options.redirect, "error");
    const reply = (data) => Response.json(data);
    calls.push(parsed.pathname);
    if (parsed.pathname === "/fixture-account")
      return reply({ balance, currency: "USD" });
    if (parsed.pathname.startsWith("/fixture-package/"))
      return reply({
        productId: "demo-product",
        packageId: "demo-package",
        currency: "USD",
        stock,
        unitCostMinor: unitCost,
      });
    if (options.method === "POST") {
      const payload = JSON.parse(options.body);
      assert.equal(options.headers["Idempotency-Key"], payload.requestId);
      assert.equal(payload.limit, unitCost * payload.quantity);
      const result = {
        ...payload,
        state: "ok",
        reference: crypto.randomUUID(),
        currency: "USD",
        purchaseCostMinor: unitCost,
        licenses: ["fixture-license-" + crypto.randomUUID()],
      };
      if (mode === "reject") return reply({ ...result, state: "no-charge" });
      balance -= unitCost;
      stock -= 1;
      receipts.set(payload.requestId, result);
      if (mode === "lost") throw Error("controlled network timeout");
      if (mode === "wrong-package")
        return reply({ ...result, packageId: "different" });
      return reply(result);
    }
    return reply(
      mode === "not-found"
        ? { state: "absent" }
        : receipts.get(parsed.pathname.split("/").at(-1)) || {
            state: "waiting",
          },
    );
  };
});
beforeEach(() => {
  stock = 8;
  unitCost = 425;
  balance = 10000;
  calls = [];
  receipts = new Map();
  mode = "ok";
  const user = f.db.records.get("users/member");
  f.db.records.set("users/member", {
    ...user,
    storeBalanceKurus: plan.priceKurus,
    storeBalanceHeldKurus: 0,
  });
  body = {
    paymentMethod: "wallet",
    items: [
      {
        productId: product.id,
        planKey: plan.key,
        quantity: 1,
        expectedUnitPriceKurus: plan.priceKurus,
      },
    ],
    idempotencyKey: crypto.randomUUID(),
  };
});
after(async () => {
  global.fetch = nativeFetch;
  for (const k of Object.keys(process.env).filter((k) => k.startsWith(prefix)))
    delete process.env[k];
  Object.assign(process.env, environment);
  fs.rmSync(dir, { recursive: true, force: true });
  await f.close();
});
const purchase = async (input = body) =>
  f.request("/api/store/orders", {
    uid: "member",
    method: "POST",
    body: input,
  });
const posts = () => calls.filter((p) => p === "/fixture-orders").length;
const profile = () => f.db.records.get("users/member");
test("normal storefront checkout charges retail once, buys at cost, refreshes stock and delivers the encrypted license to the owner", async () => {
  const first = await purchase();
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const order = first.body.order;
  assert.equal(order.status, "delivered");
  assert.equal(first.body.balanceKurus, 0);
  assert.equal(first.body.availableBalanceKurus, 0);
  const again = await purchase();
  assert.equal(again.body.order.id, order.id);
  assert.equal(posts(), 1);
  assert.equal(balance, 9575);
  const job = f.db.records.get("storeSupplierPurchases/" + order.id);
  assert.equal(job.costMinor, 425);
  assert.equal(job.currency, "USD");
  assert.equal(job.saleKurus, plan.priceKurus);
  assert.equal(profile().storeBalanceHeldKurus, 0);
  assert.equal(
    f.db.records.get("storeWalletLedger/purchase_" + order.id).amountKurus,
    -plan.priceKurus,
  );
  const license = [...receipts.values()][0].licenses[0];
  assert(!JSON.stringify([...f.db.records]).includes(license));
  const delivery = await f.request(
    "/api/store/orders/" + order.id + "/delivery",
    { uid: "member" },
  );
  assert.equal(delivery.status, 200);
  assert.equal(delivery.body.delivery.items[0].key, license);
  const denied = await f.request(
    "/api/store/orders/" + order.id + "/delivery",
    { uid: "owneruid" },
  );
  assert.equal(denied.status, 403);
  const catalog = (await f.request("/api/store/catalog")).body.catalog;
  assert.equal(
    catalog.products
      .find((p) => p.id === product.id)
      .plans.find((p) => p.key === plan.key).stock.available,
    7,
  );
});
test("insufficient retail funds stop before supplier checks; stock, cost ceiling and provider balance failures create no hold", async () => {
  f.db.records.set("users/member", { ...profile(), storeBalanceKurus: 0 });
  assert.equal((await purchase()).body.error, "STORE_INSUFFICIENT_BALANCE");
  assert.equal(calls.length, 0);
  f.db.records.set("users/member", {
    ...profile(),
    storeBalanceKurus: plan.priceKurus,
  });
  for (const [name, value, error] of [
    ["stock", 0, "STORE_OUT_OF_STOCK"],
    ["balance", 0, "HILEHANEM_BALANCE_INSUFFICIENT"],
    ["cost", 900, "HILEHANEM_COST_CHANGED"],
  ]) {
    stock = name === "stock" ? value : 8;
    balance = name === "balance" ? value : 10000;
    unitCost = name === "cost" ? value : 425;
    assert.equal((await purchase()).body.error, error);
    assert.equal(profile().storeBalanceHeldKurus, 0);
    assert.equal(posts(), 0);
  }
});
test("lost purchase response keeps the hold; a missing lookup never buys again and confirmed lookup settles exactly once", async () => {
  mode = "lost";
  const initial = await purchase();
  assert.equal(initial.status, 201);
  const order = initial.body.order;
  assert.equal(order.paymentState, "reserved");
  assert.equal(initial.body.availableBalanceKurus, 0);
  assert.equal(profile().storeBalanceKurus, plan.priceKurus);
  assert.equal(
    (await purchase({ ...body, idempotencyKey: crypto.randomUUID() })).body
      .error,
    "STORE_INSUFFICIENT_BALANCE",
  );
  const processor = require("../server/suppliers/hilehanem-purchase");
  mode = "not-found";
  await processor.processOrder(order.id, { db: f.db });
  assert.equal(profile().storeBalanceHeldKurus, plan.priceKurus);
  assert.equal(posts(), 1);
  mode = "ok";
  await Promise.all([
    processor.processOrder(order.id, { db: f.db }),
    processor.processOrder(order.id, { db: f.db }),
  ]);
  assert.equal(posts(), 1);
  assert.equal(profile().storeBalanceKurus, 0);
  assert.equal(profile().storeBalanceHeldKurus, 0);
  assert.equal((await purchase()).body.order.status, "delivered");
});
test("a confirmed no-charge rejection releases the hold without creating a debit", async () => {
  mode = "reject";
  const response = await purchase();
  const order = response.body.order;
  assert.equal(order.status, "payment_rejected");
  assert.equal(order.paymentState, "not_captured");
  assert.equal(profile().storeBalanceHeldKurus, 0);
  assert.equal(profile().storeBalanceKurus, plan.priceKurus);
  assert(!f.db.records.has("storeWalletLedger/purchase_" + order.id));
  assert.equal((await purchase()).body.order.id, order.id);
  assert.equal(posts(), 1);
});
test("two concurrent orders cannot spend the same retail balance", async () => {
  const results = await Promise.all([
    purchase(),
    purchase({ ...body, idempotencyKey: crypto.randomUUID() }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal(posts(), 1);
  assert.equal(profile().storeBalanceKurus, 0);
});
test("receipt for another package is never delivered, and admin checks never purchase or expose the credential", async () => {
  mode = "wrong-package";
  const response = await purchase();
  assert.equal(response.body.order.paymentState, "reserved");
  const status = await require("../server/suppliers/hilehanem-service").check(
    { uid: "owneruid" },
    { db: f.db },
  );
  assert(status.active && status.stockSynchronization);
  assert.equal(posts(), 1);
  assert(!JSON.stringify([...f.db.records, status]).includes(secret));
  assert.equal(
    (
      await f.request(
        "/api/store/orders/" + response.body.order.id + "/delivery",
        { uid: "member" },
      )
    ).status,
    409,
  );
  await require("../server/suppliers/hilehanem-purchase").processOrder(
    response.body.order.id,
    { db: f.db },
  );
  assert.equal(profile().storeBalanceHeldKurus, 0);
  assert.equal(posts(), 1);
});
test("supplier checkout holds the last coupon with the balance and consumes it once only after confirmation", async () => {
  const promotions = require("../server/core/storePromotionService");
  const code = "SUPPLIER10",
    campaign = () => f.db.records.get("storePromotions/" + code);
  await promotions.savePromotion(
    code,
    {
      title: "Bayi kupon testi",
      type: "percent",
      value: 10,
      usageLimit: 1,
      perUserLimit: 1,
      active: true,
      createOnly: true,
      announce: false,
    },
    { uid: "owneruid" },
  );
  mode = "reject";
  const declined = await purchase({ ...body, promotionCode: code });
  assert.equal(declined.status, 201, JSON.stringify(declined.body));
  assert.equal(declined.body.order.status, "payment_rejected");
  assert.equal(campaign().heldCount, 0);
  assert.equal(campaign().usedCount, 0);
  mode = "lost";
  const input = {
    ...body,
    promotionCode: code,
    idempotencyKey: crypto.randomUUID(),
  };
  const result = await purchase(input);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const order = result.body.order;
  assert.equal(order.paymentState, "reserved");
  assert.equal(campaign().heldCount, 1);
  assert.equal(campaign().usedCount, 0);
  assert.equal(profile().storeBalanceHeldKurus, order.totalKurus);
  assert(order.totalKurus < plan.priceKurus);
  await assert.rejects(
    promotions.previewPromotion({
      uid: "owneruid",
      cart: { items: order.items, totalKurus: plan.priceKurus },
      code,
    }),
  );
  mode = "ok";
  await require("../server/suppliers/hilehanem-purchase").processOrder(
    order.id,
    { db: f.db },
  );
  assert.equal(campaign().heldCount, 0);
  assert.equal(campaign().usedCount, 1);
  assert.equal(profile().storeBalanceHeldKurus, 0);
  assert.equal(profile().storeBalanceKurus, plan.priceKurus - order.totalKurus);
  assert.equal((await purchase(input)).body.order.id, order.id);
  assert.equal(posts(), 2);
  assert.equal(campaign().usedCount, 1);
});

test("a configured two-use discount stops at its per-account limit", async () => {
  const promotions = require("../server/core/storePromotionService"),
    code = "TWOPERSON";
  await promotions.savePromotion(
    code,
    {
      title: "İki hak",
      type: "percent",
      value: 10,
      usageLimit: 5,
      perUserLimit: 2,
      active: true,
      createOnly: true,
    },
    { uid: "owneruid" },
  );
  f.db.records.set("users/member", {
    ...profile(),
    storeBalanceKurus: 4 * plan.priceKurus,
  });
  const request = () =>
    purchase({
      ...body,
      promotionCode: code,
      idempotencyKey: crypto.randomUUID(),
    });
  assert.equal((await request()).body.order.status, "delivered");
  assert.equal((await request()).body.order.status, "delivered");
  assert.equal((await request()).body.error, "STORE_PROMOTION_ALREADY_USED");
  assert.equal(posts(), 2);
});
