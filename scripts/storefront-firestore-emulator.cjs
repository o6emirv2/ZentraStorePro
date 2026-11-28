"use strict";
const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const { fork } = require("node:child_process");
const admin = require("firebase-admin");

async function main() {
  assert.match(process.env.FIRESTORE_EMULATOR_HOST || "", /^(?:127\.0\.0\.1|localhost):\d+$/);
  const projectId = process.env.GCLOUD_PROJECT;
  assert.match(projectId || "", /^demo-zentra-[a-z-]+$/);
  process.env.ADMIN_GATE_SIGNING_SECRET ||= randomBytes(48).toString("hex");
  process.env.EMAIL_NOTIFICATIONS_ENABLED = "false";
  const app = admin.initializeApp({ projectId }),
    db = app.firestore();
  const auth = {
    getUser: async (uid) => ({
      uid,
      email: uid + "@example.invalid",
      emailVerified: true,
      disabled: false,
    }),
  };
  auth.getUsers = async (ids) => ({
    users: await Promise.all(ids.map(({ uid }) => auth.getUser(uid))),
    notFound: [],
  });
  require("./helpers/memory-firestore.cjs").mockModule(
    require.resolve("../server/config/firebaseAdmin"),
    { initFirebaseAdmin: () => ({ db, auth, admin }) },
  );
  const campaigns = require("../server/core/systemAnnouncements"),
    community = require("../server/commerce/community");
  const catalog = require("../server/core/storeCatalogService"),
    stock = require("../server/core/storeService");
  const [role, uid, productId, planKey, newPrice] = process.argv.slice(2);
  function independent(...args) {
    return new Promise((resolve, reject) => {
      const child = fork(__filename, args, { stdio: "inherit" });
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(Error("Worker failed: " + code)),
      );
    });
  }
  try {
    if (role === "sender") {
      await campaigns.run();
      return;
    }
    if (role === "price") {
      await catalog.updateProductSettings(
        productId,
        { plans: { [planKey]: { priceKurus: Number(newPrice) } } },
        { uid },
      );
      return;
    }
    if (role === "reader") {
      const result = await community.read(productId, { uid });
      assert.equal(result.liked, true);
      assert.equal(result.eligibility.reason, "already-reviewed");
      assert(result.reviews.some((row) => row.title === uid && row.verifiedPurchase));
      return;
    }
    const owner = "buyer-" + randomUUID(),
      actor = { uid: owner };
    const seed = db.batch();
    seed.set(db.doc("users/" + owner), { username: "tester", storeAccountStatus: "active" });
    seed.set(db.doc("storeCommerceProfiles/" + owner), {
      preferences: { campaignNotifications: true, emailCampaignNotifications: true },
    });
    await seed.commit();
    const product = (await catalog.getEffectiveCatalog()).products[0],
      plan = product.plans[0];
    const input = {
      title: "Emülatör gönderimi",
      message: "İki işlemci, tek gönderim.",
      requestKey: randomUUID(),
      group: "selected",
      uids: [owner],
      mode: "scheduled",
      channels: { site: true, email: true },
      startsAt: Date.now() + 1500,
      endsAt: 0,
    };
    const campaign = await campaigns.createDraft(input, actor);
    assert.equal((await campaigns.createDraft(input, actor)).id, campaign.id);
    await campaigns.run();
    assert.equal((await campaigns.trace(campaign.id, "site")).total, 0);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, input.startsAt - Date.now() + 40)),
    );
    await Promise.all([independent("sender"), independent("sender")]);
    assert.equal((await campaigns.trace(campaign.id, "site")).total, 1);
    const mailbox = await db.collection("storeEmailOutbox").where("uid", "==", owner).get();
    assert.equal(
      mailbox.docs.filter((doc) => doc.data().data.campaignId === campaign.id).length,
      1,
    );
    const orderId = randomUUID(),
      peer = "peer-" + randomUUID(),
      peerOrder = randomUUID();
    await db.doc("users/" + peer).set({ username: "IkinciAlici", storeAccountStatus: "active" });
    await db
      .doc("storeOrders/" + peerOrder)
      .set({
        uid: peer,
        status: "delivered",
        paymentMethod: "wallet",
        paymentState: "paid",
        paidAt: Date.now() - 30000,
        items: [{ productId: product.id }],
      });
    await db.doc("storeOrders/" + orderId).set({
      uid: owner,
      status: "delivered",
      paymentMethod: "wallet",
      paidAt: Date.now(),
      paymentState: "paid",
      items: [{ productId: product.id }],
    });
    const mutation = { liked: true, expectedRevision: 0, mutationId: randomUUID() };
    assert.equal((await community.like(product.id, { uid: owner }, mutation)).liked, true);
    assert.equal((await community.like(product.id, { uid: owner }, mutation)).replayed, true);
    const rootReview = await require("../server/commerce/catalog").review(owner, {
      orderId,
      productId: product.id,
      title: owner,
      rating: 4,
      message: "Kalıcı kayıt kontrolü.",
    });
    await independent("reader", owner, product.id);
    const invitations = require("../server/commerce/reviewInvitations"),
      replies = require("../server/commerce/reviewReplies");
    await invitations.run();
    const invitationsForPeer = await db
      .collection("storeEmailOutbox")
      .where("uid", "==", peer)
      .get();
    const inviteRows = invitationsForPeer.docs.filter(
      (doc) => doc.data().type === "review_invitation",
    );
    assert.equal(inviteRows.length, 1);
    assert((await invitations.facts(db, inviteRows[0].data())).qualifyingOrderId === peerOrder);
    const reply = {
      orderId: peerOrder,
      message: "Aynı paketi satın aldım.",
      mutationId: randomUUID(),
    };
    await replies.add(peer, product.id, rootReview.id, reply);
    assert.equal((await replies.add(peer, product.id, rootReview.id, reply)).replayed, true);
    const thread = await replies.list(product.id, rootReview.id);
    assert.equal(thread.items.length, 1);
    assert.equal(thread.items[0].profile.username, "IkinciAlici");
    assert.equal(await invitations.facts(db, inviteRows[0].data()), null);
    const price = plan.priceKurus + 100;
    await independent("price", owner, product.id, plan.key, String(price));
    const deadline = Date.now() + 5000;
    let seen;
    do {
      const visible = (await catalog.getEffectiveCatalog()).products.find(
        (row) => row.id === product.id,
      );
      seen = visible.plans.find((row) => row.key === plan.key).priceKurus;
      if (seen === price) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    assert.equal(
      seen,
      price,
      "An external committed price change must invalidate the cached product",
    );
    await assert.rejects(
      stock.checkCartSelection({
        productId: product.id,
        planKey: plan.key,
        expectedUnitPriceKurus: plan.priceKurus,
        quantity: 1,
        channel: "telegram",
      }),
      { code: "STORE_PRICE_CHANGED" },
    );
    const { retiredId } = require("../server/core/retiredProducts");
    const deletion = require("../server/core/productDeletion");
    const inventory = db.doc("storeInventory/" + retiredId + "__daily").collection("items");
    const historic = db.collection("storeOrders").doc();
    await db.batch()
      .set(inventory.doc("unused"), { status: "available" })
      .set(inventory.doc("used"), { status: "delivered", orderId: historic.id, customerUid: owner })
      .set(historic, { uid: owner, status: "delivered", items: [{ productId: retiredId }] })
      .set(db.doc("storefrontSettings/main"), { catalog: { products: { [retiredId]: { name: "Eski ürün" } } } }, { merge: true })
      .commit();
    await deletion.request(retiredId, retiredId, actor);
    const retirement = db.collection("storeProductDeletionJobs").doc(retiredId);
    for (let step = 0; step < 250 && (await retirement.get()).exists; step++)
      await deletion.advance(db, retirement);
    assert.equal((await retirement.get()).exists, false);
    assert.equal((await inventory.doc("unused").get()).exists, false);
    assert.equal((await inventory.doc("used").get()).data().orderId, historic.id);
    assert.equal((await historic.get()).data().uid, owner);
    assert.equal((await deletion.request(retiredId, retiredId, actor)).state, "completed");
    console.log(
      JSON.stringify({
        retirementPreservedOrderAndDelivery: true,
        siteReceipts: 1,
        emailReceipts: 1,
        concurrentCampaignWorkers: 2,
        restoredBuyerLike: true,
        restoredBuyerReview: true,
        buyerReplyPersisted: true,
        concurrentInvitationRechecked: true,
        staleCartPriceRejected: true,
      }),
    );
  } finally {
    require("../server/core/catalogCacheWatch").stop();
    await db.terminate();
    await app.delete();
  }
}
main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
