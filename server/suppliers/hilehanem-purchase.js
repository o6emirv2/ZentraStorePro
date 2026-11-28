"use strict";
const crypto = require("node:crypto");
const C = require("../commerce/common"),
  M = require("../core/storeMoney"),
  V = require("../core/storeKeyVault");
const dependencies = () =>
  require("../config/firebaseAdmin").initFirebaseAdmin();
const coupons = require("../core/storePromotionService"),
  quotes = require("../commerce/quotes");
const JOBS = "storeSupplierPurchases";
function bindingFor(
  items,
  bindings = require("./hilehanem-contract").mappings(),
) {
  const matched = items.map((x) =>
    bindings.find(
      (b) => b.zentraProductId === x.productId && b.zentraPlanKey === x.planKey,
    ),
  );
  if (!matched.some(Boolean)) return null;
  if (items.length !== 1 || !matched[0])
    C.fail("STORE_SUPPLIER_SINGLE_PACKAGE_REQUIRED", 409);
  return matched[0];
}
async function start({
  uid,
  cart,
  binding,
  idempotencyId,
  requestHash,
  catalog,
  commerceQuote = null,
  code = "",
  authUser = {},
  idempotencyRef,
  orderRef,
  db = dependencies().db,
  provider,
}) {
  V.assertConfigured();
  const line = cart.items[0];
  C.uid(uid);
  const userRef = db.collection("users").doc(uid),
    jobRef = db.collection(JOBS).doc(orderRef.id);
  const loadOrder = async (id) => {
    const existing = (await db.collection("storeOrders").doc(id).get()).data();
    if (!existing || existing.uid !== uid) C.fail("STORE_ORDER_CONFLICT", 409);
    return existing;
  };
  const reuse = (record) => {
    if (
      record.uid !== uid ||
      record.requestHash !== requestHash ||
      !record.orderId ||
      ["cancelled", "archived"].includes(record.status)
    )
      C.fail("STORE_ORDER_CONFLICT", 409);
    return record.orderId;
  };
  const replay = (await idempotencyRef.get()).data();
  if (replay) return loadOrder(reuse(replay));
  const profile = (await userRef.get()).data() || {};
  const preview =
    code && !commerceQuote
      ? await coupons.previewPromotion({ uid, cart, code })
      : null;
  const expectedSale =
    commerceQuote?.totalKurus ?? preview?.totalKurus ?? cart.totalKurus;
  if (M.readAvailableBalance(profile) < expectedSale) {
    const concurrent = (await idempotencyRef.get()).data();
    if (concurrent) return loadOrder(reuse(concurrent));
    C.fail("STORE_INSUFFICIENT_BALANCE", 409);
  }
  provider ||= require("./hilehanem-contract").adapter();
  const [account, quote] = await Promise.all([
    provider.balance(),
    provider.quote(binding),
  ]);
  if (
    quote.productId !== binding.productId ||
    quote.packageId !== binding.packageId ||
    quote.currency !== binding.currency ||
    account.currency !== binding.currency
  )
    C.fail("HILEHANEM_MAPPING_MISMATCH", 409);
  if (quote.stock < line.quantity) C.fail("STORE_OUT_OF_STOCK", 409);
  const maximumCostMinor = quote.unitCostMinor * line.quantity;
  if (
    !Number.isSafeInteger(maximumCostMinor) ||
    quote.unitCostMinor > binding.maximumUnitCostMinor
  )
    C.fail("HILEHANEM_COST_CHANGED", 409);
  if (account.balanceMinor < maximumCostMinor)
    C.fail("HILEHANEM_BALANCE_INSUFFICIENT", 409);
  const now = Date.now();
  const chosen = await db.runTransaction(async (tx) => {
    const [old, user, settings] = await Promise.all([
      tx.get(idempotencyRef),
      tx.get(userRef),
      tx.get(db.collection("storefrontSettings").doc("main")),
    ]);
    if (old.exists) return reuse(old.data());
    if (settings.data()?.catalog?.deletedProductIds?.[line.productId])
      C.fail("STORE_PRODUCT_NOT_FOUND", 404);
    if (
      catalog.revision &&
      require("../core/storeCatalogService").catalogRevision(
        settings.data() || {},
      ) !== catalog.revision
    )
      C.fail("STORE_CATALOG_CHANGED", 409);
    const context = commerceQuote
      ? await quotes.transactionContext(tx, db, commerceQuote, { uid, cart })
      : null;
    const priced = context?.cart || cart,
      recipient = context?.recipientUid || uid;
    const promotion = code
      ? await coupons.readPromotionInTransaction({
          transaction: tx,
          db,
          uid,
          code,
          cart: priced,
        })
      : null;
    const sale = promotion?.result.totalKurus ?? priced.totalKurus;
    if (sale !== expectedSale) C.fail("STORE_PRICE_CHANGED", 409);
    const p = user.data() || {};
    if (
      !user.exists ||
      M.checkedBalance(p.storeWalletDebtKurus || 0) > 0 ||
      (p.storeAccountStatus && p.storeAccountStatus !== "active")
    )
      C.fail("STORE_PURCHASE_BLOCKED", 403);
    if (M.readAvailableBalance(p) < sale)
      C.fail("STORE_INSUFFICIENT_BALANCE", 409);
    const held = M.checkedBalance(
      M.checkedBalance(p.storeBalanceHeldKurus || 0) + sale,
    );
    const order = {
      id: orderRef.id,
      uid,
      email: String(authUser.email || p.email || ""),
      username: String(p.username || ""),
      orderNumber:
        "ZS-" +
        now.toString(36).toUpperCase() +
        "-" +
        crypto.randomBytes(3).toString("hex").toUpperCase(),
      status: "processing",
      paymentMethod: "wallet",
      salesChannel: "automatic",
      supplier: "hilehanem",
      supplierState: "reserved",
      fulfillmentStatus: "TEDARIK_KONTROL_EDILIYOR",
      currency: "TRY",
      items: priced.items,
      reviewProductIds: require("../commerce/reviewInvitations").productIds(priced.items),
      subtotalKurus: priced.totalKurus,
      totalKurus: sale,
      discountKurus: promotion?.result.discountKurus || 0,
      promotion: promotion?.result || null,
      ...(recipient !== uid ? { giftRecipientUid: recipient } : {}),
      delivery: { status: "pending", itemCount: 0, automatic: true },
      approvedAt: 0,
      createdAt: now,
      updatedAt: now,
    };
    if (context) quotes.commit(tx, db, context, order);
    coupons.reservePromotion(tx, promotion, uid);
    tx.update(userRef, { storeBalanceHeldKurus: held, storeUpdatedAt: now });
    tx.create(jobRef, {
      uid,
      orderId: orderRef.id,
      state: "ready",
      requestId: "zentra-" + idempotencyId,
      productId: binding.productId,
      packageId: binding.packageId,
      quantity: line.quantity,
      currency: binding.currency,
      maximumCostMinor,
      saleKurus: sale,
      createdAt: now,
      nextAttemptAt: now,
      leaseUntil: 0,
      attempts: 0,
    });
    tx.create(orderRef, order);
    tx.create(idempotencyRef, {
      uid,
      orderId: orderRef.id,
      requestHash,
      keyHash: idempotencyId,
      createdAt: now,
    });
    require("../core/notificationEvents").record(tx, db, {
      uid,
      type: "order_created",
      key: orderRef.id,
      data: { orderId: orderRef.id },
    });
    require("../commerce/orders").timeline(
      tx,
      db,
      orderRef.id,
      "processing",
      now,
      uid,
    );
    return orderRef.id;
  });
  await processOrder(chosen, { db, provider });
  require("../core/firestorePagination").invalidateCreatedAtPageCache(
    "storeOrders",
  );
  return loadOrder(chosen);
}
async function processOrder(
  orderId,
  { db = dependencies().db, provider } = {},
) {
  const ref = db.collection(JOBS).doc(C.id(orderId)),
    lease = crypto.randomUUID();
  // Resolve configuration before claiming a job. A configuration outage must not mark an unsent order as submitted.
  if (!provider) provider = require("./hilehanem-contract").adapter();
  const job = await db.runTransaction(async (tx) => {
    const row = (await tx.get(ref)).data(),
      now = Date.now();
    if (
      !row ||
      !["ready", "submitted", "pending"].includes(row.state) ||
      row.leaseUntil > now
    )
      return null;
    if (
      row.state === "ready" &&
      process.env.HILEHANEM_PURCHASING_ENABLED !== "true"
    )
      return null;
    tx.update(ref, {
      lease,
      leaseUntil: now + 60000,
      attempts: (row.attempts || 0) + 1,
      state: "submitted",
      nextAttemptAt: now + 60000,
    });
    return row;
  });
  if (!job) return;
  try {
    // The first claim is the only one allowed to POST. Every recovery attempt is a lookup.
    const outcome =
      job.state === "ready"
        ? await provider.purchase(job)
        : await provider.lookup(job);
    if (outcome.state === "completed") {
      await settle(ref, job, outcome, { db, lease });
      await synchronizeStock(job, { db, provider }).catch(() => {});
      return;
    }
    if (outcome.state === "rejected") {
      await reject(ref, job, { db, lease });
      return;
    }
  } catch {
    // A lost response or an incomplete receipt never proves that the provider rejected payment.
  }
  await db.runTransaction(async (tx) => {
    const row = (await tx.get(ref)).data();
    if (row?.lease !== lease || row.state !== "submitted") return;
    tx.update(ref, {
      state: "pending",
      needsReview: row.attempts >= 10,
      leaseUntil: 0,
      nextAttemptAt:
        Date.now() + Math.min(900000, 15000 * 2 ** Math.min(row.attempts, 6)),
      lastError: "HILEHANEM_RESULT_REQUIRES_RECONCILIATION",
    });
  });
}
async function settle(ref, job, outcome, { db, lease }) {
  const userRef = db.collection("users").doc(job.uid),
    orderRef = db.collection("storeOrders").doc(job.orderId),
    receipt = db
      .collection("storeSupplierReceipts")
      .doc(C.hash("hilehanem", outcome.reference));
  await db.runTransaction(async (tx) => {
    const [snap, user, order, oldReceipt] = await Promise.all([
      tx.get(ref),
      tx.get(userRef),
      tx.get(orderRef),
      tx.get(receipt),
    ]);
    const current = snap.data();
    if (!current || current.state !== "submitted" || current.lease !== lease)
      return;
    if (
      !order.exists ||
      order.data().uid !== job.uid ||
      order.data().supplierState !== "reserved" ||
      order.data().totalKurus !== job.saleKurus
    )
      C.fail("STORE_ORDER_CONFLICT", 409);
    if (oldReceipt.exists && oldReceipt.data().orderId !== job.orderId)
      C.fail("HILEHANEM_RECEIPT_REUSED", 409);
    if (
      outcome.currency !== job.currency ||
      !Number.isSafeInteger(outcome.costMinor) ||
      outcome.costMinor < 0 ||
      outcome.costMinor > job.maximumCostMinor ||
      !Array.isArray(outcome.licenses) ||
      outcome.licenses.length !== job.quantity
    )
      C.fail("HILEHANEM_RESPONSE_INVALID", 409);
    const p = user.data() || {},
      balance = M.readStoredBalance(p),
      held = M.checkedBalance(p.storeBalanceHeldKurus || 0);
    if (held < job.saleKurus || balance < job.saleKurus)
      C.fail("STORE_BALANCE_RECORD_INVALID", 409);
    const discount = await coupons.readReservedPromotion(
      tx,
      db,
      job.uid,
      order.data().promotion,
    );
    const deliveries =
      await require("../core/storeInventoryService").attachManualDeliveryInTransaction(
        {
          tx,
          db,
          orderId: job.orderId,
          uid: order.data().giftRecipientUid || job.uid,
          items: order.data().items,
          values: outcome.licenses,
          source: "hilehanem-api",
        },
      );
    const now = Date.now();
    coupons.finishReservedPromotion(tx, discount, job.uid, job.orderId, true);
    tx.update(userRef, {
      storeBalanceKurus: balance - job.saleKurus,
      storeBalanceHeldKurus: held - job.saleKurus,
      storeOrderCount: dependencies().admin.firestore.FieldValue.increment(1),
      storeUpdatedAt: now,
    });
    tx.create(
      db.collection("storeWalletLedger").doc("purchase_" + job.orderId),
      {
        uid: job.uid,
        type: "DEBIT",
        amountKurus: -job.saleKurus,
        balanceBeforeKurus: balance,
        balanceAfterKurus: balance - job.saleKurus,
        orderId: job.orderId,
        reason: "Hilehanem tedarikli mağaza satın alımı",
        createdAt: now,
      },
    );
    const completed = {
      ...order.data(),
      status: "delivered",
      supplierState: "completed",
      approvedAt: now,
      paidAt: now,
      fulfillmentStatus: "TESLIM_EDILDI",
      delivery: {
        status: "delivered",
        title: "Dijital teslimatınız hazır",
        message:
          "Lisans bilgilerinize korumalı teslimat alanından ulaşabilirsiniz.",
        itemCount: deliveries.length,
        automatic: true,
        deliveredAt: now,
      },
      updatedAt: now,
    };
    tx.set(orderRef, completed);
    tx.update(ref, {
      state: "completed",
      nextAttemptAt: Number.MAX_SAFE_INTEGER,
      costMinor: outcome.costMinor,
      providerReference: outcome.reference,
      completedAt: now,
      leaseUntil: 0,
    });
    tx.set(receipt, {
      orderId: job.orderId,
      uid: job.uid,
      currency: job.currency,
      costMinor: outcome.costMinor,
      createdAt: now,
    });
    require("../email/service").orderEvent(tx, db, completed, {
      previous: order.data(),
    });
    require("../commerce/orders").timeline(
      tx,
      db,
      job.orderId,
      "delivered",
      now,
      "supplier-worker",
    );
  });
  require("../core/firestorePagination").invalidateCreatedAtPageCache(
    "storeOrders",
  );
  require("../core/firestorePagination").invalidateCreatedAtPageCache(
    "storeWalletLedger",
  );
}
async function reject(ref, job, { db, lease }) {
  await db.runTransaction(async (tx) => {
    const [row, user, order] = await Promise.all([
      tx.get(ref),
      tx.get(db.collection("users").doc(job.uid)),
      tx.get(db.collection("storeOrders").doc(job.orderId)),
    ]);
    if (row.data()?.lease !== lease || row.data()?.state !== "submitted")
      return;
    if (
      !order.exists ||
      order.data().uid !== job.uid ||
      order.data().supplierState !== "reserved"
    )
      C.fail("STORE_ORDER_CONFLICT", 409);
    const discount = await coupons.readReservedPromotion(
      tx,
      db,
      job.uid,
      order.data().promotion,
    );
    const held = M.checkedBalance(user.data()?.storeBalanceHeldKurus || 0);
    if (held < job.saleKurus) C.fail("STORE_BALANCE_RECORD_INVALID", 409);
    coupons.finishReservedPromotion(tx, discount, job.uid, job.orderId, false);
    tx.update(user.ref, { storeBalanceHeldKurus: held - job.saleKurus });
    tx.update(order.ref, {
      status: "payment_rejected",
      supplierState: "rejected",
      fulfillmentStatus: "TEDARIK_REDDEDILDI",
      updatedAt: Date.now(),
    });
    require("../commerce/orders").timeline(
      tx,
      db,
      job.orderId,
      "payment_rejected",
      Date.now(),
      "supplier-worker",
    );
    tx.update(ref, {
      state: "rejected",
      nextAttemptAt: Number.MAX_SAFE_INTEGER,
      leaseUntil: 0,
      completedAt: Date.now(),
    });
    require("../core/notificationEvents").record(tx, db, {
      uid: job.uid,
      type: "order_cancelled",
      key: job.orderId,
      data: {
        orderId: job.orderId,
        message:
          "Tedarik işlemi onaylanamadı. Bakiye rezervasyonunuz kaldırıldı; hesabınızdan tahsilat yapılmadı.",
      },
    });
  });
}
async function synchronizeStock(
  job,
  { db = dependencies().db, provider } = {},
) {
  provider ||= require("./hilehanem-contract").adapter();
  const checkedAt = Date.now(),
    quote = await provider.quote(job);
  if (
    quote.productId !== job.productId ||
    quote.packageId !== job.packageId ||
    quote.currency !== job.currency
  )
    C.fail("HILEHANEM_MAPPING_MISMATCH");
  const ref = db
    .collection("storeSupplierStock")
    .doc(C.hash(job.productId, job.packageId));
  await db.runTransaction(async (tx) => {
    if (((await tx.get(ref)).data()?.checkedAt || 0) <= checkedAt)
      tx.set(ref, { ...quote, checkedAt });
  });
  clearPublicStock();
  require("../core/storeInventoryService").invalidateStockCache();
  return quote;
}
async function resume({ db = dependencies().db, provider } = {}) {
  if (!db) return 0;
  const rows = await db
    .collection(JOBS)
    .where("nextAttemptAt", "<=", Date.now())
    .orderBy("nextAttemptAt")
    .limit(20)
    .get();
  for (const row of rows.docs) await processOrder(row.id, { db, provider });
  return rows.size;
}
let lastSync = 0;
async function refreshMappedStock() {
  const { mappings, adapter } = require("./hilehanem-contract"),
    rows = mappings();
  if (!rows.length || Date.now() - lastSync < 45000) return;
  lastSync = Date.now();
  const provider = adapter(),
    db = dependencies().db;
  for (let offset = 0; offset < rows.length; offset += 5)
    await Promise.allSettled(
      rows
        .slice(offset, offset + 5)
        .map((row) => synchronizeStock(row, { db, provider })),
    );
}
let publicStockCache, publicStockPending, publicStockGeneration=0;
function clearPublicStock() { publicStockGeneration++; publicStockCache=null; publicStockPending=null; }
async function publicSnapshots(db, refs) {
  const ids=refs.map(ref=>ref.id), signature=JSON.stringify(ids), now=Date.now();
  const admin=require("../config/firebaseAdmin").initFirebaseAdmin().admin;
  const ready=require("../core/catalogCacheWatch").observeIds("supplier",db.collection("storeSupplierStock"),admin.firestore.FieldPath.documentId(),ids,clearPublicStock);
  if(ready && publicStockCache?.db===db && publicStockCache.signature===signature && now-publicStockCache.at<30000) return publicStockCache.rows;
  if(publicStockPending?.db===db && publicStockPending.signature===signature) return publicStockPending.promise;
  const generation=publicStockGeneration;
  const promise=db.getAll(...refs).then(rows=>{
    if(generation===publicStockGeneration) publicStockCache={db,signature,at:now,rows};
    return rows;
  }).finally(()=>{if(publicStockPending?.promise===promise)publicStockPending=null;});
  publicStockPending={signature,promise,db};
  return promise;
}
async function decorate(catalog, { db = dependencies().db, cacheStock=false } = {}) {
  const packages = new Set(catalog.products.flatMap(product => product.plans.map(plan => product.id + "__" + plan.key)));
  const bindings = require("./hilehanem-contract").mappings().filter(binding => packages.has(binding.id));
  if (!bindings.length || !db) return catalog;
  const refs = bindings.map((b) =>
    db.collection("storeSupplierStock").doc(C.hash(b.productId, b.packageId)),
  );
  const snapshots = cacheStock ? await publicSnapshots(db,refs) : await db.getAll(...refs);
  const stock = new Map(
    bindings.map((b, index) => {
      const row = snapshots[index].data();
      const valid =
        row &&
        Date.now() - row.checkedAt < 150000 &&
        row.currency === b.currency &&
        row.unitCostMinor <= b.maximumUnitCostMinor;
      return [b.id, valid ? row : null];
    }),
  );
  return {
    ...catalog,
    products: catalog.products.map((p) => {
      let mapped = false;
      const plans = p.plans.map((plan) => {
        const key = p.id + "__" + plan.key;
        if (!stock.has(key)) return plan;
        mapped = true;
        const row = stock.get(key),
          available = row?.stock || 0;
        return {
          ...plan,
          stock: {
            ...plan.stock,
            available,
            state: row
              ? available
                ? "in_stock"
                : "out_of_stock"
              : "unverified",
            automaticDelivery: true,
          },
        };
      });
      if (!mapped) return p;
      const available = plans.reduce(
        (n, x) => n + (x.stock?.available || 0),
        0,
      );
      return {
        ...p,
        plans,
        stock: {
          ...p.stock,
          available,
          state: available
            ? "in_stock"
            : plans.some((x) => x.stock?.state === "unverified")
              ? "unverified"
              : "out_of_stock",
        },
      };
    }),
  };
}
module.exports = {
  bindingFor,
  start,
  processOrder,
  resume,
  synchronizeStock,
  refreshMappedStock,
  decorate,
};
