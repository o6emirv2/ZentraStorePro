"use strict";
const assert = require("node:assert/strict");
const { chromium } = require("playwright-core");
const { applicationFixture } = require("./helpers/application-fixture.cjs");
const firebaseSdk = require("./helpers/browser-firebase.cjs");
async function main() {
  const fixture = await applicationFixture({
    appCheckMode: "off",
    transientStore: "memory",
    rateLimitStore: "memory",
  });
  const errors = [],
    pending = [],
    labels = [];
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH }
        : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    const catalog = (await fixture.request("/api/store/catalog")).body.catalog;
    const product = catalog.products[0];
    for (const [scenario, uid] of [
      ["guest", ""],
      ["like", "finance"],
      ["review", "member"],
      ["reply", "finance"],
    ]) {
      const { publicLimiter, apiLimiter } = require("../server/core/security");
      await publicLimiter.resetKey("127.0.0.1");
      await apiLimiter.resetKey("127.0.0.1");
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        reducedMotion: "reduce",
      });
      await context.route("**/*", (route) => {
        const url = route.request().url();
        if (url.startsWith("https://www.gstatic.com/firebasejs/"))
          return route.fulfill({
            contentType: "text/javascript",
            headers: { "access-control-allow-origin": "*" },
            body: firebaseSdk,
          });
        if (url.startsWith("https://encrypted-tbn0.gstatic.com/"))
          return route.fulfill({
            contentType: "image/webp",
            path: require("node:path").join(__dirname, "../public/assets/images/zentra-mark.webp"),
          });
        if (url.startsWith(fixture.origin)) return route.continue();
        return route.abort();
      });
      if (uid)
        await context.addInitScript(
          (identity) => {
            globalThis.__qaIdentity = identity;
          },
          { uid, email: uid + "@zentra.invalid", token: fixture.idToken(uid) },
        );
      if (uid === "member")
        await fixture.db
          .collection("storeOrders")
          .doc("verified-browser-order")
          .set({
            uid,
            paymentMethod: "wallet",
            paidAt: Date.now(),
            status: "delivered",
            paymentState: "paid",
            items: [{ productId: product.id, planKey: product.plans[0].key }],
          });
      const page = await context.newPage();
      page.on("pageerror", (err) => errors.push(err.message));
      page.on("request", (req) => {
        if (req.url().endsWith("/like") || req.url().endsWith("/reviews"))
          pending.push([uid, req.method()]);
      });
      const open = async () => {
        await page.goto(fixture.origin, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(
          () => document.documentElement.dataset.storefrontStatus === "ready",
        );
        await page.locator('[data-store-buy="' + product.id + '"]').click();
        await page.locator("#community-title").waitFor();
      };
      if (scenario !== "reply") await open();
      if (scenario === "reply") {
        const invites = require("../server/commerce/reviewInvitations");
        await invites.run();
        const out = await fixture.db
          .collection("storeEmailOutbox")
          .where("type", "==", "review_invitation")
          .get();
        assert.equal(out.size, 1);
        assert.equal(out.docs[0].data().uid, uid);
        process.env.EMAIL_NOTIFICATIONS_ENABLED = "true";
        process.env.RESEND_API_KEY = "re_" + require("node:crypto").randomBytes(24).toString("hex");
        let payload;
        await require("../server/email/service").processMessage(fixture.db, out.docs[0].ref, {
          fetcher: async (url, opts) => {
            payload = JSON.parse(opts.body);
            return Response.json({ id: require("node:crypto").randomUUID() });
          },
        });
        const invitation = new URL(payload.text.match(/Ürünü değerlendir: (\S+)/)[1]);
        await page.goto(fixture.origin + invitation.pathname + invitation.search, {
          waitUntil: "domcontentloaded",
        });
        const section = page.locator("#purchaseCommunity");
        await section.getByText("@EmirHan", { exact: true }).waitFor();
        await section.locator('[data-community="reply"]').click();
        const compose = page.getByRole("dialog", { name: "Yoruma yanıt ver" });
        const message = "Ben de aynı paketi aldım, kurulum deneyimim benzerdi.";
        await compose.locator('textarea[name="message"]').fill(message);
        await compose.getByRole("button", { name: "Yanıtı yayımla" }).click();
        await compose.waitFor({ state: "detached" });
        await section.locator(".thread-body").getByText(message).waitFor();
        assert.equal(await section.locator(".thread-body b").innerText(), "@FinanceUser");
        await open();
        await section.locator('[data-community="thread"]').click();
        await section.locator(".thread-body").getByText(message).waitFor();
        labels.push(
          "invitation-opens-reviewed-product",
          "buyer-reply-with-full-usernames",
          "thread-survives-reload",
        );
      } else if (!uid) {
        const login = page.locator('#purchaseCommunity [data-community="login"]');
        await login.waitFor();
        assert.equal(await page.locator('#purchaseCommunity [data-community="review"]').count(), 0);
        await login.click();
        await page.waitForFunction(
          () => document.querySelector("#authSheet").getAttribute("aria-hidden") === "false",
        );
        assert.equal(pending.length, 0);
        labels.push("guest-sign-in-without-write");
      } else {
        const like = page.locator('#purchaseCommunity [data-community="like"]');
        await like.click();
        await page.waitForFunction(
          () =>
            document.querySelector('[data-community="like"]')?.getAttribute("aria-pressed") ===
            "true",
        );
        await open();
        assert.equal(await like.getAttribute("aria-pressed"), "true");
        const review = page.locator('#purchaseCommunity [data-community="review"]');
        if (uid === "finance") {
          assert.equal(await review.count(), 0);
          labels.push("member-like-without-review");
          await fixture.db
            .collection("storeOrders")
            .doc("peer-browser-order")
            .set({
              uid,
              status: "delivered",
              paymentMethod: "wallet",
              paymentState: "paid",
              paidAt: Date.now() - 30000,
              items: [{ productId: product.id }],
            });
        } else {
          await review.click();
          const form = page.getByRole("dialog", { name: "Deneyimini paylaş" });
          await form.locator('input[name="title"]').fill("Satın alma deneyimim");
          await form.locator('select[name="rating"]').selectOption("4");
          await form
            .locator('textarea[name="message"]')
            .fill("Teslimat ile ilgili deneyimimi paylaşıyorum.");
          await form.getByRole("button", { name: "Yorumu yayımla" }).click();
          await form.waitFor({ state: "detached" });
          await open();
          await page.locator("#purchaseCommunity h4").getByText("Satın alma deneyimim").waitFor();
          assert.equal(await review.count(), 0);
          assert.equal(await page.locator(".verified-badge").innerText(), "Doğrulanmış satın alma");
          for (const width of [320, 375, 390, 430, 768, 1280]) {
            await page.setViewportSize({ width, height: 800 });
            const layout = await page.locator("#purchaseCommunity").evaluate((el) => ({
              visible: el.clientWidth,
              scroll: el.scrollWidth,
              viewport: innerWidth,
              documentWidth: document.documentElement.scrollWidth,
              targets: [...el.querySelectorAll("button")].map((button) => {
                const r = button.getBoundingClientRect();
                return [r.width, r.height];
              }),
            }));
            assert(
              layout.scroll <= layout.visible + 1 && layout.documentWidth <= layout.viewport + 1,
            );
            assert(layout.targets.every(([w, h]) => w >= 44 && h >= 44));
            labels.push("community-layout-" + width);
          }
          await page.locator('#purchaseCommunity [data-community="people"]').click();
          const people = page.getByRole("dialog", { name: "Beğenenler" });
          await people.locator(".community-person").first().waitFor();
          assert.equal(await people.locator(".community-person").count(), 2);
          await page.keyboard.press("Escape");
          await people.waitFor({ state: "detached" });
          labels.push("purchaser-review-persisted", "two-member-profiles");
        }
      }
      await context.close();
    }
    assert.deepEqual(pending, [
      ["finance", "PUT"],
      ["member", "PUT"],
      ["member", "POST"],
    ]);
    const reviews = [...fixture.db.records].filter(([key]) => key.startsWith("storeReviews/"));
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0][1].orderId, "verified-browser-order");
    assert.equal(fixture.db.records.get("storeProductCommunity/" + product.id).likes, 2);
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        passed: labels.length,
        cases: labels,
        browser: await browser.version(),
        pageErrors: errors,
      }),
    );
  } finally {
    await browser?.close();
    await fixture.close();
  }
}
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
