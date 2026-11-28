"use strict";
const { test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { applicationFixture } = require("./helpers/application-fixture.cjs");
let f, db, product, previous, identities, invitations, email, community, catalog;
before(async () => {
  f = await applicationFixture({
    transientStore: "memory",
    rateLimitStore: "memory",
    appCheckMode: "off",
  });
  db = f.db;
  invitations = require("../server/commerce/reviewInvitations");
  email = require("../server/email/service");
  community = require("../server/commerce/community");
  catalog = require("../server/commerce/catalog");
  product = (await f.request("/api/store/catalog")).body.catalog.products[0];
  previous = structuredClone([...db.records]);
  identities = structuredClone([...f.users]);
});
beforeEach(() => {
  db.records.clear();
  for (const [k, v] of structuredClone(previous)) db.records.set(k, v);
  f.users.clear();
  for (const [k, v] of structuredClone(identities)) f.users.set(k, v);
  require("../server/core/firestorePagination").invalidateCreatedAtPageCache();
  process.env.EMAIL_NOTIFICATIONS_ENABLED = "true";
  process.env.RESEND_API_KEY = "re_" + randomUUID().replaceAll("-", "");
});
after(async () => {
  await f?.close();
});
const S = "/api/store/commerce";
function buyer(uid) {
  f.users.set(uid, {
    uid,
    email: uid + "@zentra.invalid",
    emailVerified: true,
    disabled: false,
    generation: 0,
  });
  db.records.set("users/" + uid, { username: uid, storeAccountStatus: "active" });
}
function order(uid, id, changes = {}) {
  db.records.set("storeOrders/" + id, {
    uid,
    items: [{ productId: product.id }],
    status: "delivered",
    paymentMethod: "wallet",
    paymentState: "paid",
    paidAt: Date.now() - 20000,
    ...changes,
  });
}
async function review(uid = "member", orderId = "source-order") {
  const result = await f.request(S + "/reviews", {
    uid,
    method: "POST",
    body: {
      orderId,
      productId: product.id,
      rating: 5,
      title: "Ürün deneyimim",
      message: "Kurulum ve kullanım deneyimimi paylaşıyorum.",
    },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.result;
}
const post = (path, uid, body) =>
  f.request(path, { ...(uid ? { uid } : {}), method: "POST", body });
test("other purchasers can reply, including after their own review, with current full usernames and a single persisted reply on retry", async () => {
  order("member", "source-order");
  order("finance", "other-order");
  const root = await review();
  await review("finance", "other-order");
  const page = await community.read(product.id, { uid: "finance" });
  assert.equal(page.eligibility.reason, "already-reviewed");
  assert.equal(page.eligibility.canReply, true);
  assert.equal(page.reviews.find((row) => row.id === root.id).canReply, true);
  const endpoint = S + "/community/" + product.id + "/reviews/" + root.id + "/replies",
    payload = {
      orderId: "other-order",
      message: "Benim paketimde de bu özellik sorunsuz çalıştı.",
      mutationId: randomUUID(),
    };
  const response = await post(endpoint, "finance", payload);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.result.replyCount, 1);
  const retry = await post(endpoint, "finance", payload);
  assert.equal(retry.status, 200);
  assert(retry.body.result.replayed);
  assert.equal(
    (await post(endpoint, "finance", { ...payload, message: "Farklı metin" })).status,
    409,
  );
  const person = db.records.get("users/finance");
  delete person.username;
  person.usernameLower = "ikinci_alıcı";
  const replies = await f.request(endpoint);
  assert.equal(replies.status, 200);
  assert.equal(replies.body.result.items.length, 1);
  assert.equal(replies.body.result.items[0].profile.username, "ikinci_alıcı");
  assert.equal(replies.body.result.items[0].message, payload.message);
  for (const key of ["uid", "orderId", "email", "mutationId"])
    assert(!Object.hasOwn(replies.body.result.items[0], key));
  assert.equal(
    (await community.read(product.id)).reviews.find((r) => r.id === root.id).replyCount,
    1,
  );
  assert.equal(
    (await db.collection("storeReviewInvitationJobs").get()).size,
    2,
    "replies do not create invitations",
  );
  await catalog.moderate(
    root.id,
    { status: "hidden", reason: "Denetim testi" },
    { uid: "owneruid" },
  );
  assert.equal((await f.request(endpoint)).status, 404);
  assert.equal(
    (await post(endpoint, "finance", { ...payload, mutationId: randomUUID() })).status,
    404,
  );
});
test("guest, self, wrong owner, wrong product and refunded orders cannot publish replies", async () => {
  order("member", "source-order");
  const root = await review();
  const endpoint = S + "/community/" + product.id + "/reviews/" + root.id + "/replies";
  const body = (id) => ({ orderId: id, message: "Yanıt denemesi", mutationId: randomUUID() });
  assert.equal((await post(endpoint, "", body("source-order"))).status, 401);
  assert.equal((await post(endpoint, "member", body("source-order"))).status, 403);
  assert.equal((await post(endpoint, "finance", body("source-order"))).status, 404);
  order("finance", "wrong-product", { items: [{ productId: "another-product" }] });
  order("finance", "refund", { walletRefundedAt: Date.now() });
  for (const id of ["wrong-product", "refund"])
    assert.equal((await post(endpoint, "finance", body(id))).status, 403);
  assert.equal((await db.collection("storeReviewReplies").get()).size, 0);
});
test("a published review queues invitations only for other eligible prior buyers who have not contributed", async () => {
  const accounts = [
    "valid-buyer",
    "late-review",
    "reply-author",
    "opt-out",
    "refunded",
    "unpaid",
    "future-buyer",
    "alternate-order",
    "changed-order",
    "old-review",
  ];
  accounts.forEach(buyer);
  order("member", "source-order");
  for (const uid of accounts) order(uid, uid + "-order");
  order("valid-buyer", "multiple-purchases");
  order("alternate-order", "alternative-paid");
  order("future-buyer", "future-buyer-order", { paidAt: Date.now() + 60000 });
  order("refunded", "refunded-order", { walletRefundedAt: Date.now() });
  order("unpaid", "unpaid-order", { paymentState: "pending", paidAt: 0 });
  db.records.set("storeCommerceProfiles/opt-out", {
    preferences: { emailReviewInvitations: false },
  });
  order("old-review", "old-review-order");
  db.records.set("storeReviews/old-id", {
    uid: "old-review",
    productId: product.id,
    status: "published",
    orderId: "old-review-order",
    createdAt: 1,
  });
  const root = await review();
  const endpoint = S + "/community/" + product.id + "/reviews/" + root.id + "/replies";
  assert.equal(
    (
      await post(endpoint, "reply-author", {
        orderId: "reply-author-order",
        message: "Deneyimimiz benzer.",
        mutationId: randomUUID(),
      })
    ).status,
    200,
  );
  // Legacy orders intentionally have no product projection. The first scan builds it.
  process.env.EMAIL_NOTIFICATIONS_ENABLED = "false";
  await Promise.all([invitations.run(), invitations.run()]);
  const job = db.records.get("storeReviewInvitationJobs/" + root.id);
  assert.equal(job.state, "completed");
  assert.equal(job.queued, 4);
  assert.deepEqual(db.records.get("storeOrders/source-order").reviewProductIds, [product.id]);
  const rows = await db
    .collection("storeEmailOutbox")
    .where("type", "==", "review_invitation")
    .get();
  assert.deepEqual(rows.docs.map((d) => d.data().uid).sort(), [
    "alternate-order",
    "changed-order",
    "late-review",
    "valid-buyer",
  ]);
  const refs = Object.fromEntries(rows.docs.map((d) => [d.data().uid, d.ref]));
  await review("late-review", "late-review-order");
  db.records.get("storeOrders/changed-order-order").walletRefundedAt = Date.now();
  const first = (await refs["alternate-order"].get()).data().data.orderId;
  db.records.get("storeOrders/" + first).walletRefundedAt = Date.now();
  process.env.EMAIL_NOTIFICATIONS_ENABLED = "true";
  const posts = [];
  async function provider(url, options) {
    assert.equal(new URL(url).hostname, "api.resend.com");
    const data = JSON.parse(options.body);
    posts.push(data);
    return Response.json({ id: randomUUID() });
  }
  for (const uid of Object.keys(refs))
    await email.processMessage(db, refs[uid], { fetcher: provider });
  assert.equal(posts.length, 2);
  assert.deepEqual(posts.map((p) => (Array.isArray(p.to) ? p.to[0] : p.to)).sort(), [
    "alternate-order@zentra.invalid",
    "valid-buyer@zentra.invalid",
  ]);
  for (const payload of posts) {
    assert(payload.subject.includes(product.name));
    assert(payload.text.includes("Sizin deneyiminiz nasıldı?"));
    const link = new URL(payload.text.match(/Ürünü değerlendir: (\S+)/)[1]);
    assert.equal(link.searchParams.get("devam"), "/urun/" + product.id + "?bolum=yorumlar");
    assert(payload.headers["List-Unsubscribe"]);
    assert(!payload.html.includes("source-order"));
  }
  assert.equal((await refs["late-review"].get()).data().state, "skipped");
  assert.equal((await refs["changed-order"].get()).data().state, "skipped");
  const token = new URL(posts[0].headers["List-Unsubscribe"].slice(1, -1)).searchParams.get(
    "token",
  );
  const unsub = await email.unsubscribe(token);
  assert.equal(unsub.category, "review");
});
test("hiding a review after fan-out suppresses its pending invitation; failed review commits leave no invitation job", async () => {
  order("member", "source-order");
  order("finance", "other-order");
  db.setFailure(true);
  await assert.rejects(() =>
    catalog.review("member", {
      orderId: "source-order",
      productId: product.id,
      rating: 5,
      title: "Deneme",
      message: "Başarılı kayıt bekleniyor",
    }),
  );
  db.setFailure(false);
  assert.equal((await db.collection("storeReviewInvitationJobs").get()).size, 0);
  const root = await review();
  await invitations.run();
  const out = await db
    .collection("storeEmailOutbox")
    .where("type", "==", "review_invitation")
    .get();
  assert.equal(out.size, 1);
  await catalog.moderate(
    root.id,
    { status: "hidden", reason: "Ürünle ilgisiz içerik" },
    { uid: "owneruid" },
  );
  let calls = 0;
  await email.processMessage(db, out.docs[0].ref, {
    fetcher: async () => {
      calls++;
      return Response.json({ id: randomUUID() });
    },
  });
  assert.equal(calls, 0);
  assert.equal((await out.docs[0].ref.get()).data().failureCode, "EMAIL_SOURCE_NO_LONGER_VALID");
});

test("replaying a buyer review after a lost response keeps one review and one invitation job; registered legacy handle is public", async () => {
  order("member", "source-order");
  const person = db.records.get("users/member");
  delete person.username;
  delete person.usernameLower;
  db.records.set("usernameRegistry/kayitliuye", { uid: "member", username: "KayitliUye" });
  const data = {
    orderId: "source-order",
    productId: product.id,
    rating: 5,
    title: "Değerlendirme",
    message: "Teslimat kısa sürdü.",
    mutationId: randomUUID(),
  };
  const original = await post(S + "/reviews", "member", data);
  assert.equal(original.status, 200);
  const again = await post(S + "/reviews", "member", data);
  assert.equal(again.status, 200);
  assert.equal(again.body.result.replayed, true);
  assert.equal((await post(S + "/reviews", "member", { ...data, rating: 4 })).status, 409);
  assert.equal((await db.collection("storeReviews").get()).size, 1);
  assert.equal((await db.collection("storeReviewInvitationJobs").get()).size, 1);
  assert.equal((await community.read(product.id)).reviews[0].profile.username, "KayitliUye");
});
