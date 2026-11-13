import {
  authMode,
  authPath,
  safeReturnTo,
  syncNavigation,
  measureHeader,
} from "./navigation.mjs?v=93";
import { clearCustomerSessionView } from "./session-view.mjs?v=93";
import "./device.js?v=93";
import { presentScreen } from "./motion.mjs?v=93";
import { productGallery, galleryIndex } from "./gallery.mjs?v=93";
import { filterProducts } from "./catalog.mjs?v=93";
import {
  storeApi,
  loadStoreRuntimeConfig,
  friendlyStoreError,
} from "../store/api.js?v=zentra-ui-v90r1";
import {
  initStoreAuth,
  subscribeStoreAuth,
  getStoreAuthSnapshot,
  signInStore,
  registerStore,
  logoutStore,
  resetStorePassword,
  refreshStoreAccount,
  changeStoreIdentity,
  changeStoreEmail,
  changeStorePassword,
} from "../store/auth.js?v=zentra-ui-v90r1";
import { createPurchaseTracker } from "../store/purchase-tracker.js?v=zentra-ui-v90r1";
import { createCart, priceCart, checkoutState } from "./cart.mjs?v=93";
import {
  escape as e,
  money,
  date,
  icon,
  toast,
  busy,
  modal,
  field,
  empty,
  status,
  safeImage,
  copyText,
} from "./ui.js?v=93";
const $ = (s) => document.querySelector(s),
  main = $("#main");
let storage;
try {
  storage = localStorage;
} catch {}
const cart = createCart(storage);
let favorites = new Set();
try {
  const raw = storage?.getItem("zentra-favorites-v2");
  if (raw && raw.length < 12000)
    favorites = new Set(
      JSON.parse(raw)
        .filter((x) => typeof x === "string" && /^[a-z0-9-]{1,80}$/.test(x))
        .slice(0, 150),
    );
} catch {}
const state = {
  catalog: null,
  catalogError: "",
  auth: getStoreAuthSnapshot(),
  orders: [],
  orderCursor: "",
  ordersLoaded: false,
  notifications: [],
  coupons: [],
  payment: "wallet",
  promotion: null,
  checkoutBusy: false,
  render: 0,
  selectedPlans: new Map(),
  selectedImages: new Map(),
};
const tracker = createPurchaseTracker({
  api: storeApi,
  userId: () => state.auth.user?.uid || "",
});
const uid = () => state.auth.user?.uid || "";
const userName = () =>
  state.auth.account?.username ||
  state.auth.user?.displayName ||
  "Zentra üyesi";
function route() {
  const u = new URL(location.href),
    p = u.pathname.split("/").filter(Boolean);
  return {
    name:
      {
        magaza: "catalog",
        kategori: "category",
        urun: "product",
        sepet: "cart",
        hesabim: "account",
        siparisler: "orders",
        favoriler: "favorites",
        destek: "support",
        bildirimler: "notifications",
        kuponlar: "coupons",
      }[p[0]] || "home",
    id: p[1] || "",
    query: u.searchParams,
  };
}
function go(path, { replace = false } = {}) {
  history[replace ? "replaceState" : "pushState"]({}, "", path);
  void render().then(() => main.focus({ preventScroll: true }));
  window.scrollTo({ top: 0, behavior: "instant" });
}
function product(id) {
  return state.catalog?.products?.find((p) => p.id === id);
}
function cartView() {
  return priceCart(cart.items(), state.catalog);
}
function message(error) {
  return friendlyStoreError(
    error?.code,
    error?.message || "İşlem tamamlanamadı. Lütfen yeniden deneyin.",
  );
}
function header() {
  syncNavigation(document, {
    signedIn: Boolean(uid()),
    pathname: location.pathname,
    search: location.search,
    cartCount: cart.items().reduce((sum, item) => sum + item.quantity, 0),
  });
}
function stockLabel(p) {
  if (p.fulfillmentMode === "telegram_only") return "Telegram ile";
  if (p.stock?.state === "unverified" || state.catalog?.stockVerified === false)
    return "Stok doğrulanamadı";
  return p.stock?.available > 0 ? "Stokta" : "Stok bekleniyor";
}
function card(p) {
  const plan = p.plans.reduce(
    (best, x) => (x.priceKurus < best.priceKurus ? x : best),
    p.plans[0],
  );
  return `<article class="product-card"><a class="product-media" href="/urun/${e(p.id)}" data-nav aria-label="${e(p.name)} detayını gör"><img src="${e(safeImage(p.image))}" alt="${e(p.name)}" width="320" height="280" loading="lazy" decoding="async"/><span class="product-badge">${e(p.badge || "ZENTRA SEÇKİSİ")}</span></a><button class="favorite-button" data-action="favorite" data-id="${e(p.id)}" aria-label="${e(p.name)} favori seçimini değiştir" aria-pressed="${favorites.has(p.id)}">${icon("heart")}</button><div class="product-body"><div class="product-meta"><span class="platform-tag">${p.platform === "ios" ? "iOS" : "ANDROID"} · ${e(p.game || "DİJİTAL")}</span><span class="stock-tag ${p.stock?.available ? "" : "unavailable"}">${e(stockLabel(p))}</span></div><h3><a href="/urun/${e(p.id)}" data-nav>${e(p.name)}</a></h3><p class="product-description">${e(p.description)}</p><div class="product-bottom"><div><span class="price-label">Başlangıç fiyatı</span><span class="price">${money(plan.priceKurus)}</span></div><button class="product-add" data-action="quick-add" data-id="${e(p.id)}" aria-label="${e(p.name)} paket seç">${icon("plus")}</button></div></div></article>`;
}
const heading = (title, kicker = "", description = "") =>
  `<div class="section-heading"><div>${kicker ? `<span class="eyebrow">${e(kicker)}</span>` : ""}<h1>${e(title)}<span class="accent-dot">.</span></h1>${description ? `<p>${e(description)}</p>` : ""}</div></div>`;
function filtered(r) {
  return filterProducts(state.catalog, r, {
    favorites,
    categories: state.experience?.categories || [],
  });
}
function catalogMarkup(r, { home = false } = {}) {
  const rows = filtered(r),
    cats = [
      ["", "Tümü"],
      ["android", "Android"],
      ["ios", "iOS"],
      ["pubg", "PUBG"],
      ["oxide", "Oxide"],
      ["gbox", "GBOX"],
    ];
  return `<section class="catalog-section" id="catalog"><div class="section-heading"><div><span class="eyebrow">${home ? "SENİN İÇİN SEÇTİK" : "DİJİTAL DÜNYANI KEŞFET"}</span><${home ? "h2" : "h1"}>${r.name === "favorites" ? "Favorilerin" : r.query.get("q") ? `“${e(r.query.get("q"))}” için sonuçlar` : home ? "Yeni favorini keşfet" : r.name === "category" ? e({ android: "Android ürünleri", ios: "iOS ürünleri", pubg: "PUBG Mobile", oxide: "Oxide", gbox: "GBOX" }[r.id] || r.id) : "Tüm ürünler"}<span class="accent-dot">.</span></${home ? "h2" : "h1"}></div>${home ? `<a class="section-link" href="/magaza" data-nav>Tümünü gör ${icon("arrow")}</a>` : `<span class="result-count">${rows.length} ürün</span>`}</div><div class="catalog-toolbar"><div class="filter-tabs">${cats.map(([id, label]) => `<a class="filter-tab ${((r.name === "category" ? r.id : r.query.get("category")) || "") === id ? "active" : ""}" href="${id ? "/kategori/" + id : "/magaza"}" data-nav>${label}</a>`).join("")}</div><label><span class="sr-only">Ürün sıralaması</span><select class="sort-select" id="sort-products"><option value="">Önerilen sıralama</option value="price-up" ${r.query.get("sort") === "price-up" ? "selected" : ""}>Fiyat: düşükten yükseğe</option><option value="price-down" ${r.query.get("sort") === "price-down" ? "selected" : ""}>Fiyat: yüksekten düşüğe</option><option value="name" ${r.query.get("sort") === "name" ? "selected" : ""}>İsme göre A–Z</option></select></label>${!home ? `<button class="filter-tab" data-action="filters">${icon("filter")} Filtrele</button>` : ""}</div>${rows.length ? `<div class="product-grid">${(home ? rows.slice(0, 8) : rows).map(card).join("")}</div>` : empty(r.name === "favorites" ? "Favori listen henüz boş" : "Aradığın ürünü bulamadık", r.name === "favorites" ? "Beğendiğin ürünlerdeki kalp simgesine dokun." : "Farklı bir kelimeyle ara veya filtrelerini temizle.")}</section>`;
}
const originalTrust =
  main.querySelector(".trust-strip")?.outerHTML ||
  document.querySelector("#home-trust-template")?.innerHTML ||
  "";
function home() {
  const storefront = state.catalog?.storefront || {},
    notice = storefront.announcement || {};
  return `${notice.enabled ? `<div class="notice"><div><b>${e(notice.title)}</b><p>${e(notice.message)}</p></div></div>` : ""}<h1 class="sr-only">Zentra Store</h1>${originalTrust}${(state.experience?.banners || []).map((b) => `<section class="community-banner" style="margin-bottom:22px">${b.image ? `<img src="${e(safeImage(b.image))}" alt="" width="140" height="100" loading="lazy" style="border-radius:12px"/>` : ""}<div><span class="eyebrow">ZENTRA VİTRİNİ</span><h2>${e(b.title)}</h2><p>${e(b.message)}</p></div><a class="button outline" href="${e(b.href)}" data-nav>Keşfet ${icon("arrow")}</a></section>`).join("")}<section><div class="section-heading"><div><span class="eyebrow">TAM SANA GÖRE</span><h2>Senin dünyan, senin seçimin<span class="accent-dot">.</span></h2></div><span class="result-count">Android &amp; iOS</span></div><div class="category-tiles">${[
    ["android", "Android", "Daha fazlasını keşfet", "◈"],
    ["ios", "iOS", "Deneyimini yenile", "◉"],
    ["oxide", "Oxide", "Yeni paketleri gör", "◇"],
    ["gbox", "GBOX", "Farklı seçenekler", "▧"],
  ]
    .map(
      ([id, title, sub, symbol]) =>
        `<a class="category-tile" href="/kategori/${id}" data-nav><span class="category-symbol">${symbol}</span><div><b>${title}</b><small>${sub}</small></div>${icon("arrow")}</a>`,
    )
    .join(
      "",
    )}</div></section>${catalogMarkup({ name: "home", query: new URLSearchParams() }, { home: true })}<section class="community-banner"><div><span class="eyebrow">ZENTRA TOPLULUĞU</span><h2>Birlikte bir adım öndeyiz.</h2><p>Gelişmeleri takip et, ihtiyacın olduğunda bize ulaş.</p></div><a class="button outline" href="/destek" data-nav>Topluluğa katıl ${icon("arrow")}</a></section>`;
}
function galleryMarkup(p) {
  const pictures = productGallery(p);
  const selected = galleryIndex(
    state.selectedImages.get(p.id),
    pictures.length,
  );
  const image = pictures[selected];
  return `<section class="product-gallery" aria-label="${e(p.name)} görsel galerisi" data-gallery-product="${e(p.id)}"><div class="detail-visual"><img src="${e(safeImage(image.src))}" alt="${e(image.alt)}" width="600" height="600" decoding="async" fetchpriority="high"/></div>${pictures.length > 1 ? `<div class="gallery-toolbar"><button class="icon-button" data-action="gallery-step" data-id="${e(p.id)}" data-step="-1" aria-label="Önceki ürün görseli">${icon("back")}</button><span class="gallery-counter" aria-live="polite">${selected + 1} / ${pictures.length}</span><button class="icon-button" data-action="gallery-step" data-id="${e(p.id)}" data-step="1" aria-label="Sonraki ürün görseli">${icon("arrow")}</button></div><div class="gallery-thumbs" aria-label="Ürün görselleri">${pictures.map((x, i) => `<button class="gallery-thumb" data-action="gallery-select" data-id="${e(p.id)}" data-index="${i}" aria-label="${e(p.name)} görsel ${i + 1}" aria-pressed="${i === selected}"><img src="${e(safeImage(x.src))}" alt="" width="65" height="65" loading="lazy" decoding="async"/></button>`).join("")}</div>` : ""}</section>`;
}
function selectGallery(id, next) {
  const p = product(id);
  const gallery = document.querySelector(".product-gallery");
  if (!p || gallery?.dataset.galleryProduct !== id) return;
  const pictures = productGallery(p),
    index = galleryIndex(next, pictures.length);
  state.selectedImages.set(id, index);
  const image = gallery.querySelector(".detail-visual img");
  image.src = safeImage(pictures[index].src);
  image.alt = pictures[index].alt;
  gallery
    .querySelectorAll(".gallery-thumb")
    .forEach((button, i) =>
      button.setAttribute("aria-pressed", String(i === index)),
    );
  const counter = gallery.querySelector(".gallery-counter");
  if (counter) counter.textContent = `${index + 1} / ${pictures.length}`;
}
function packagePicker(id) {
  const p = product(id);
  if (!p) throw new Error("Ürün doğrulanamadı.");
  if (tracker.pending())
    throw new Error("Önce bekleyen siparişinin sonucunu kontrol et.");
  modal({
    title: "Paketini seç",
    body: `<div class="quick-product"><img src="${e(safeImage(p.image))}" alt="" width="76" height="76"/><div><b>${e(p.name)}</b><small>${e(p.platform === "ios" ? "iOS" : "Android")} · ${e(stockLabel(p))}</small></div></div><fieldset class="quick-plans"><legend class="sr-only">Ürün paketleri</legend>${p.plans.map((plan, i) => `<label class="quick-plan"><input type="radio" name="planKey" value="${e(plan.key)}" ${i === 0 ? "checked" : ""} required/><span><b>${e(plan.label)}</b><small>${e(plan.duration)}</small></span><strong>${money(plan.priceKurus)}</strong></label>`).join("")}</fieldset><p class="fine-print" style="margin-top:18px">Kesin fiyat ve stok sipariş sırasında sunucuda doğrulanır.</p>`,
    submit: "Sepete ekle",
    onSubmit: (data) => {
      add(id, data.get("planKey"));
    },
  });
}
function detail(id) {
  const p = product(id);
  if (!p)
    return empty(
      "Bu ürün bulunamadı",
      "Ürün yayından kaldırılmış olabilir. Güncel mağazayı inceleyebilirsin.",
    );
  let key = state.selectedPlans.get(id) || p.plans[0]?.key,
    plan = p.plans.find((x) => x.key === key) || p.plans[0];
  return `<div class="breadcrumb"><a href="/" data-nav>Ana sayfa</a><span>/</span><a href="/kategori/${e(p.platform)}" data-nav>${p.platform === "ios" ? "iOS" : "Android"}</a><span>/</span><span>${e(p.name)}</span></div><section class="detail-grid">${galleryMarkup(p)}<div class="detail-info"><span class="eyebrow">${e(p.game)} · ${p.platform === "ios" ? "iOS" : "ANDROID"}</span><h1>${e(p.name)}</h1><span class="status-pill ${p.stock?.available ? "green" : "amber"}">${e(stockLabel(p))}</span><p class="detail-description">${e(p.description)}</p>${p.features?.length ? `<ul class="detail-features">${p.features.map((x) => `<li>✓ ${e(x)}</li>`).join("")}</ul>` : ""}<fieldset class="plan-options" aria-label="Paket seçimi" style="border:0;padding:0">${p.plans.map((x) => `<label class="plan-option"><input type="radio" name="product-plan" value="${e(x.key)}" ${x.key === plan.key ? "checked" : ""} data-product="${e(p.id)}"/><span>${e(x.label)}<b>${money(x.priceKurus)}</b><small>${e(x.duration)}</small></span></label>`).join("")}</fieldset><div class="detail-price">${money(plan.priceKurus)}</div><div class="detail-actions"><button class="button primary" data-action="add" data-id="${e(p.id)}" data-plan="${e(plan.key)}">${icon("bag")} Sepete ekle</button><button class="button outline" data-action="favorite" data-id="${e(p.id)}" aria-pressed="${favorites.has(p.id)}">${icon("heart")} ${favorites.has(p.id) ? "Favorilerinde" : "Favorilere ekle"}</button></div><p class="detail-trust">${icon("shield")} Fiyat ve stok, sipariş sırasında sunucuda doğrulanır.</p>${p.fulfillmentMode === "telegram_only" ? '<p class="fine-print">Bu ürün Telegram üzerinden görüşülerek teslim edilir. Otomatik teslimat uygulanmaz.</p>' : `<p class="fine-print">${plan.stock?.available > 0 ? "Uygun bakiye ve doğrulanmış stokla otomatik teslimat yapılır." : "Stok bulunmadığında Telegram üzerinden uygunluğu sorabilirsin."}</p>`}<button class="text-button fine-print" data-action="restock" data-id="${e(p.id)}" data-plan="${e(plan.key)}">${icon("bell")} Stok gelince haber ver</button></div></section><section class="catalog-section"><div class="section-heading"><h2>Keşfetmeye devam et.</h2></div><div class="product-grid">${state.catalog.products
    .filter((x) => x.id !== p.id && x.platform === p.platform)
    .slice(0, 4)
    .map(card)
    .join("")}</div></section>`;
}
function cartMarkup() {
  const view = cartView();
  if (!cart.items().length)
    return (
      heading("Sepetim", "SIRADAKİ ADIMIN") +
      empty(
        "Sepetinde yeni favorilerine yer var",
        "Ürünleri keşfet, ihtiyacına uygun paketi seç ve sepetine ekle.",
      )
    );
  const walletAllowed =
    state.catalog?.stockVerified !== false &&
    state.catalog?.storefront?.services?.balancePayment !== false &&
    view.lines.every(
      (x) =>
        x.product.fulfillmentMode !== "telegram_only" &&
        x.product.automaticEnabled !== false,
    );
  if (!walletAllowed) state.payment = "telegram";
  const gate = checkoutState({
    signedIn: Boolean(uid()),
    busy: state.checkoutBusy,
    invalidItems: view.invalid.length > 0,
    payment: state.payment,
    telegramEnabled: state.catalog?.storefront?.services?.telegramSupport,
  });
  return (
    heading(
      "Sepetim",
      "SIRADAKİ ADIMIN",
      `${cart.items().reduce((s, x) => s + x.quantity, 0)} ürün seni bekliyor.`,
    ) +
    `${view.invalid.length ? '<div class="notice error">Sepette artık satışta olmayan ürünler var. Devam etmeden önce bunları kaldır.</div>' : ""}${tracker.pending() ? `<div class="notice"><div><b>Önceki siparişinin sonucu kontrol edilmeli.</b><p>Aynı işlem için yeniden ödeme oluşturma.</p></div><button class="button outline small" data-action="recover">Sonucu kontrol et</button></div>` : ""}<div class="cart-layout"><div class="panel">${cart
      .items()
      .map((row) => {
        const line = view.lines.find(
          (x) => x.productId === row.productId && x.planKey === row.planKey,
        );
        if (!line)
          return `<div class="cart-line"><div class="cart-line-info"><h3>Satışta olmayan paket</h3><small>${e(row.productId)} / ${e(row.planKey)}</small></div><button class="button secondary small" data-action="remove" data-id="${e(row.productId)}" data-plan="${e(row.planKey)}">Kaldır</button></div>`;
        return `<article class="cart-line"><a href="/urun/${e(line.productId)}" data-nav><img src="${e(safeImage(line.product.image))}" alt="${e(line.product.name)}" width="80" height="80"/></a><div class="cart-line-info"><h3><a href="/urun/${e(line.productId)}" data-nav>${e(line.product.name)}</a></h3><small>${e(line.plan.label)} · ${e(line.plan.duration)} · ${line.product.platform === "ios" ? "iOS" : "Android"}</small><div class="quantity"><button data-action="quantity" data-change="-1" data-id="${e(line.productId)}" data-plan="${e(line.planKey)}" aria-label="${e(line.product.name)} adedini azalt">${icon("minus")}</button><span aria-label="Adet">${line.quantity}</span><button data-action="quantity" data-change="1" data-id="${e(line.productId)}" data-plan="${e(line.planKey)}" aria-label="${e(line.product.name)} adedini artır">${icon("plus")}</button></div></div><span class="cart-line-price">${money(line.totalKurus)}</span><button class="remove-item" data-action="remove" data-id="${e(line.productId)}" data-plan="${e(line.planKey)}" aria-label="${e(line.product.name)} ürününü kaldır">${icon("close")}</button></article>`;
      })
      .join(
        "",
      )}</div><aside class="panel checkout-panel"><h2>Sipariş özeti</h2><div class="summary-row"><span>Ürünler</span><b>${money(view.totalKurus)}</b></div>${state.promotion ? `<div class="summary-row discount"><span>${e(state.promotion.code)} indirimi</span><b>−${money(state.promotion.discountKurus)}</b></div>` : ""}<div class="summary-row total"><span>Toplam</span><span>${money(Math.max(0, view.totalKurus - (state.promotion?.discountKurus || 0)))}</span></div><form class="coupon-input" id="coupon-form"><label class="sr-only" for="coupon-code">İndirim kodu</label><input id="coupon-code" name="code" placeholder="İndirim kodun var mı?" maxlength="32" required/><button class="button secondary small" type="submit">Uygula</button></form><fieldset class="payment-options" style="border:0;padding:0"><legend class="fine-print">Ödeme yöntemi</legend>${walletAllowed ? `<label class="payment-option"><input type="radio" name="payment" value="wallet" ${state.payment === "wallet" ? "checked" : ""}/><span><b>Bakiye ile öde</b><small>Hesap bakiyen: ${uid() ? (state.auth.account && !state.auth.accountStale ? money(state.auth.account.balanceKurus) : "Doğrulama bekleniyor") : "Giriş yaparak görüntüle"}</small></span></label>` : ""}<label class="payment-option"><input type="radio" name="payment" value="telegram" ${state.payment === "telegram" ? "checked" : ""}/><span><b>Telegram üzerinden görüş</b><small>Ödeme ve teslimat için destek ekibiyle iletişim kur.</small></span></label></fieldset><button class="button primary" data-action="checkout" ${gate.disabled ? "disabled" : ""}>${icon("shield")} ${e(gate.label)} ${icon("arrow")}</button>${gate.message ? `<p class="fine-print checkout-message" role="status">${e(gate.message)}</p>` : ""}<p class="fine-print">Kesin fiyat ve stok sipariş anında doğrulanır. Telegram siparişi, ödemenin onaylandığı anlamına gelmez.</p></aside></div>`
  );
}
function avatarMarkup() {
  const a = state.catalog?.avatars?.find(
    (x) => x.id === state.auth.account?.avatarId,
  );
  return a && /^https:\/\/encrypted-tbn0\.gstatic\.com\/images\?/.test(a.image)
    ? `<img src="${e(a.image)}" alt="" width="64" height="64" referrerpolicy="no-referrer"/>`
    : e(userName().slice(0, 1).toLocaleUpperCase("tr-TR"));
}
function avatarDialog() {
  modal({
    title: "Profil görselini seç",
    body: `<fieldset class="avatar-options"><legend class="sr-only">Profil görseli</legend>${(state.catalog?.avatars || []).map((a) => `<label><input type="radio" name="avatarId" value="${e(a.id)}" ${a.id === state.auth.account?.avatarId ? "checked" : ""} required/><span><img src="${e(a.image)}" alt="${e(a.label)}" width="64" height="64" loading="lazy" referrerpolicy="no-referrer"/></span></label>`).join("")}</fieldset>`,
    onSubmit: async (data) => {
      await storeApi("/api/store/profile/avatar", {
        method: "PATCH",
        body: { avatarId: data.get("avatarId") },
      });
      await refreshStoreAccount({ force: true });
      toast("Profil görselin kaydedildi.");
      render();
    },
  });
}
function accountShell(content, active = "account") {
  return `<div class="account-layout"><aside class="panel account-sidebar"><div class="account-identity"><button class="avatar avatar-picker" data-action="avatar" aria-label="Profil görselini değiştir">${avatarMarkup()}</button><h2>${e(userName())}</h2><p>${e(state.auth.user?.email)}</p></div><nav class="account-menu" aria-label="Hesap menüsü">${[
    ["/hesabim", "account", "user", "Hesabım"],
    ["/siparisler", "orders", "box", "Siparişlerim"],
    ["/kuponlar", "coupons", "wallet", "Kuponlarım"],
    ["/favoriler", "favorites", "heart", "Favorilerim"],
    ["/bildirimler", "notifications", "bell", "Bildirimler"],
    ["/destek", "support", "support", "Yardım & destek"],
  ]
    .map(
      ([url, key, ic, label]) =>
        `<a href="${url}" data-nav class="${active === key ? "active" : ""}">${icon(ic)} ${label}</a>`,
    )
    .join(
      "",
    )}<button data-action="logout">${icon("logout")} Güvenli çıkış</button></nav></aside><section class="account-content">${content}</section></div>`;
}
function account() {
  const a = state.auth.account || {};
  return accountShell(
    `<div class="welcome-panel"><div><span class="eyebrow">ZENTRA HESABIN</span><h2>Merhaba, ${e(a.firstName || userName())}.</h2><p>Siparişlerin ve dijital dünyan kontrolün altında.</p></div><div class="balance-number"><small>Kullanılabilir bakiyen</small>${!state.auth.account || state.auth.accountStale ? "Doğrulanamadı" : money(a.balanceKurus)}</div></div>${state.auth.warning ? `<div class="notice">${e(state.auth.warning)}</div>` : ""}<div class="account-card-grid"><div class="panel"><h2>Profil bilgilerin</h2><p>${e(a.firstName || "")} ${e(a.lastName || "")}<br/>${e(a.username || userName())}<br/>${e(a.birthDate || "Doğum tarihi kayıtlı değil")}</p><button class="button secondary small" data-action="profile">${icon("edit")} Bilgilerimi düzenle</button></div><div class="panel"><h2>Hesap güvenliği</h2><p>${e(state.auth.user.email)}<br/>${state.auth.user.emailVerified ? "E-posta doğrulanmış" : "E-posta henüz doğrulanmamış"}</p><button class="button secondary small" data-action="security">${icon("shield")} Güvenlik ayarları</button></div><div class="panel"><h2>Siparişlerin bir arada</h2><p>Ödeme durumunu, sipariş adımlarını ve teslimat bilgilerini hesabından takip et.</p><a class="button secondary small" href="/siparisler" data-nav>Siparişlerimi gör ${icon("arrow")}</a></div><div class="panel"><h2>Sana ait kodlar</h2><p>Bakiye kodunu hesabına tanımla, kullanılabilir indirimlerini incele.</p><a class="button secondary small" href="/kuponlar" data-nav>Kuponlarım ${icon("arrow")}</a></div></div>`,
  );
}
function orderCard(o) {
  const payment =
    {
      unverified: "Ödeme kaydı doğrulanmalı",
      refunded: "İade tamamlandı",
      not_captured: "Ödeme alınmadı",
      rejected: "Ödeme reddedildi",
      captured: "Bakiye tahsil edildi",
      confirmed_manually: "Manuel ödeme teyit edildi",
      pending: "Ödeme teyidi bekleniyor",
      external: "Dış ödeme teyidi bekleniyor",
    }[o.paymentState] ||
    o.paymentWorkflow?.label ||
    "Doğrulanıyor";
  return `<article class="order-card"><header><div><b>#${e(o.orderNumber || o.id)}</b><small>${date(o.createdAt)}</small></div>${status(o.status)}</header>${(o.items || []).map((x) => `<div class="order-line"><div><b>${e(x.productName)}</b><small>${e(x.planLabel)} · ${x.quantity} adet</small></div><span>${money(x.lineTotalKurus)}</span></div>`).join("")}<p class="order-payment">${o.paymentMethod === "telegram" ? "Telegram" : o.paymentMethod === "wallet" ? "Bakiye" : "Ödeme kanalı incelenmeli"} · ${e(payment)}</p><footer><strong>${money(o.totalKurus)}</strong>${o.delivery?.canOpen ? `<button class="button primary small" data-action="delivery" data-id="${e(o.id)}">Teslimatımı aç</button>` : ""}${o.telegramUrl && /^https:\/\/t\.me\//.test(o.telegramUrl) ? `<a class="button secondary small" href="${e(o.telegramUrl)}" target="_blank" rel="noopener noreferrer">Telegram ${icon("arrow")}</a>` : ""}${o.cancellable ? `<button class="button secondary small" data-action="cancel-order" data-id="${e(o.id)}">İptal et</button>` : ""}</footer></article>`;
}
function orders() {
  return accountShell(
    heading("Siparişlerim", "HER ADIMI TAKİP ET") +
      (state.orders.length
        ? state.orders.map(orderCard).join("")
        : empty(
            "Henüz siparişin yok",
            "Seçtiğin ürünler ve teslimat bilgileri burada görünecek.",
          )) +
      (state.orderCursor
        ? '<button class="button secondary" data-action="more-orders">Daha fazla göster</button>'
        : ""),
    "orders",
  );
}
function authPage() {
  const reg = authMode(location.search) === "register";
  return `<section class="auth-page"><div class="auth-form-panel"><div class="auth-tabs" role="tablist" aria-label="Hesap işlemi"><button role="tab" aria-selected="${!reg}" data-action="auth-tab" data-tab="login" class="${!reg ? "active" : ""}">Giriş yap</button><button role="tab" aria-selected="${reg}" data-action="auth-tab" data-tab="register" class="${reg ? "active" : ""}">Hesap oluştur</button></div><h1>${reg ? "Zentra’ya katıl." : "Yeniden hoş geldin."}</h1><p>${reg ? "Sadece sana ait bir alışveriş deneyimi." : "Kaldığın yerden keşfetmeye devam et."}</p><form id="auth-form">${reg ? `<div class="field-row">${field("firstName", "Ad", "text", "", 'required maxlength="50" autocomplete="given-name"')}${field("lastName", "Soyad", "text", "", 'required maxlength="50" autocomplete="family-name"')}</div>${field("username", "Kullanıcı adı", "text", "", 'required minlength="5" maxlength="20" autocomplete="username"')}${field("birthDate", "Doğum tarihi", "date", "", 'required min="1900-01-01" max="' + new Date().toISOString().slice(0, 10) + '"')}${field("email", "E-posta", "email", "", 'required maxlength="254" autocomplete="email"')}` : field("identifier", "E-posta veya kullanıcı adı", "text", "", 'required maxlength="254" autocomplete="username"')}${field("password", "Şifre", "password", "", 'required minlength="8" maxlength="4096" autocomplete="' + (reg ? "new-password" : "current-password") + '"')}${reg ? field("passwordRepeat", "Şifre tekrarı", "password", "", 'required minlength="8" autocomplete="new-password"') : ""}<label class="checkbox"><input name="remember" type="checkbox"/> Bu cihazda oturumumu açık tut</label><p class="form-error" role="alert" hidden></p><button type="submit" class="button primary">${reg ? "Hesap oluştur" : "Güvenli giriş yap"} ${icon("arrow")}</button></form>${!reg ? '<button class="text-button fine-print" data-action="reset-password">Şifremi unuttum</button>' : ""}<p class="fine-print">Hesap bilgilerin yalnızca hesap ve sipariş işlemlerinde kullanılır. Ayrıntıları gizlilik alanından inceleyebilirsin.</p></div></section>`;
}
function socialLinks() {
  return (state.catalog?.storefront?.quickLinks || []).filter(
    (x) => x.enabled !== false && /^https:\/\//.test(x.url),
  );
}
function support() {
  const links = socialLinks();
  return (
    heading(
      "Bir mesaj kadar yakınız",
      "YARDIM & DESTEK",
      "Siparişin veya ürünlerin hakkında bize ulaş.",
    ) +
    `<section class="support-grid">${links.map((l) => `<article class="support-card">${icon(l.platform === "telegram" ? "telegram" : "support")}<h2>${e(l.title)}</h2><p>${e(l.description)}</p><a class="button secondary" href="${e(l.url)}" target="_blank" rel="noopener noreferrer">İletişime geç ${icon("arrow")}</a></article>`).join("")}</section><section class="faq"><div class="section-heading"><h2>Aklına takılanlar.</h2></div>${[
      [
        "Siparişim ne zaman teslim edilir?",
        "Bakiye ile ve uygun otomatik stokla verilen siparişlerde teslimat sipariş kaydıyla birlikte hazırlanır. Telegram siparişlerinde ödeme ve teslimat destek ekibi tarafından ayrı olarak teyit edilir.",
      ],
      [
        "Telegram’a gitmek ödeme yapmak mı demek?",
        "Hayır. Sipariş kaydı oluşturulur ve destek mesajın hazırlanır. Gerçek ödeme teyit edilmeden sipariş ödenmiş sayılmaz.",
      ],
      [
        "Teslimat bilgilerimi nerede bulabilirim?",
        "Hesabına giriş yaptıktan sonra Siparişlerim alanını aç. Teslim edilmiş uygun siparişlerde Teslimatımı aç düğmesini kullan.",
      ],
      [
        "Siparişimi iptal edebilir miyim?",
        "Siparişinin durumuna uygun iptal seçeneği sipariş kartında gösterilir. Teslim edilmiş ve ödeme teyidi gerektiren işlemlerde destek ekibine ulaş.",
      ],
    ]
      .map(([q, a]) => `<details><summary>${q}</summary><p>${a}</p></details>`)
      .join("")}</section>`
  );
}
async function render() {
  const version = ++state.render,
    r = route();
  const paint = (markup) =>
    presentScreen(main, markup, { isCurrent: () => version === state.render });
  header();
  const titles = {
    home: "Android ve iOS ürünleri",
    catalog: "Tüm ürünler",
    category: r.id,
    product: product(r.id)?.name || "Ürün",
    cart: "Sepetim",
    account: uid()
      ? "Hesabım"
      : authMode(location.search) === "register"
        ? "Kayıt Ol"
        : "Giriş Yap",
    orders: "Siparişlerim",
    favorites: "Favorilerim",
    support: "Yardım & destek",
    notifications: "Bildirimler",
    coupons: "Kuponlarım",
  };
  document.title = `${titles[r.name]} | Zentra Store`;
  const progress = $("#navigation-progress");
  progress.classList.add("active");
  try {
    if (
      ["account", "orders", "notifications", "coupons"].includes(r.name) &&
      !uid()
    ) {
      await paint(
        state.auth.ready
          ? authPage()
          : `<div class="empty-state"><span class="spinner"></span><p>Güvenli hesap bağlantısı hazırlanıyor…</p></div>`,
      );
      return;
    }
    if (
      !state.catalog &&
      [
        "home",
        "catalog",
        "category",
        "product",
        "favorites",
        "cart",
        "support",
      ].includes(r.name)
    ) {
      if (state.catalogError)
        await paint(
          empty("Mağaza bağlantısı bekleniyor", state.catalogError, "", "") +
            '<p style="text-align:center"><button class="button primary" data-action="reload-catalog">Yeniden dene</button></p>',
        );
      return;
    }
    if (r.name === "orders") {
      if (!state.ordersLoaded) {
        await paint(
          '<div class="empty-state"><span class="spinner"></span><p>Siparişlerin yükleniyor…</p></div>',
        );
        const result = await storeApi("/api/store/orders?limit=20");
        if (version !== state.render) return;
        state.orders = result.orders || [];
        state.orderCursor = result.nextCursor || "";
        state.ordersLoaded = true;
      }
      await paint(orders());
    } else if (r.name === "notifications") {
      const result = await storeApi("/api/store/notifications");
      if (version !== state.render) return;
      state.notifications = result.notifications || [];
      await paint(
        accountShell(
          heading("Bildirimler", "GÜNCEL KAL") +
            `<div class="panel">${state.notifications.length ? state.notifications.map((n) => `<article class="notification-item"><b>${e(n.title)}</b><p>${e(n.message)}</p><small>${date(n.createdAt)}</small>${!n.readAt ? `<button class="button secondary small" data-action="notification-read" data-id="${e(n.id)}">Okundu olarak işaretle</button>` : ""}</article>`).join("") : empty("Her şey güncel", "Yeni stok ve hesap bildirimleri burada görünecek.", "", "")}</div>`,
          "notifications",
        ),
      );
    } else if (r.name === "coupons") {
      const result = await storeApi("/api/store/promotions");
      if (version !== state.render) return;
      state.coupons = result.promotions || [];
      await paint(
        accountShell(
          heading("Kuponlarım", "SANA AİT AVANTAJLAR") +
            `<div class="panel"><h2>Bakiye kodunu kullan</h2><p class="fine-print">Geçerli bakiye kodun sunucuda doğrulandıktan sonra hesabına uygulanır.</p><form class="coupon-input" id="balance-code-form"><label class="sr-only" for="balance-code">Bakiye kodu</label><input id="balance-code" name="code" maxlength="32" placeholder="Bakiye kodunu gir" required/><button type="submit" class="button primary small">Kodu kullan</button></form></div><div class="account-card-grid" style="margin-top:20px">${state.coupons.map((c) => `<div class="panel"><span class="eyebrow">${e(c.code)}</span><h2>${e(c.title)}</h2><p>${c.type === "percent" ? e(c.value) + "% indirim" : money(c.value) + " indirim"}</p><button class="button secondary small" data-action="copy-code" data-code="${e(c.code)}">Kodu kopyala</button></div>`).join("")}</div>`,
          "coupons",
        ),
      );
    } else
      await paint(
        r.name === "home"
          ? home()
          : ["catalog", "category", "favorites"].includes(r.name)
            ? catalogMarkup(r)
            : r.name === "product"
              ? detail(r.id)
              : r.name === "cart"
                ? cartMarkup()
                : r.name === "account"
                  ? account()
                  : support(),
      );
  } catch (error) {
    if (version !== state.render) return;
    await paint(
      heading("Bağlantı tamamlanamadı") +
        `<div class="notice error">${e(message(error))}</div><button class="button secondary" data-action="retry-view">Yeniden dene</button>`,
    );
  } finally {
    if (version === state.render) progress.classList.remove("active");
  }
}
async function loadCatalog() {
  state.catalogError = "";
  try {
    await loadStoreRuntimeConfig();
    const result = await storeApi("/api/store/catalog", {
      auth: false,
      timeoutMs: 15000,
    });
    state.catalog = result.catalog || result;
    try {
      const response = await storeApi("/api/store/experience", {
        auth: false,
        timeoutMs: 5000,
      });
      state.experience = response.experience;
      const nav = document.querySelector(".category-nav");
      nav.querySelectorAll("[data-custom-category]").forEach((n) => n.remove());
      for (const category of state.experience?.categories || []) {
        const link = document.createElement("a");
        link.href = "/kategori/" + category.id;
        link.dataset.nav = "";
        link.dataset.customCategory = category.id;
        link.textContent = category.name;
        nav.insertBefore(link, nav.querySelector(".nav-support"));
      }
    } catch {}
    const links = socialLinks();
    $("#footer-social").innerHTML = ["tiktok", "telegram", "instagram"]
      .map((type) => links.find((l) => l.platform === type))
      .filter(Boolean)
      .map(
        (l) =>
          `<a href="${e(l.url)}" target="_blank" rel="noopener noreferrer">${e(l.platform.charAt(0).toUpperCase() + l.platform.slice(1))} →</a>`,
      )
      .join("");
  } catch (error) {
    state.catalogError = message(error);
  }
  await render();
}
function add(id, key) {
  if (tracker.pending())
    throw new Error("Önce sonucu belirsiz siparişini kontrol et.");
  const p = product(id);
  if (!p || !p.plans.some((x) => x.key === key))
    throw new Error("Paket doğrulanamadı.");
  cart.add(id, key);
  state.promotion = null;
  header();
  toast("Ürün sepetine eklendi.");
}
function authRequired() {
  if (uid()) return false;
  go(authPath("login", location.pathname + location.search));
  toast("Devam etmek için hesabına giriş yap.", "info");
  return true;
}
function completeOrder(result, attempt) {
  if (attempt.uid !== uid()) return;
  tracker.finish(attempt);
  if (attempt.clearCart) cart.clear();
  state.ordersLoaded = false;
  state.promotion = null;
  void refreshStoreAccount({ force: true }).catch(() => {});
  go("/siparisler");
  toast(
    result.order?.paymentMethod === "telegram"
      ? "Sipariş kaydın oluşturuldu. Ödeme teyidi bekleniyor."
      : "Sipariş kaydın doğrulandı.",
  );
  if (result.telegramUrl || result.order?.telegramUrl) {
    const url = result.telegramUrl || result.order.telegramUrl;
    if (/^https:\/\/t\.me\//.test(url))
      modal({
        title: "Sipariş kaydın hazır",
        body: `<p class="fine-print">Ödeme ve teslimat için hazırlanan mesajla destek ekibine ulaş. Bu adım bir ödeme onayı değildir.</p><a class="button primary" style="margin-top:20px" href="${e(url)}" target="_blank" rel="noopener noreferrer">Telegram’da devam et ${icon("arrow")}</a>`,
      });
  }
}
async function recover(button) {
  busy(button, true, "Sorgulanıyor…");
  try {
    const attempt = tracker.pending();
    if (!attempt) return;
    const result = await tracker.verify(attempt);
    if (result?.found && result.order) completeOrder(result, attempt);
    else if (result?.cancelled) {
      tracker.finish(attempt);
      toast("Önceki deneme kapatıldı.");
      render();
    } else
      modal({
        title: "Sipariş sonucu henüz kesinleşmedi",
        body: '<p class="fine-print">Aynı sipariş için yeni ödeme oluşturma. Sonucu yeniden sorgulayabilir veya tamamlanmamış denemeyi güvenli biçimde kapatabilirsin. Oluşmuş bir sipariş kapatılmaz; önce mevcut sonuç döndürülür.</p>',
        submit: "Tamamlanmamış denemeyi kapat",
        onSubmit: async () => {
          const result = await storeApi("/api/store/order-attempt/cancel", {
            body: { idempotencyKey: attempt.body.idempotencyKey },
          });
          if (result.found && result.order) completeOrder(result, attempt);
          else if (result.cancelled) {
            tracker.finish(attempt);
            toast("Tamamlanmamış deneme kapatıldı.");
            render();
          } else throw new Error("Denemenin kapatıldığı doğrulanamadı.");
        },
      });
  } catch (error) {
    toast(message(error), "error");
  } finally {
    busy(button, false);
  }
}
async function checkout(button) {
  if (authRequired() || state.checkoutBusy) return;
  if (tracker.pending()) return recover(button);
  const view = cartView();
  if (!view.lines.length || view.invalid.length)
    throw new Error("Sepetini kontrol et.");
  state.checkoutBusy = true;
  busy(button, true, "Sipariş doğrulanıyor…");
  const attempt = tracker.start(
    {
      items: view.lines.map((x) => ({
        productId: x.productId,
        planKey: x.planKey,
        quantity: x.quantity,
        expectedUnitPriceKurus: x.plan.priceKurus,
      })),
      paymentMethod: state.payment,
      idempotencyKey: crypto.randomUUID(),
      ...(state.promotion?.code ? { promotionCode: state.promotion.code } : {}),
    },
    { clearCart: true },
  );
  try {
    const result = await storeApi("/api/store/orders", {
      body: attempt.body,
      timeoutMs: 25000,
    });
    completeOrder(result, attempt);
  } catch (error) {
    if (
      error.mutationNotSent ||
      (![0, 408, 500, 502, 503, 504].includes(Number(error.status || 0)) &&
        error.code !== "REQUEST_TIMEOUT")
    ) {
      tracker.finish(attempt);
    }
    toast(message(error), "error");
    if (tracker.pending()) await recover(button);
    else await loadCatalog();
  } finally {
    state.checkoutBusy = false;
    busy(button, false);
  }
}
function profileDialog() {
  const a = state.auth.account || {};
  modal({
    title: "Profil bilgilerini düzenle",
    body: `<p class="fine-print">Değiştirmek istediğin bilgiyi seç. Her değişiklik hesap şifrenle doğrulanır.</p><label class="field"><span>Güncellenecek bilgi</span><select name="kind"><option value="fullName">Ad ve soyad</option><option value="username">Kullanıcı adı</option><option value="birthDate">Doğum tarihi</option></select></label><div class="field-row">${field("firstName", "Ad", "text", a.firstName || "", 'maxlength="50"')}${field("lastName", "Soyad", "text", a.lastName || "", 'maxlength="50"')}</div>${field("username", "Kullanıcı adı", "text", a.username || "", 'maxlength="20"')}${field("birthDate", "Doğum tarihi", "date", a.birthDate || "")}${field("currentPassword", "Hesap şifren", "password", "", 'required autocomplete="current-password"')}`,
    onSubmit: async (data) => {
      const kind = data.get("kind"),
        values =
          kind === "fullName"
            ? {
                firstName: data.get("firstName"),
                lastName: data.get("lastName"),
              }
            : kind === "username"
              ? { username: data.get("username") }
              : { birthDate: data.get("birthDate") };
      await changeStoreIdentity({
        field: kind,
        values,
        currentPassword: data.get("currentPassword"),
      });
      toast("Profil bilgin kaydedildi.");
      render();
    },
  });
}
function securityDialog() {
  modal({
    title: "Hesap güvenliği",
    body: `<label class="field"><span>İşlem</span><select name="kind"><option value="password">Şifremi değiştir</option><option value="email">E-postamı değiştir</option></select></label>${field("currentPassword", "Mevcut şifren", "password", "", 'required autocomplete="current-password"')}${field("newPassword", "Yeni şifre", "password", "", 'minlength="8" autocomplete="new-password"')}${field("newPasswordRepeat", "Yeni şifre tekrarı", "password", "", 'autocomplete="new-password"')}${field("newEmail", "Yeni e-posta", "email", "", 'autocomplete="email"')}<p class="fine-print">E-posta değişikliği, yeni adrese gelen bağlantı doğrulanmadan tamamlanmaz.</p>`,
    onSubmit: async (data) => {
      if (data.get("kind") === "email") {
        await changeStoreEmail({
          newEmail: data.get("newEmail"),
          currentPassword: data.get("currentPassword"),
        });
        toast("Yeni e-postaya doğrulama bağlantısı gönderildi.");
      } else {
        await changeStorePassword(Object.fromEntries(data));
        toast("Şifren güncellendi.");
      }
      render();
    },
  });
}
async function action(button) {
  const { action: a, id, plan } = button.dataset;
  if (state.checkoutBusy && !["recover"].includes(a)) return;
  try {
    if (a === "quick-add") return packagePicker(id);
    if (a === "gallery-select" || a === "gallery-step") {
      const pictures = productGallery(product(id));
      const current = galleryIndex(
        state.selectedImages.get(id),
        pictures.length,
      );
      selectGallery(
        id,
        a === "gallery-select"
          ? Number(button.dataset.index)
          : current + Number(button.dataset.step),
      );
      return;
    }
    if (a === "copy-delivery") {
      const value = button
        .closest(".delivery-item")
        ?.querySelector(".delivery-secret")?.textContent;
      if (!value) throw new Error("Kopyalanacak teslimat bilgisi bulunamadı.");
      await copyText(value);
      toast("Teslimat bilgisi kopyalandı.");
      return;
    }
    if (a === "add") {
      add(id, plan);
      return;
    }
    if (a === "favorite") {
      favorites.has(id) ? favorites.delete(id) : favorites.add(id);
      try {
        storage?.setItem("zentra-favorites-v2", JSON.stringify([...favorites]));
      } catch {}
      render();
      return;
    }
    if (a === "remove" || a === "quantity") {
      if (tracker.pending())
        throw new Error("Önce bekleyen sipariş sonucunu kontrol et.");
      if (a === "remove") cart.remove(id, plan);
      else {
        const row = cart
            .items()
            .find((x) => x.productId === id && x.planKey === plan),
          qty = (row?.quantity || 0) + Number(button.dataset.change);
        if (qty > 5)
          throw new Error("Bir paketten en fazla 5 adet seçebilirsin.");
        if (qty < 1) cart.remove(id, plan);
        else cart.quantity(id, plan, qty);
      }
      state.promotion = null;
      render();
      return;
    }
    if (a === "checkout") return await checkout(button);
    if (a === "recover") return await recover(button);
    if (a === "reload-catalog") return await loadCatalog();
    if (a === "retry-view") return await render();
    if (a === "auth-tab") {
      go(
        authPath(
          button.dataset.tab,
          new URLSearchParams(location.search).get("next") ||
            (route().name !== "account"
              ? location.pathname + location.search
              : ""),
        ),
      );
      return;
    }
    if (a === "reset-password") {
      modal({
        title: "Şifreni yenile",
        body: field(
          "identifier",
          "E-posta veya kullanıcı adı",
          "text",
          "",
          'required autocomplete="username"',
        ),
        submit: "Yenileme bağlantısı iste",
        onSubmit: async (data) => {
          await resetStorePassword(data.get("identifier"));
          toast("Bilgiler eşleşiyorsa şifre yenileme bağlantısı gönderildi.");
        },
      });
      return;
    }
    if (a === "logout") {
      await logoutStore();
      state.orders = [];
      state.ordersLoaded = false;
      go("/hesabim");
      toast("Oturumun kapatıldı.");
      return;
    }
    if (a === "avatar") return avatarDialog();
    if (a === "profile") return profileDialog();
    if (a === "security") return securityDialog();
    if (a === "filters") {
      const r = route();
      modal({
        title: "Aramanı daralt",
        body: `<div class="field-row">${field("min", "En düşük fiyat (₺)", "number", r.query.get("min") || "", 'min="0" step="1"')}${field("max", "En yüksek fiyat (₺)", "number", r.query.get("max") || "", 'min="0" step="1"')}</div><label class="checkbox"><input type="checkbox" name="stock" ${r.query.get("stock") === "1" ? "checked" : ""}/> Yalnızca doğrulanmış stoktaki ürünler</label>`,
        submit: "Sonuçları göster",
        onSubmit: (data) => {
          const min = Number(data.get("min")),
            max = Number(data.get("max"));
          if (min && max && max < min)
            throw new Error("En yüksek fiyat, en düşük fiyattan az olamaz.");
          const u = new URL(location.href);
          for (const k of ["min", "max", "stock"]) u.searchParams.delete(k);
          if (min) u.searchParams.set("min", min);
          if (max) u.searchParams.set("max", max);
          if (data.get("stock")) u.searchParams.set("stock", "1");
          go(u.pathname + u.search);
        },
      });
      return;
    }
    if (a === "more-orders") {
      const requestUid = uid(),
        requestView = state.render;
      busy(button, true);
      const result = await storeApi(
        "/api/store/orders?limit=20&cursor=" +
          encodeURIComponent(state.orderCursor),
      );
      if (requestUid !== uid() || requestView !== state.render) return;
      state.orders.push(...(result.orders || []));
      state.orderCursor = result.nextCursor || "";
      main.innerHTML = orders();
      return;
    }
    if (a === "cancel-order") {
      modal({
        title: "Siparişini iptal et",
        body:
          '<p class="fine-print">İptal uygunluğu sunucuda tekrar denetlenir. Ödenmiş veya teslim edilmiş siparişler otomatik iptal edilmez.</p>' +
          field(
            "reason",
            "İptal nedeni",
            "text",
            "",
            'required minlength="3" maxlength="240"',
          ),
        submit: "İptali onayla",
        danger: true,
        onSubmit: async (data) => {
          await storeApi(`/api/store/orders/${encodeURIComponent(id)}/cancel`, {
            body: { reason: data.get("reason") },
          });
          state.ordersLoaded = false;
          toast("Siparişin iptali doğrulandı.");
          render();
        },
      });
      return;
    }
    if (a === "delivery") {
      const ownerUid = uid();
      busy(button, true, "Açılıyor…");
      const result = await storeApi(
        `/api/store/orders/${encodeURIComponent(id)}/delivery`,
      );
      if (!ownerUid || ownerUid !== uid()) return;
      const d = result.delivery || {};
      const items = d.items || d.keys || [];
      modal({
        title: "Teslimat bilgilerin",
        body: `<p class="fine-print">Bu bilgiler sana özeldir. Güvenli bir yerde sakla.</p>${items.length ? items.map((x) => `<div class="delivery-item"><b>${e(x.productName || x.label || "Ürün")}</b><code class="delivery-secret">${e(x.copyValue || x.value || x.key || (x.type === "account" ? JSON.stringify(x) : x.secret) || "")}</code><button type="button" class="button secondary small" data-action="copy-delivery">${icon("copy")} Bilgiyi kopyala</button></div>`).join("") : `<p>${e(d.message || "Teslimat verileri bu görünümde gösterilemedi. Sipariş referansınla desteğe ulaş.")}</p>`}`,
      });
      return;
    }
    if (a === "restock") {
      if (authRequired()) return;
      busy(button, true);
      await storeApi("/api/store/restock-subscriptions", {
        body: { productId: id, planKey: plan },
      });
      toast("Stok bildirimi isteğin kaydedildi.");
      return;
    }
    if (a === "notification-read") {
      busy(button, true);
      await storeApi(
        `/api/store/notifications/${encodeURIComponent(id)}/read`,
        { method: "PATCH", body: {} },
      );
      render();
      return;
    }
    if (a === "copy-code") {
      await copyText(button.dataset.code);
      toast("Kod kopyalandı.");
    }
  } catch (error) {
    toast(message(error), "error");
  } finally {
    if (button.isConnected) busy(button, false);
  }
}
document.addEventListener("click", (event) => {
  const nav = event.target.closest("a[data-nav]");
  if (
    nav &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    event.button === 0
  ) {
    const u = new URL(nav.href, location.href);
    if (u.origin === location.origin) {
      event.preventDefault();
      $("#search-suggestions").hidden = true;
      go(u.pathname + u.search);
      return;
    }
  }
  const button = event.target.closest("[data-action]");
  if (button) {
    event.preventDefault();
    void action(button);
  }
  const info = event.target.closest("[data-info]");
  if (info) {
    modal({
      title:
        info.dataset.info === "privacy"
          ? "Gizlilik ve veri kullanımı"
          : "Satın alma bilgileri",
      body: `<p class="fine-print">${info.dataset.info === "privacy" ? "Hesap, sipariş ve güvenlik bilgileriniz hizmetin sunulması ve işlem güvenliği için saklanır. Yalnızca kendi hesabınıza ait müşteri verilerine erişebilirsiniz. Veri talepleri için destek ekibine ulaşabilirsiniz." : "Ürün türü, platform ve paket süresini satın almadan önce kontrol edin. Bakiye ile alışverişte tutar ve stok sunucuda doğrulanır. Telegram siparişinde ödeme ve teslimat ayrıca teyit edilir. İptal ve iade talebiniz siparişin durumu ve geçerli koşullara göre değerlendirilir. Satıcıya ait sözleşme ve iletişim bilgileri için destek ekibine ulaşın."}</p><a class="button secondary" style="margin-top:16px" href="/destek" data-nav>Destek ekibine ulaş</a>`,
    });
  }
});
document.addEventListener("change", (event) => {
  if (event.target.id === "sort-products") {
    const u = new URL(location.href);
    event.target.value
      ? u.searchParams.set("sort", event.target.value)
      : u.searchParams.delete("sort");
    go((u.pathname === "/" ? "/magaza" : u.pathname) + u.search);
  }
  if (event.target.name === "product-plan") {
    state.selectedPlans.set(event.target.dataset.product, event.target.value);
    render();
  }
  if (event.target.name === "payment") state.payment = event.target.value;
});
document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!["auth-form", "coupon-form", "balance-code-form"].includes(form.id))
    return;
  event.preventDefault();
  const data = new FormData(form),
    button = form.querySelector("[type=submit]");
  busy(button, true);
  try {
    if (form.id === "auth-form") {
      if (authMode(location.search) === "register")
        await registerStore({
          ...Object.fromEntries(data),
          remember: data.get("remember") === "on",
        });
      else
        await signInStore({
          identifier: data.get("identifier"),
          password: data.get("password"),
          remember: data.get("remember") === "on",
        });
      toast("Hesap oturumun doğrulandı.");
      const next = safeReturnTo(
        new URLSearchParams(location.search).get("next") ||
          (route().name !== "account"
            ? location.pathname + location.search
            : ""),
      );
      go(next || (cart.items().length ? "/sepet" : "/hesabim"), {
        replace: true,
      });
    } else if (form.id === "coupon-form") {
      if (authRequired()) return;
      const result = await storeApi("/api/store/promotions/validate", {
        body: { items: cart.items(), code: data.get("code") },
      });
      state.promotion = result.promotion;
      toast("İndirim kodu doğrulandı.");
      render();
    } else {
      await storeApi("/api/store/balance-codes/redeem", {
        body: { code: data.get("code") },
      });
      await refreshStoreAccount({ force: true });
      toast("Bakiye kodunun sonucu doğrulandı.");
      render();
    }
  } catch (error) {
    const node = form.querySelector(".form-error");
    if (node) {
      node.hidden = false;
      node.textContent = message(error);
    } else toast(message(error), "error");
  } finally {
    busy(button, false);
  }
});
$("#search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const q = $("#search-input").value.trim();
  $("#search-suggestions").hidden = true;
  go("/magaza" + (q ? "?q=" + encodeURIComponent(q) : ""));
});
let searchTimer;
$("#search-input").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const q = $("#search-input").value.trim(),
      box = $("#search-suggestions");
    if (q.length < 2 || !state.catalog) {
      box.hidden = true;
      return;
    }
    const rows = filtered({
      name: "catalog",
      query: new URLSearchParams({ q }),
    }).slice(0, 5);
    box.innerHTML = rows.length
      ? rows
          .map(
            (p) =>
              `<a class="suggestion" href="/urun/${e(p.id)}" data-nav><img src="${e(safeImage(p.image))}" alt="" width="38" height="38"/><span><b>${e(p.name)}</b><br/><small>${p.platform === "ios" ? "iOS" : "Android"}</small></span><span><small>${money(Math.min(...p.plans.map((x) => x.priceKurus)))}</small></span></a>`,
          )
          .join("")
      : '<p class="fine-print" style="padding:12px">Bu aramayla eşleşen ürün yok.</p>';
    box.hidden = false;
  }, 180);
});
document.addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
  const gallery = event.target.closest?.(".product-gallery");
  if (!gallery) return;
  event.preventDefault();
  const id = gallery.dataset.galleryProduct;
  selectGallery(
    id,
    (state.selectedImages.get(id) || 0) + (event.key === "ArrowRight" ? 1 : -1),
  );
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "k") {
    event.preventDefault();
    $("#search-input").focus();
  }
  if (event.key === "Escape") $("#search-suggestions").hidden = true;
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".search")) $("#search-suggestions").hidden = true;
});
window.addEventListener("popstate", () => render());
window.addEventListener("storage", (event) => {
  if (event.key === "zentra-cart-v2") {
    toast(
      "Sepetin başka bir sekmede değişti. Güncel bilgileri almak için sayfayı yenile.",
      "info",
    );
  }
});
document
  .querySelectorAll("[data-icon]")
  .forEach((n) => (n.innerHTML = icon(n.dataset.icon)));
$("#copyright-year").textContent = new Date().getFullYear();
measureHeader(document, window);
header();
let priorUid = "",
  priorAuthKey = "";
subscribeStoreAuth((snapshot) => {
  state.auth = snapshot;
  const next = snapshot.user?.uid || "";
  if (priorUid !== next) {
    ++state.render;
    clearCustomerSessionView(state, document);
    if (
      ["account", "orders", "coupons", "notifications", "cart"].includes(
        route().name,
      )
    )
      main.replaceChildren();
    priorUid = next;
  }
  header();
  const key = JSON.stringify([
    next,
    snapshot.ready,
    snapshot.busy,
    snapshot.account?.username,
    snapshot.account?.balanceKurus,
    snapshot.account?.firstName,
    snapshot.account?.lastName,
    snapshot.account?.avatarId,
    snapshot.user?.emailVerified,
    snapshot.user?.email,
  ]);
  const changed = key !== priorAuthKey;
  priorAuthKey = key;
  if (
    changed &&
    !snapshot.busy &&
    ["account", "orders", "coupons", "notifications", "cart"].includes(
      route().name,
    )
  )
    void render();
});
void loadCatalog();
void initStoreAuth().catch((error) => {
  state.auth = { ...state.auth, ready: true };
  toast(message(error), "error");
  render();
});
