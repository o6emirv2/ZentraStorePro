"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");
const { applicationFixture } = require("./helpers/application-fixture.cjs");
const firebaseSdk = require("./helpers/browser-firebase.cjs");
const output = path.resolve(process.env.MEDIA_BROWSER_OUTPUT || "test-results/media-showcase");
const { renditions } = require("../public/data/image-renditions.mjs");
const cover = "/public/assets/products/ESign.WEBP";
const ultima = "/public/assets/products/ultima-oxide.jpeg";
const gallery = Array.from({ length: 7 }, (_, i) => "/public/assets/products/gallery/ultıma/menu-0" + (i + 1) + ".png");
async function main() {
  fs.mkdirSync(output, { recursive: true });
  process.env.RESEND_API_KEY = "re_" + require("node:crypto").randomBytes(30).toString("base64url");
  const app = await applicationFixture({ transientStore: "memory", rateLimitStore: "memory", appCheckMode: "monitor" });
  require("../server/core/accountRecoveryService").worker.stop();
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : { channel: "chrome" }), args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });
  const cases = [], errors = [], pages = [];
  const record = (name, detail = {}) => { cases.push({ name, ...detail }); console.log("PASS " + name); };
  async function open(uid) {
    const ctx = await browser.newContext({ viewport: { width: uid ? 1280 : 390, height: 844 }, isMobile: !uid, hasTouch: !uid, reducedMotion: "reduce", serviceWorkers: "block" });
    await ctx.route("**/*", route => {
      const url = route.request().url();
      if (url.startsWith("https://www.gstatic.com/firebasejs/")) return route.fulfill({ contentType: "text/javascript", headers: { "access-control-allow-origin": "*" }, body: firebaseSdk });
      if (url.startsWith("https://encrypted-tbn0.gstatic.com/")) return route.fulfill({ contentType: "image/webp", body: fs.readFileSync(path.resolve(__dirname, "../public/assets/images/zentra-mark.webp")) });
      return url.startsWith(app.origin + "/") ? route.continue() : route.abort();
    });
    if (uid) await ctx.addInitScript(({ identity, password }) => { globalThis.__qaIdentity = identity; globalThis.__qaPassword = password; }, { identity: { uid, email: app.users.get(uid).email, token: app.idToken(uid) }, password: app.password });
    const page = await ctx.newPage();
    page.setDefaultTimeout(15000);
    page.on("pageerror", e => errors.push(e.message));
    pages.push(page);
    return page;
  }
  async function authorize(page) {
    await page.locator("#reauthPassword").fill(app.password);
    await page.locator("#reauthForm button[type=submit]").click();
  }
  async function save(page, action, endpoint) {
    const response = page.waitForResponse(res => new URL(res.url()).pathname === endpoint && ["PATCH","POST"].includes(res.request().method()));
    await action.click();
    await authorize(page);
    const res = await response;
    assert.equal(res.status(), 200, await res.text());
  }
  async function loaded(page, selector, expected) {
    await page.waitForFunction(({ selector, sources }) => {
      const img = document.querySelector(selector);
      return img?.complete && img.naturalWidth > 0 && sources.includes(decodeURIComponent(new URL(img.currentSrc).pathname));
    }, { selector, sources: [expected, renditions[expected]?.medium].filter(Boolean) }).catch(async error => {
      const actual = await page.locator(selector).first().evaluate(img => ({ src: img.getAttribute("src"), current: img.currentSrc, width: img.naturalWidth })).catch(() => null);
      throw new Error("Görsel doğrulanamadı. " + JSON.stringify({ selector, expected, actual }), { cause: error });
    });
  }
  try {
    const created = await require("../server/core/storeCatalogService").createProduct({ id: "esign-gbox", name: "ESign", description: "iPhone için ESign yıllık paket.", categoryKey: "gbox-iphone", platform: "ios", game: "gbox", inventoryType: "license", fulfillmentMode: "telegram_only", image: ultima, featured: true, galleryPaths: [cover], plans: [{ key: "year", label: "Yıllık", duration: "12 ay", priceKurus: 80000 }] }, { uid: "owneruid" });
    assert.equal(created.id, "esign-gbox");
    const admin = await open("owneruid");
    await admin.goto(app.origin + "/admin/");
    await admin.locator("#firebasePassword").fill(app.password); await admin.locator("#firebasePasswordForm button[type=submit]").click();
    await admin.locator("#fourthFactor").fill(app.four); await admin.locator("#fourthFactorForm button[type=submit]").click();
    await admin.locator("#fifthFactor").fill(app.five); await admin.locator("#fifthFactorForm button[type=submit]").click();
    await admin.locator("#adminTotpCode").fill(app.totp()); await admin.locator("#sixthFactorForm button[type=submit]").click();
    await admin.locator("#adminLoader.is-hidden").waitFor({ state: "attached" });
    await admin.locator('[data-panel="products"]').first().click();
    const form = admin.locator('[data-product-form="ios-ultima-oxide"]');
    await form.waitFor();
    const esignCover = admin.locator('[data-product-form="esign-gbox"] [data-product-image]');
    await esignCover.fill(cover);
    await esignCover.press("Tab");
    assert.equal(await form.locator("[data-gallery-path]").count(), 8);
    while (await form.locator("[data-gallery-remove]").count()) await form.locator("[data-gallery-remove]").last().click();
    for (const image of [ultima, ...gallery]) {
      await form.locator("[data-gallery-add]").click();
      await form.locator("[data-gallery-path]").last().fill(image);
      await form.locator("[data-gallery-path]").last().press("Tab");
    }
    await save(admin, admin.locator("#productBulkSave"), "/api/admin/store/products/bulk");
    await admin.waitForFunction(() => Boolean(document.querySelector('[data-product-form="ios-ultima-oxide"]:not(.is-dirty)')));
    const live = (await app.request("/api/store/catalog")).body.catalog;
    assert.deepEqual(live.products.find(item => item.id === "ios-ultima-oxide").galleryPaths, [ultima, ...gallery]);
    record("admin-product-editor-publishes-eight-ordered-images");

    const guest = await open();
    await guest.goto(app.origin);
    const card = '[data-store-product="esign-gbox"] img[data-product-image]';
    await guest.locator(card).scrollIntoViewIfNeeded();
    await loaded(guest, card, cover);
    record("esign-card-decodes-original-webp");
    const featured = guest.locator('[data-store-product="esign-gbox"]');
    await guest.emulateMedia({ reducedMotion: "no-preference" });
    await guest.waitForFunction(() => document.querySelector('[data-store-product="esign-gbox"]')?.dataset.cardVisible === "true");
    const frame = await featured.evaluate(card => {
      const edge = getComputedStyle(card, "::after");
      const media = card.querySelector(".product-card__media").getBoundingClientRect();
      const image = card.querySelector("img[data-product-image]").getBoundingClientRect();
      return { name: edge.animationName, play: edge.animationPlayState, loop: edge.animationIterationCount,
        padding: getComputedStyle(card).paddingTop, fills: Math.abs(media.width-image.width) <= 2 && Math.abs(media.height-image.height) <= 2 };
    });
    assert.deepEqual(frame, { name: "zentra-edge-orbit", play: "running", loop: "infinite", padding: "0px", fills: true });
    await guest.evaluate(() => scrollTo({top: 0, behavior: "instant"}));
    await guest.waitForFunction(() => getComputedStyle(document.querySelector('[data-store-product="esign-gbox"]'), "::after").animationPlayState === "paused");
    await guest.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await featured.evaluate(node => getComputedStyle(node, "::after").animationName), "none");
    record("featured-frame-runs-in-view-pauses-offscreen-and-respects-reduced-motion");
    await guest.locator('[data-store-buy="ios-ultima-oxide"]').first().click();
    const root = '[data-product-gallery="ios-ultima-oxide"]';
    for (const [index, image] of [ultima, ...gallery].entries()) {
      await guest.locator(root + ' [data-product-gallery-thumbnail="' + index + '"]').click();
      await loaded(guest, root + " .product-gallery__slide.is-active img", image);
      assert.equal(decodeURIComponent(new URL(await guest.locator(root+" .product-gallery__original").getAttribute("href"),app.origin).pathname),image);
    }
    const thumbs = await guest.locator(root + " [data-product-gallery-thumbnail] img").evaluateAll(images => images.map(img => img.naturalWidth > 0 ? decodeURIComponent(new URL(img.currentSrc).pathname) : ""));
    assert.deepEqual(thumbs, [ultima, ...gallery].map(source => renditions[source]?.thumbnail || source));
    await guest.locator(root + ' [data-product-gallery-thumbnail="1"]').click();
    await guest.locator("#purchaseModal .product-detail").screenshot({ path: path.join(output, "ultima-gallery.png") });
    record("eight-distinct-decoded-gallery-slides-and-thumbnails", { images: thumbs.length });
    await guest.locator("#purchaseModal button[data-close-layer]").first().click();
    await guest.locator("#loginBtn").click();
    const reset = guest.locator("#forgotPasswordButton"), remind = guest.locator("#forgotUsernameButton");
    assert.equal(await guest.locator("#loginIdentifier").inputValue(), "");
    const calls = [];
    guest.on("request", req => { if (req.method() === "POST" && /\/api\/auth\/(username-recovery|password-reset)$/.test(req.url())) calls.push(new URL(req.url()).pathname); });
    for (const [button, endpoint, type] of [[reset, "password-reset", "text"], [remind, "username-recovery", "email"]]) {
      await button.click();
      const dialog = guest.locator(".app-dialog[open]");
      assert.equal(await dialog.count(), 1);
      assert.equal(await dialog.locator('[name="identifier"]').getAttribute("type"), type);
      await guest.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      assert.equal(await button.evaluate(node => node === document.activeElement), true,
        JSON.stringify(await guest.evaluate(()=>({focus:document.activeElement?.id||document.activeElement?.tagName, layer:document.querySelector('#authSheet').className,inert:document.querySelector('#authSheet').inert, dialogs:[...document.querySelectorAll('dialog[open]')].map(x=>x.id),hash:location.hash}))));
      await button.click();
      await dialog.locator('[name="identifier"]').fill("guest-request@zentra.invalid");
      const done = guest.waitForResponse(res => res.url().endsWith("/api/auth/" + endpoint) && res.request().method() === "POST");
      await dialog.locator("[type=submit]").click();
      const result = await done; assert.equal((await result.json()).accepted, true);
      await dialog.waitFor({ state: "detached" });
      record("guest-" + endpoint + "-opens-dialog-and-submits-once");
    }
    assert.deepEqual(calls, ["/api/auth/password-reset", "/api/auth/username-recovery"]);
    await guest.locator("#authSheet button[data-close-layer]").first().click();

    await admin.locator('[data-panel="content"]').first().click();
    const editor = admin.locator("#showcaseForm");
    await editor.locator("#showcaseFields:not([disabled])").waitFor();
    await editor.locator("[data-slide-hide]").click();
    for (const image of [cover, gallery[2]]) {
      await editor.locator("#showcaseSource").selectOption(image);
      await editor.locator("[data-slide-add]").click();
    }
    await editor.locator("#showcaseRows li").last().locator('[data-slide-move="-1"]').click();
    await save(admin, editor.locator("[type=submit]"), "/api/admin/store/content");
    await guest.reload();
    await guest.waitForFunction(() => document.querySelectorAll("[data-showcase-slide]").length === 2);
    await loaded(guest, ".showcase-slide.is-active img", gallery[2]);
    await guest.locator("[data-showcase-next]").click();
    await loaded(guest, ".showcase-slide.is-active img", cover);
    assert.equal(await guest.locator("[data-showcase-viewport] button, [data-showcase-details]").count(),0);
    assert(await guest.locator("[data-showcase-controls]").isVisible());
    const geometry = await guest.locator("[data-showcase-slider]").evaluate(node => {
      const viewport = node.querySelector("[data-showcase-viewport]").getBoundingClientRect();
      const toolbar = node.querySelector("[data-showcase-controls]").getBoundingClientRect();
      return { left: viewport.left, right: viewport.right, width: document.documentElement.clientWidth, below: toolbar.top >= viewport.bottom - 1 };
    });
    assert(geometry.left <= 1 && Math.abs(geometry.right-geometry.width) <= 1 && geometry.below);
    const play = guest.locator("[data-showcase-toggle]");
    await play.focus();
    await play.press("Enter");
    await loaded(guest, ".showcase-slide.is-active img", gallery[2]);
    await play.press("Enter");
    await guest.locator("[data-showcase-next]").click();
    await loaded(guest, ".showcase-slide.is-active img", cover);
    record("edge-to-edge-slider-wraps-while-play-button-keeps-focus");
    await guest.locator(".showcase-slide.is-active a").click();
    await guest.locator('[data-product-gallery="esign-gbox"]').waitFor();
    record("admin-selection-order-hidden-images-and-overlay-free-viewport-on-fresh-home");
    await admin.reload();
    await admin.locator('[data-panel="content"]').first().click();
    await editor.locator("#showcaseFields:not([disabled])").waitFor();
    const enabled = await editor.locator("li").filter({ has: admin.locator('[data-slide-field="enabled"]:checked') }).locator("img").evaluateAll(images => images.map(img => decodeURIComponent(new URL(img.src).pathname)));
    assert.deepEqual(enabled, [gallery[2], cover]);
    record("saved-slider-order-survives-admin-reload");
    await editor.locator("[data-slide-hide]").click();
    await save(admin, editor.locator("[type=submit]"), "/api/admin/store/content");
    await guest.goto(app.origin);
    await guest.locator("[data-store-product]").first().waitFor();
    assert.equal(await guest.locator("[data-showcase-slider]").isVisible(), false);
    assert.equal(await guest.locator("[data-showcase-slide]").count(), 0);
    record("empty-selection-hides-slider-without-default-image");
    await require("../server/core/security").publicLimiter.resetKey("127.0.0.1");
    await guest.route(url => [ultima, gallery[1]].includes(decodeURIComponent(url.pathname)), route => route.fulfill({ status: 404, contentType: "text/plain", body: "" }));
    await guest.reload();
    const ultimaCard = '[data-store-product="ios-ultima-oxide"] img[data-product-image]';
    await guest.locator(ultimaCard).scrollIntoViewIfNeeded();
    await loaded(guest, ultimaCard, gallery[0]);
    await guest.locator('[data-store-buy="ios-ultima-oxide"]').first().click();
    await loaded(guest, root + " .product-gallery__slide.is-active img", gallery[0]);
    // The second unavailable original is requested when it approaches the active slide.
    await guest.locator(root + " .product-gallery__arrow--next").click();
    await guest.waitForFunction(() => document.querySelectorAll('[data-product-gallery="ios-ultima-oxide"] [data-product-gallery-thumbnail]').length === 6);
    await guest.locator(root + ' [data-product-gallery-thumbnail="0"]').click();
    await loaded(guest, root + " .product-gallery__slide.is-active img", gallery[0]);
    const remaining = await guest.locator(root + " [data-product-gallery-thumbnail] img").evaluateAll(images => images.map(img => decodeURIComponent(new URL(img.src).pathname)));
    assert.deepEqual(remaining, gallery.filter(src => src !== gallery[1]));
    record("two-unavailable-files-use-a-real-card-cover-and-six-distinct-gallery-images");
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, "browser-results.json"), JSON.stringify({ passed: cases.length, failed: 0, browser: await browser.version(), physicalDevices: false, liveEmails: 0, pageErrors: errors, cases }, null, 2));
  } catch (error) {
    for (const [i, page] of pages.entries()) await page.screenshot({ path: path.join(output, "failure-" + i + ".png") }).catch(() => {});
    throw error;
  } finally { await browser.close(); await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
