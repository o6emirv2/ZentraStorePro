"use strict";
const crypto = require("node:crypto");
const C = require("./common");
const catalog = require("./catalog");
const { purposeKey } = require("../core/adminAccessService");
const { createdAtPage } = require("../core/firestorePagination");
const { readPublicProfiles, unavailableProfile } = require("./publicProfiles");
const { sealCursor, openCursor } = require("./communityPaging");
function actor(uid) {
  if (!uid) C.fail("AUTH_REQUIRED", 401);
  return "member:" + C.hash(C.uid(uid));
}
function reactionView(counter = {}, record = {}) {
  const likes = counter.likes ?? 0;
  if (!Number.isSafeInteger(likes) || likes < 0) C.fail("COMMUNITY_INTEGRITY_REQUIRED", 503);
  return {
    likes,
    liked: record.liked === true,
    revision: record.revision || 0,
  };
}
// Keep only a bounded index of candidate order IDs. Every hit is revalidated against the source order.
const purchaseHints = new Map();
function rememberPurchase(key, orderId, database) {
  purchaseHints.delete(key);
  if (purchaseHints.size >= 512) purchaseHints.delete(purchaseHints.keys().next().value);
  purchaseHints.set(key, { database, orderId, until: Date.now() + 120000 });
}
async function reviewEligibility(uid, productId) {
  if (!uid) return { eligible: false, reason: "sign-in" };
  const { auth } = require("../config/firebaseAdmin").initFirebaseAdmin();
  let user;
  try {
    user = await auth.getUser(uid);
  } catch {
    C.fail("AUTH_UNAVAILABLE", 503);
  }
  if (user.disabled || !user.emailVerified)
    return { eligible: false, reason: "verification-required" };
  const access = await require("../core/accountActivation").accountAccess(
    { uid, email: user.email },
    { user },
  );
  if (!access.ready) return { eligible: false, reason: "verification-required" };
  const database = C.db();
  const previous = await database.collection("storeReviews").where("uid","==",uid).where("productId","==",productId).limit(1).get();
  const existing = previous.docs[0];
  const rights = orderId => ({eligible:!existing,canReply:true,orderId,...(existing?{reason:"already-reviewed"}:{})});
  if (existing?.data().orderId) {
    const order = await database.collection("storeOrders").doc(existing.data().orderId).get();
    if (catalog.verifiedOrder(order.data(),uid,productId)) return rights(order.id);
  }
  const key = C.hash(uid, productId),
    hint = purchaseHints.get(key);
  if (hint) {
    if (hint.database === database && hint.until > Date.now()) {
      const order = await database.collection("storeOrders").doc(hint.orderId).get();
      if (catalog.verifiedOrder(order.data(), uid, productId))
        return rights(order.id);
    }
    purchaseHints.delete(key);
  }
  const field = require("../config/firebaseAdmin")
    .initFirebaseAdmin()
    .admin.firestore.FieldPath.documentId();
  const orders = database
    .collection("storeOrders")
    .where("uid", "==", uid)
    .orderBy(field)
    .select(
      "uid",
      "status",
      "items",
      "paidAt",
      "approvedAt",
      "walletPaidAt",
      "walletRefundedAt",
      "manualPayment",
      "manualRefund",
      "paymentMethod",
      "paymentState",
      "salesChannel",
      "fulfillmentStatus",
      "supplier",
      "supplierState",
    )
    .limit(100);
  let cursor;
  for (;;) {
    const page = await (cursor ? orders.startAfter(cursor) : orders).get();
    const match = page.docs.find((doc) => catalog.verifiedOrder(doc.data(), uid, productId));
    if (match) {
      rememberPurchase(key, match.id, database);
      return rights(match.id);
    }
    if (page.size < 100) return { eligible:false,canReply:false,reason:existing ? "already-reviewed" : "purchase-required" };
    cursor = page.docs.at(-1).id;
  }
}
async function read(productId, { uid = "", cursor = "" } = {}) {
  productId = (await catalog.resolveProduct(productId)).id;
  const database = C.db(),
    identity = uid ? actor(uid) : "";
  const [counter, record, reviews, eligibility] = await Promise.all([
    database.collection("storeProductCommunity").doc(productId).get(),
    identity
      ? database.collection("storeProductReactions").doc(C.hash(productId, identity)).get()
      : null,
    createdAtPage({
      db: database,
      collection: "storeReviews",
      filters: [
        ["productId", productId],
        ["status", "published"],
      ],
      limit: 20,
      cursor,
    }),
    reviewEligibility(uid, productId),
  ]);
  const verifiedReviews = await catalog.verifiedReviews(database, reviews.docs, productId);
  const profiles = await readPublicProfiles(database, [
    ...verifiedReviews.map((doc) => doc.data().uid),
    uid,
  ]);
  return {
    productId,
    ...reactionView(counter.data(), record?.data()),
    reviews: verifiedReviews.map((d) => {
      const r = d.data();
      return {
        id: d.id,
        title: r.title,
        message: r.message,
        rating: r.rating,
        replyCount:r.replyCount || 0,
        canReply:eligibility.canReply === true && r.uid !== uid,
        displayName: profiles.get(r.uid)?.username || "Zentra üyesi",
        profile: profiles.get(r.uid) || unavailableProfile(),
        createdAt: r.createdAt,
        verifiedPurchase: true,
      };
    }),
    nextCursor: reviews.nextCursor,
    eligibility,
    ...(uid ? { viewerProfile: profiles.get(uid) || unavailableProfile() } : {}),
  };
}

async function likers(productId, { cursor = "" } = {}) {
  productId = (await catalog.resolveProduct(productId)).id;
  const database = C.db(),
    collection = database.collection("storeProductReactions");
  let query = collection
    .where("productId", "==", productId)
    .where("liked", "==", true)
    .orderBy("updatedAt", "desc");
  if (cursor) {
    const anchor = await collection.doc(openCursor(productId, cursor)).get();
    if (!anchor.exists || anchor.data().productId !== productId)
      C.fail("COMMUNITY_CURSOR_INVALID", 400);
    query = query.startAfter(anchor);
  }
  const snapshot = await query.limit(21).get(),
    docs = snapshot.docs.slice(0, 20);
  const members = docs.map((doc) => {
    const row = doc.data();
    let member = "";
    try {
      if (row.memberUid && actor(row.memberUid) === row.actor) member = row.memberUid;
    } catch {}
    return member;
  });
  const profiles = await readPublicProfiles(database, members);
  return {
    productId,
    people: docs.map((doc, index) => {
      const row = doc.data();
      return {
        id: crypto
          .createHmac("sha256", purposeKey("community-person-v1"))
          .update(productId + "|" + doc.id)
          .digest("base64url")
          .slice(0, 24),
        profile: row.actor?.startsWith("visitor:")
          ? { kind: "guest", username: "", avatarUrl: "" }
          : profiles.get(members[index]) || unavailableProfile(),
      };
    }),
    nextCursor: snapshot.docs.length > 20 ? sealCursor(productId, docs.at(-1).id) : "",
  };
}
async function like(productId, { uid = "" } = {}, input) {
  const identity = actor(uid);
  C.object(input, ["liked", "mutationId", "expectedRevision"]);
  const liked = C.flag(input.liked),
    mutationId = C.id(input.mutationId, 100),
    revision = C.integer(input.expectedRevision, 0);
  if (mutationId.length < 12) C.fail("COMMERCE_ID_INVALID");
  productId = (await catalog.resolveProduct(productId)).id;
  const database = C.db();
  const counterRef = database.collection("storeProductCommunity").doc(productId);
  const recordRef = database.collection("storeProductReactions").doc(C.hash(productId, identity));
  const receiptRef = database
    .collection("storeProductReactionReceipts")
    .doc(C.hash(productId, identity, mutationId));
  return database.runTransaction(async (tx) => {
    await require("../core/productDeletion").assertLive(tx, database, productId);
    await C.activeUser(uid, { transaction: tx, database });
    const [counter, record, receipt] = await Promise.all([
      tx.get(counterRef),
      tx.get(recordRef),
      tx.get(receiptRef),
    ]);
    const current = reactionView(counter.data(), record.data());
    if (receipt.exists) {
      if (receipt.data().liked !== liked || receipt.data().expectedRevision !== revision)
        C.fail("COMMUNITY_OPERATION_CONFLICT", 409);
      return { productId, ...current, replayed: true };
    }
    if (current.revision !== revision) C.fail("COMMUNITY_REVISION_CONFLICT", 409);
    const likes = current.likes + Number(liked) - Number(current.liked);
    if (likes < 0 || !Number.isSafeInteger(likes)) C.fail("COMMUNITY_INTEGRITY_REQUIRED", 503);
    const next = {
      liked,
      revision: current.revision + 1,
      updatedAt: Date.now(),
    };
    tx.set(recordRef, { ...next, productId, actor: identity, memberUid: uid });
    tx.set(counterRef, { productId, likes, updatedAt: Date.now() }, { merge: true });
    tx.create(receiptRef, {
      uid,productId,
      liked,
      expectedRevision: revision,
      createdAt: Date.now(),
    });
    return {
      productId,
      likes,
      liked,
      revision: next.revision,
      replayed: false,
    };
  });
}
module.exports = { actor, read, like, likers, reviewEligibility };
