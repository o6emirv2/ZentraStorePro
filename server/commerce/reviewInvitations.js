"use strict";
const C = require("./common");
const { initFirebaseAdmin } = require("../config/firebaseAdmin");
const { createWorker, quotaError } = require("../core/workerScheduler");
const { verifiedOrder } = require("./catalog");
const jobs = "storeReviewInvitationJobs";
const FINAL = 8640000000000000;
const PAGE = 40;
const byId = () => initFirebaseAdmin().admin.firestore.FieldPath.documentId();

function productIds(items) {
  return [
    ...new Set(
      (Array.isArray(items) ? items : [])
        .map((item) => item?.productId)
        .filter((id) => typeof id === "string" && id),
    ),
  ];
}
function schedule(tx, db, reviewId, review) {
  tx.create(db.collection(jobs).doc(reviewId), {
    productId: review.productId,
    reviewId,
    createdAt: review.createdAt,
    availableAt: review.createdAt,
    state: "pending",
    cursor: "",
    queued: 0,
    failures: 0,
  });
}
// Older orders contain product IDs only inside line-item maps. Build the searchable projection once.
async function indexPage(db) {
  const ref = db.collection("storeWorkerState").doc("review-order-products-v1");
  return db.runTransaction(async (tx) => {
    const state = (await tx.get(ref)).data() || {};
    if (state.complete) return true;
    let q = db
      .collection("storeOrders")
      .orderBy(byId())
      .select("items", "reviewProductIds")
      .limit(81);
    if (state.cursor) q = q.startAfter(state.cursor);
    const page = await tx.get(q),
      docs = page.docs.slice(0, 80);
    for (const doc of docs) {
      const row = doc.data(),
        ids = productIds(row.items);
      if (JSON.stringify(row.reviewProductIds) !== JSON.stringify(ids))
        tx.update(doc.ref, { reviewProductIds: ids });
    }
    const complete = page.size <= 80;
    tx.set(ref, { complete, cursor: docs.at(-1)?.id || state.cursor || "" });
    return complete;
  });
}
function purchasedBy(row, uid, productId, cutoff) {
  if (!verifiedOrder(row, uid, productId)) return false;
  const paid = [row.paidAt, row.walletPaidAt, row.manualPayment?.verifiedAt, row.approvedAt].filter(
    (n) => Number(n) > 0,
  );
  return paid.length > 0 && Math.min(...paid) <= cutoff;
}
async function participated(read, db, uid, productId) {
  const [review, reply] = await Promise.all([
    read(
      db
        .collection("storeReviews")
        .where("uid", "==", uid)
        .where("productId", "==", productId)
        .limit(1),
    ),
    read(db.collection("storeReviewParticipation").doc(C.hash(uid, productId))),
  ]);
  return !review.empty || reply.exists;
}
async function validTrigger(read, db, reviewId, productId) {
  const review = (await read(db.collection("storeReviews").doc(reviewId))).data();
  if (review?.status !== "published" || review.productId !== productId || !review.orderId)
    return null;
  const order = (await read(db.collection("storeOrders").doc(review.orderId))).data();
  return verifiedOrder(order, review.uid, productId) ? review : null;
}
async function processPage(db, ref) {
  return db.runTransaction(async (tx) => {
    const read = (doc) => tx.get(doc),
      job = (await read(ref)).data(),
      now = Date.now();
    if (job?.state !== "pending" || job.availableAt > now) return;
    const review = await validTrigger(read, db, job.reviewId, job.productId);
    if (!review) {
      tx.update(ref, { state: "cancelled", availableAt: FINAL, updatedAt: now });
      return;
    }
    let q = db
      .collection("storeOrders")
      .where("reviewProductIds", "array-contains", job.productId)
      .orderBy(byId())
      .limit(PAGE + 1);
    if (job.cursor) q = q.startAfter(job.cursor);
    const page = await read(q),
      docs = page.docs.slice(0, PAGE),
      candidates = new Map();
    for (const doc of docs) {
      const order = doc.data();
      if (
        order.uid &&
        order.uid !== review.uid &&
        purchasedBy(order, order.uid, job.productId, job.createdAt)
      )
        candidates.set(order.uid, doc.id);
    }
    const entries = await Promise.all(
      [...candidates].map(async ([uid, orderId]) => {
        const outbox = db
          .collection("storeEmailOutbox")
          .doc(C.hash(uid, "review_invitation", job.reviewId));
        const [prior, contributed, prefs] = await Promise.all([
          read(outbox),
          participated(read, db, uid, job.productId),
          read(db.collection("storeCommerceProfiles").doc(uid)),
        ]);
        return !prior.exists &&
          !contributed &&
          prefs.data()?.preferences?.emailReviewInvitations !== false
          ? { uid, orderId }
          : null;
      }),
    );
    let queued = 0;
    for (const target of entries.filter(Boolean)) {
      require("../email/service").enqueue(tx, db, {
        uid: target.uid,
        type: "review_invitation",
        key: job.reviewId,
        data: {
          productId: job.productId,
          reviewId: job.reviewId,
          orderId: target.orderId,
          cutoff: job.createdAt,
        },
        now,
      });
      queued++;
    }
    const done = page.size <= PAGE;
    tx.update(ref, {
      state: done ? "completed" : "pending",
      availableAt: done ? FINAL : now,
      cursor: docs.at(-1)?.id || job.cursor,
      queued: (job.queued || 0) + queued,
      failures: 0,
      lastError: "",
      updatedAt: now,
    });
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
  if (due.empty) return 0;
  if (!(await indexPage(db))) return due.size;
  for (const doc of due.docs) {
    try {
      await processPage(db, doc.ref);
    } catch (error) {
      if (quotaError(error)) throw error;
      await db.runTransaction(async (tx) => {
        const row = (await tx.get(doc.ref)).data();
        if (
          row?.state !== "pending" ||
          row.cursor !== doc.data().cursor ||
          row.availableAt > Date.now()
        )
          return;
        const failures = (row.failures || 0) + 1;
        tx.update(doc.ref, {
          failures,
          lastError: String(error.code || "REVIEW_INVITATION_WORKER_FAILED").slice(0, 80),
          availableAt: Date.now() + Math.min(3600000, 5000 * 2 ** Math.min(failures, 10)),
        });
      });
      require("../core/errorLogger").logError(error, {
        event: "review.invitations",
        source: doc.id,
      });
    }
  }
  require("../email/service").wake();
  return due.size;
}
async function dispatchOrder(db, job, read = (ref) => ref.get(), preferred = job.data.orderId) {
  const { reviewId, productId, cutoff } = job.data;
  const [source, contributed, order] = await Promise.all([
    validTrigger(read, db, reviewId, productId),
    participated(read, db, job.uid, productId),
    read(db.collection("storeOrders").doc(preferred)),
  ]);
  if (!source || source.uid === job.uid || contributed) return "";
  if (purchasedBy(order.data(), job.uid, productId, cutoff)) return preferred;
  // A second, still valid purchase can qualify if the originally selected order was refunded.
  const query = db.collection("storeOrders").where("uid", "==", job.uid).orderBy(byId()).limit(60);
  let cursor;
  for (;;) {
    const page = await read(cursor ? query.startAfter(cursor) : query);
    const found = page.docs.find((doc) => purchasedBy(doc.data(), job.uid, productId, cutoff));
    if (found) return found.id;
    if (page.size < 60) return "";
    cursor = page.docs.at(-1).id;
  }
}
async function facts(db, job) {
  const orderId = await dispatchOrder(db, job);
  if (!orderId) return null;
  try {
    const product = await require("./catalog").resolveProduct(job.data.productId);
    return { product: { id: product.id, name: product.name }, qualifyingOrderId: orderId };
  } catch (error) {
    if (error.code === "STORE_ITEM_UNAVAILABLE") return null;
    throw error;
  }
}
const worker = createWorker({
  run,
  idleMs: 60000,
  onError: (error) =>
    require("../core/errorLogger").logError(error, { event: "review.invitations" }),
});
module.exports = { schedule, run, worker, productIds, facts, dispatchOrder };
