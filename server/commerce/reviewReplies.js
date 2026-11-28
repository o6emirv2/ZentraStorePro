"use strict";
const C = require("./common");
const { readPublicProfiles, memberProfile, unavailableProfile } = require("./publicProfiles");
const { createdAtPage, invalidateCreatedAtPageCache } = require("../core/firestorePagination");
const { verifiedOrder } = require("./catalog");

async function requireParent(reader, database, productId, reviewId) {
  const ref = database.collection("storeReviews").doc(reviewId);
  const snap = await reader(ref),
    row = snap.data();
  if (!row || row.productId !== productId || row.status !== "published")
    C.fail("COMMERCE_REVIEW_NOT_FOUND", 404);
  if (
    row.verifiedPurchase !== true &&
    (!row.orderId ||
      !verifiedOrder(
        (await reader(database.collection("storeOrders").doc(row.orderId))).data(),
        row.uid,
        productId,
      ))
  )
    C.fail("COMMERCE_REVIEW_NOT_FOUND", 404);
  return { ref, row };
}

async function list(productId, reviewId, cursor = "") {
  C.id(productId, 80);
  C.id(reviewId);
  const db = C.db();
  await requireParent((ref) => ref.get(), db, productId, reviewId);
  const page = await createdAtPage({
    db,
    collection: "storeReviewReplies",
    filters: [["reviewId", reviewId]],
    limit: 12,
    cursor,
  });
  const profiles = await readPublicProfiles(
    db,
    page.docs.map((doc) => doc.data().uid),
  );
  return {
    reviewId,
    items: page.docs.map((doc) => {
      const r = doc.data();
      return {
        id: doc.id,
        message: r.message,
        createdAt: r.createdAt,
        profile: profiles.get(r.uid) || unavailableProfile(),
      };
    }),
    nextCursor: page.nextCursor,
  };
}
async function add(uid, productId, reviewId, input) {
  C.id(productId, 80);
  C.id(reviewId);
  C.object(input, ["orderId", "message", "mutationId"]);
  const orderId = C.id(input.orderId),
    message = C.text(input.message, 1500, { required: true });
  if (message.length < 3) C.fail("COMMERCE_REPLY_TOO_SHORT");
  const id = C.hash(uid, reviewId, C.id(input.mutationId)),
    database = C.db(),
    ref = database.collection("storeReviewReplies").doc(id);
  const result = await database.runTransaction(async (tx) => {
    await require("../core/productDeletion").assertLive(tx, database, productId);
    const { ref: parent, row } = await requireParent(
      (doc) => tx.get(doc),
      database,
      productId,
      reviewId,
    );
    const [buyer, order, previous] = await Promise.all([
      C.activeUser(uid, { transaction: tx, database }),
      C.orderForUser(uid, orderId, { transaction: tx, database }),
      tx.get(ref),
    ]);
    if (!verifiedOrder(order, uid, productId)) C.fail("COMMERCE_VERIFIED_PURCHASE_REQUIRED", 403);
    if (row.uid === uid) C.fail("COMMERCE_REPLY_TO_SELF", 403);
    if (previous.exists) {
      if (previous.data().message !== message || previous.data().productId !== productId)
        C.fail("COMMERCE_REPLY_CHANGED", 409);
      return { id, reviewId, replyCount: row.replyCount || 0, replayed: true };
    }
    const author = await memberProfile(database, uid, buyer, (ref) => tx.get(ref));
    if (!author.username) C.fail("COMMUNITY_USERNAME_REQUIRED", 409);
    const createdAt = Date.now(),
      replyCount = (row.replyCount || 0) + 1;
    tx.create(ref, { uid, orderId, reviewId, productId, message, createdAt });
    tx.update(parent, { replyCount });
    tx.set(
      database.collection("storeReviewParticipation").doc(C.hash(uid, productId)),
      { uid, productId, replied: true },
      { merge: true },
    );
    return { id, reviewId, replyCount };
  });
  invalidateCreatedAtPageCache("storeReviewReplies");
  invalidateCreatedAtPageCache("storeReviews");
  return result;
}
module.exports = { list, add };
