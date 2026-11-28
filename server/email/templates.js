"use strict";
const { configuration, unsubscribeToken, OPTIONAL } = require("./config");
const { storeEntryUrl } = require("../../public/js/app/routes.mjs");
function escape(value = "") {
  return String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
const money = (value) =>
  (value / 100).toLocaleString("tr-TR", { style: "currency", currency: "TRY" });
const date = (value) =>
  new Date(value).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" });
const TYPES = Object.freeze({
  ...Object.fromEntries(Object.entries(require("../core/notificationEvents").EVENTS).map(([key,value]) => [key,value.category])),
  stock: "stock",
  restock: "restock",
  promo_added: "promo",
  new_device: "security",
  price: "price",
  license: "license",
  coupon_assigned: "coupon",
  order_created: "order",
  paid_delivered: "order",
  gift_received: "order",
  wallet_credit: "wallet",
  username_changed: "security",
  password_changed: "security",
  test: "test",
});
function render(job, facts, recipient, template = {}) {
  const config = configuration();
  const data = job.data || {};
  const { presentation } = require('../core/notificationPresentation');
  const type = job.type === 'password_changed' && facts.reset ? 'password_reset_completed' : job.type;
  let { subject, intro, label } = presentation(type);
  if (type === 'review_invitation' && facts.product?.name) {
    subject = facts.product.name + ' hakkındaki görüşünüzü merak ediyoruz';
    intro = facts.product.name + ' ürününü satın alan bir müşteri deneyimini paylaştı. Sizin deneyiminiz nasıldı? Üründe beğendiğiniz veya geliştirilmesini istediğiniz bir noktayı yazarak diğer alıcılara yardımcı olabilirsiniz.';
  }
  if (type === 'system_announcement') {
    subject = data.title || subject;
    intro = data.message || intro;
  }
  const path = require('../core/notificationEvents').destination(type, {
    ...data, productId: facts.product?.id || data.productId, planKey: data.planKey || (type === 'price' ? facts.plan?.key : undefined)
  });
  const rows = [];
  const add = (title, value) => { if (value !== undefined && value !== null && value !== '') rows.push([title, value]); };
  add('İşlem zamanı', date(job.createdAt));
  add('Ürün', facts.product?.name);
  add('Paket', facts.plan?.label || facts.plan?.key);
  if (Number.isSafeInteger(facts.plan?.priceKurus)) add('Güncel fiyat', money(facts.plan.priceKurus));
  if (facts.oldPriceKurus > facts.plan?.priceKurus) add('Önceki fiyat', money(facts.oldPriceKurus));
  if (facts.coupon) {
    const c = facts.coupon;
    add('Kod', c.code);
    add(type === 'promo_added' ? 'Bakiye ödülü' : 'İndirim', c.type === 'percent' ? '%' + c.value : money(c.value));
    if (c.minimumSubtotalKurus) add('Minimum sepet', money(c.minimumSubtotalKurus));
    if (c.endsAt) add('Son kullanım', date(c.endsAt));
  }
  if (type === 'username_changed') { add('Önceki kullanıcı adı', data.previous); add('Yeni kullanıcı adı', data.current); }
  if (type === 'new_device' || type === 'suspicious_login') add('Cihaz', data.label);
  if (facts.expiresAt) add('Lisans bitişi', date(facts.expiresAt));
  if (facts.order) {
    add('Sipariş', facts.order.orderNumber);
    if (Number.isSafeInteger(facts.order.totalKurus) && type !== 'gift_received') add('Sipariş tutarı', money(facts.order.totalKurus));
    add('Durum', facts.statusLabel);
    if (facts.order.delivery?.deliveredAt) add('Teslimat zamanı', date(facts.order.delivery.deliveredAt));
  }
  if (Number.isSafeInteger(facts.amountKurus)) add('İşlem tutarı', money(facts.amountKurus));
  if (Number.isSafeInteger(facts.balanceAfterKurus)) add('İşlem sonrası bakiye', money(facts.balanceAfterKurus));
  if (facts.order?.items?.length)
    rows.push([
      "Ürünler",
      facts.order.items
        .map(
          (x) =>
            `${x.name || x.productName || x.productId} · ${x.planLabel || x.planKey} × ${x.quantity}`,
        )
        .join(" / ")
        .slice(0, 1200),
    ]);
  ({ subject, intro, label } = require("./editor").apply(template, { subject, intro, label }, {
    tarih: date(job.createdAt), saat:new Date(job.createdAt).toLocaleTimeString("tr-TR",{timeZone:"Europe/Istanbul"}), siparis_no:facts.order?.orderNumber, indirim_orani:job.data?.discountPercent, urun: facts.product?.name, kod: facts.coupon?.code,
    kullanici: facts.username || job.data?.current || recipient.split("@")[0], cihaz: job.data?.label,
    tutar: Number.isSafeInteger(facts.amountKurus) ? money(facts.amountKurus) : undefined
  }));
  // A manual broadcast must retain the exact message the administrator confirmed in the preview.
  if (type === "system_announcement" && ["verified", "subscribed"].includes(data.audience)) {
    subject = data.title;
    intro = data.message;
  }
  const href = storeEntryUrl(config.origin, path);
  const logo = new URL("/public/assets/images/logo.png", config.origin).href;
  const token = OPTIONAL[job.category]
    ? unsubscribeToken(job.uid, job.category)
    : "";
  const unsubscribe = token
    ? new URL(
        "/email/unsubscribe?token=" + encodeURIComponent(token),
        config.backend,
      ).href
    : "";
  const footer = unsubscribe
    ? `<p style="font-size:12px;color:#4b5563"><a href="${escape(unsubscribe)}" style="color:#263e9c">Bu tür e-postaları kapat</a></p>`
    : '<p style="font-size:12px;color:#4b5563">Bu ileti hesabınızla ilişkili bir işlem hakkında gönderilmiştir.</p>';
  const html = `<!doctype html><html lang="tr"><head><meta name="viewport" content="width=device-width, initial-scale=0.85, minimum-scale=0.85, maximum-scale=0.85, viewport-fit=cover" /><meta charset="utf-8"><title>${escape(subject)}</title></head><body style="margin:0;background:#f4f6fb;color:#14213b;font-family:Arial,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:20px"><tr><td style="padding:28px"><img src="${escape(logo)}" alt="ZENTRA STORE" width="64" height="64" style="display:block;border-radius:14px"><p style="font-size:13px;font-weight:bold;letter-spacing:2px;color:#334ca5">ZENTRA STORE</p><h1 style="font-size:26px;line-height:1.25;margin:20px 0">${escape(subject)}</h1><p style="font-size:16px;line-height:1.7">${escape(intro).replaceAll("\n","<br>")}</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows.map(([key, value]) => `<tr><td style="padding:12px 0;border-bottom:1px solid #e6eaf2;font-size:14px;vertical-align:top;width:38%">${escape(key)}</td><td style="padding:12px 0 12px 12px;border-bottom:1px solid #e6eaf2;font-size:14px;overflow-wrap:anywhere">${escape(value)}</td></tr>`).join("")}</table><p style="margin:28px 0"><a href="${escape(href)}" style="display:inline-block;background:#263e9c;color:#fff;padding:16px 22px;border-radius:12px;text-decoration:none;font-weight:bold">${escape(label)}</a></p><p style="font-size:12px;line-height:1.6;color:#4b5563">İşlem anındaki bilgileri içerir. Güncel durum ve kullanım koşulları hesabınızda gösterilir.</p><p style="font-size:13px"><a href="${escape(storeEntryUrl(config.origin,"/destek"))}" style="color:#205a9c">Destek merkezine ulaşın</a></p>${footer}</td></tr></table></td></tr></table></body></html>`;
  const text = [
    "ZENTRA STORE",
    subject,
    intro,
    ...rows.map(([k, v]) => `${k}: ${v}`),
    `${label}: ${href}`,
    unsubscribe
      ? `Bu tür e-postaları kapat: ${unsubscribe}`
      : "Bu ileti hesabınızla ilişkili bir işlem hakkındadır.",
  ].join("\n\n");
  return {
    from: config.from,
    to: [recipient],
    subject,
    html,
    text,
    ...(config.replyTo ? { reply_to: config.replyTo } : {}),
    ...(unsubscribe
      ? {
          headers: {
            "List-Unsubscribe": `<${unsubscribe}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
        }
      : {}),
    tags: [{ name: "zentra_event", value: job.id }],
  };
}
module.exports = { render, TYPES, escape };
