"use strict";
const C = require("./common");
const { createWorker } = require("../core/workerScheduler");
async function priceNotifications() {
  const database = C.db(),
    jobs = await database
      .collection("storePriceJobs")
      .where("state", "==", "pending")
      .orderBy("createdAt", "asc")
      .limit(1)
      .get();
  for (const job of jobs.docs) {
    const row = job.data();
    let query = database
      .collection("storeProductWatches")
      .where("productId", "==", row.productId)
      .where("price", "==", true)
      .orderBy("__name__", "asc");
    if (row.cursor) {
      const anchor = await database
        .collection("storeProductWatches")
        .doc(row.cursor)
        .get();
      if (anchor.exists) query = query.startAfter(anchor);
    }
    const watchers = await query.limit(20).get();
    for (const doc of watchers.docs)
      await database.runTransaction(async (tx) => {
        const watch = await tx.get(doc.ref),
          profile = await tx.get(
            database.collection("storeCommerceProfiles").doc(doc.data().uid),
          );
        if (
          watch.data()?.price !== true ||
          profile.data()?.preferences?.priceNotifications !== true
        )
          return;
        const ref = database
          .collection("storeNotifications")
          .doc(C.hash(doc.data().uid, "price:" + job.id));
        if ((await tx.get(ref)).exists) return;
        C.notification(
          tx,
          database,
          doc.data().uid,
          "price:" + job.id,
          "Takip ettiğin ürünün fiyatı düştü",
          "Güncel paket fiyatını ürün sayfasında inceleyebilirsin.",
          {
            productId: row.productId,
            planKey: row.planKey,
            priceKurus: row.priceKurus,
          },
        );
      });
    await job.ref.update({
      cursor: watchers.docs.at(-1)?.id || row.cursor || "",
      state: watchers.size < 20 ? "completed" : "pending",
      updatedAt: Date.now(),
    });
  }
  return jobs.size;
}
async function stockNotifications() {
  const database = C.db(),
    watches = await database
      .collection("storeProductWatches")
      .where("stock", "==", true)
      .orderBy("checkedAt", "asc")
      .limit(10)
      .get();
  if (!watches.size) return 0;
  const catalog = await require("../core/storeService").publicCatalog();
  if (catalog.stockVerified === false) return 0;
  for (const doc of watches.docs) {
    const row = doc.data(),
      product = catalog.products.find((p) => p.id === row.productId),
      available = Number(product?.stock?.available || 0);
    await database.runTransaction(async (tx) => {
      const [fresh, profile] = await Promise.all([
        tx.get(doc.ref),
        tx.get(database.collection("storeCommerceProfiles").doc(row.uid)),
      ]);
      if (fresh.data()?.stock !== true) return;
      if (
        available > 0 &&
        (fresh.data().lastAvailable || 0) === 0 &&
        profile.data()?.preferences?.stockNotifications === true
      )
        C.notification(
          tx,
          database,
          row.uid,
          "stock:" + doc.id + ":" + (fresh.data().checkedAt || row.createdAt),
          "Takip ettiğin ürün stokta",
          "Güncel paket ve stok durumunu inceleyebilirsin.",
          { productId: row.productId },
        );
      tx.update(doc.ref, { checkedAt: Date.now(), lastAvailable: available });
    });
  }
  return 0;
}
async function licenseReminders() {
  const database = C.db(),
    rows = await database
      .collection("storeOrderExperience")
      .where("licenseReminderDueAt", ">", 0)
      .where("licenseReminderDueAt", "<=", Date.now())
      .limit(10)
      .get();
  for (const doc of rows.docs)
    await database.runTransaction(async (tx) => {
      const fresh = await tx.get(doc.ref),
        row = fresh.data();
      if (!row?.licenseReminderDueAt || row.licenseReminderDueAt > Date.now())
        return;
      const order = await tx.get(
          database.collection("storeOrders").doc(row.orderId),
        ),
        uid = order.data()?.giftRecipientUid || row.uid;
      const profile = uid
        ? await tx.get(database.collection("storeCommerceProfiles").doc(uid))
        : null;
      if (
        order.data()?.status === "delivered" &&
        profile?.data()?.preferences?.licenseReminders === true
      )
        C.notification(
          tx,
          database,
          uid,
          "license:" + doc.id + ":" + row.license.expiresAt,
          "Lisans süren yaklaşıyor",
          "Doğrulanmış bitiş tarihini siparişinde inceleyebilirsin.",
          { orderId: doc.id, expiresAt: row.license.expiresAt },
        );
      tx.update(doc.ref, {
        licenseReminderDueAt: 0,
        licenseReminderCheckedAt: Date.now(),
      });
    });
  return rows.size;
}
let phase = 0;
async function run() {
  if (!require("../config/firebaseAdmin").initFirebaseAdmin().db) return 0;
  await require("./reservations").expire();
  const count = await [
    priceNotifications,
    stockNotifications,
    licenseReminders,
  ][phase++ % 3]();
  return count;
}
const worker = createWorker({
  run,
  idleMs: 60000,
  activeMs: 15000,
  onError: (error) =>
    require("../core/errorLogger").logError(error, {
      event: "commerce.worker",
    }),
});
module.exports = {
  priceNotifications,
  stockNotifications,
  licenseReminders,
  run,
  start: worker.start,
  stop: worker.stop,
  status: worker.status,
};
