"use strict";
const crypto = require("node:crypto");
const C = require("../commerce/common");
const K = require("./config");
const { initFirebaseAdmin } = require("../config/firebaseAdmin");
const { field, audit } = require("../core/memberControl");
const { stateLabel } = require("../../public/js/store/account-states.mjs");
const { storeEntryUrl } = require("../../public/js/app/routes.mjs");
const templates = {
  review_started: [
    "Hesabınız İnceleme Altına Alındı",
    "Hesabınızla ilgili bir inceleme başlattık. İnceleme sürerken sipariş geçmişinize ve destek taleplerinize erişebilirsiniz.",
    "İnceleme sonucunu hesabınızda kayıtlı e-posta adresinize bildireceğiz.",
    "under_review",
  ],
  review_passed: [
    "Hesabınız İncelemeden Başarıyla Geçti",
    "Hesabınızın incelemesini tamamladık. Kayıtlarınız, hesabınızı yeniden kullanmanız için uygun bulundu.",
    "Hesabınıza giriş yaparak güncel işlem yetkilerinizi görebilirsiniz.",
    "active",
    "under_review",
  ],
  restricted: [
    "Hesabınız Kısıtlandı",
    "Hesabınız hakkında gerçekleştirilen değerlendirme sonucunda belirli kullanım kısıtlamaları uygulanmıştır. Geçmiş kayıtlarınıza ve destek bölümüne erişebilirsiniz.",
    "Kararın yeniden değerlendirilmesini isterseniz işlem referansıyla destek talebi açabilirsiniz.",
    "restricted",
  ],
  restriction_lifted: [
    "Hesabınızın Kısıtlaması Kaldırıldı",
    "Hesabınız için uygulanan kullanım kısıtlamasını kaldırdık.",
    "Hesabınıza giriş yaparak işlemlerinize devam edebilirsiniz.",
    "active",
    "restricted",
  ],
  shopping_blocked: [
    "Hesabınıza Alışveriş Engeli Uygulandı",
    "Hesabınızda yeni sipariş oluşturma ve ödeme başlatma işlemleri durdurulmuştur. Mevcut siparişlerinizin geçmişine erişiminiz sürmektedir.",
    "Siparişlerinizle ilgili sorularınızı destek merkezinden iletebilirsiniz.",
    "purchase_blocked",
  ],
  shopping_restored: [
    "Hesabınızın Alışveriş Engeli Kaldırıldı",
    "Hesabınıza uygulanmış alışveriş engeli kaldırılmıştır.",
    "Mağazaya giriş yaparak güncel paketleri inceleyebilirsiniz.",
    "active",
    "purchase_blocked",
  ],
  closed: [
    "Hesabınız Kapatıldı",
    "Hesabınız kapatılmış ve açık oturumlarınız sonlandırılmıştır.",
    "Kararla ilgili bilgi almak için aşağıdaki referansla resmî destek kanalına başvurabilirsiniz.",
    "closed",
  ],
  reopened: [
    "Hesabınız Yeniden Kullanıma Açıldı",
    "Hesabınız hakkında gerçekleştirilen değerlendirme tamamlandı. Hesabınız yeniden kullanıma açıldı.",
    "Hizmetlerimize erişmek için yeniden giriş yapın.",
    "active",
    "closed",
  ],
  suspicious: [
    "Hesabınızda Şüpheli İşlem Tespit Edildi",
    "Hesabınızla ilişkilendirilen bir işlemin tarafınızdan kontrol edilmesi gerekiyor.",
    "Son oturumlarınızı inceleyin. İşlemi tanımıyorsanız resmî destek kanalından bize ulaşın.",
  ],
  suspended: [
    "Hesabınız Geçici Olarak Askıya Alındı",
    "Hesabınız geçici olarak askıya alınmış ve aktif oturumlarınız sonlandırılmıştır.",
    "İnceleme veya ek bilgi talebinizi işlem referansıyla destek birimine iletin.",
    "suspended",
  ],
  verification_needed: [
    "Hesabınız İçin Ek Güvenlik Doğrulaması Gerekiyor",
    "Hesabınız için ek güvenlik doğrulaması gerekiyor. Güvenlik kilidi bu süreç tamamlanana kadar yürürlükte kalacaktır.",
    "Resmî destek kanalına işlem referansını iletin. Parolanızı veya tek kullanımlık kodlarınızı paylaşmayın.",
    "security_locked",
  ],
  verification_passed: [
    "Hesabınızın Güvenlik Doğrulaması Başarıyla Tamamlandı",
    "Ek güvenlik doğrulamanız tamamlandı ve hesabınızdaki güvenlik kilidi kaldırıldı.",
    "Hesabınıza yeniden giriş yapın ve tanımadığınız cihazları kontrol edin.",
    "active",
    "security_locked",
  ],
  information: [
    "Hesabınız Hakkında Önemli Bilgilendirme",
    "Hesabınızla ilgili güncel bilgiyi aşağıda bulabilirsiniz.",
    "Herhangi bir sorunuz varsa işlem referansıyla destek merkezine ulaşabilirsiniz.",
  ],
};
const list = () =>
  Object.entries(templates).map(([id, t]) => ({ id, title: t[0] }));
const verifiedAddress = (u) =>
  u?.emailVerified === true && K.validEmail(u.email);
async function identity(uid) {
  const { auth } = initFirebaseAdmin();
  const u = await auth.getUser(C.uid(uid));
  if (!verifiedAddress(u)) C.fail("MEMBER_NOTICE_ADDRESS_UNVERIFIED", 409);
  return u;
}
async function loadContext(db, uid, template, read = (ref) => ref.get()) {
  if (!Object.hasOwn(templates, template))
    C.fail("MEMBER_NOTICE_TEMPLATE_INVALID", 400);
  const row = (await read(db.collection("users").doc(uid))).data() || {},
    status = row.storeAccountStatus || "active",
    t = templates[template];
  if (
    row.storeModerationIntent ||
    row.storeDeletionId ||
    (t[3] && t[3] !== status)
  )
    C.fail("MEMBER_NOTICE_STATUS_MISMATCH", 409);
  if (t[4]) {
    if (!row.lastModerationId)
      C.fail("MEMBER_NOTICE_TRANSITION_UNVERIFIED", 409);
    const last = (
      await read(
        db
          .collection("storeMemberStatusHistory")
          .doc(row.storeLastStatusChangeId || row.lastModerationId),
      )
    ).data();
    if (last?.uid !== uid || last.before !== t[4] || last.after !== status)
      C.fail("MEMBER_NOTICE_TRANSITION_UNVERIFIED", 409);
  }
  return {
    status,
    version: row.storeModerationRevision || 0,
    username: row.username || row.storeProfile?.username || "",
  };
}
const escape = (v) =>
  String(v ?? "").replace(
    /[<>&"']/g,
    (c) =>
      ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
function render(data, to) {
  const [title, intro, action] = templates[data.template],
    cfg = K.configuration();
  const subject = "ZENTRA STORE | " + title,
    hello = data.username ? "Sayın " + data.username + "," : "Sayın üyemiz,";
  const time = new Intl.DateTimeFormat("tr-TR", {
    timeZone: "Europe/Istanbul",
    dateStyle: "long",
    timeStyle: "short",
  }).format(data.at);
  const support = storeEntryUrl(cfg.origin, "/destek"),
    logo = new URL("/public/assets/images/apple-touch-icon.png", cfg.origin)
      .href;
  const fields = [
    ["Hesap durumu", stateLabel(data.status)],
    ["İşlem tarihi", time + " · Türkiye saati"],
    ["İşlem referansı", data.reference],
    ...(data.reason ? [["Açıklama", data.reason]] : []),
  ];
  const footer = "ZENTRA STORE · Hesap Yönetimi ve Güvenlik Birimi";
  const text = [
    subject,
    hello,
    intro,
    ...fields.map(([k, v]) => k + ": " + v),
    action,
    "Resmî destek: " + support,
    footer,
    "Bu bilgilendirme hesabınızla ilgili bir işlem üzerine otomatik gönderilmiştir.",
  ].join("\n\n");
  const html =
    '<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#edf2f8;color:#16253a;font:16px Arial,sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:18px 10px"><table role="presentation" width="100%" style="max-width:600px;background:white;border:1px solid #ced9e7" cellspacing="0" cellpadding="0"><tr><td style="background:#101c35;color:white;padding:22px"><img width="42" height="42" src="' +
    escape(logo) +
    '" alt="" style="vertical-align:middle"> &nbsp; <b>ZENTRA STORE</b></td></tr><tr><td style="padding:24px;line-height:1.6"><h1 style="font-size:23px">' +
    escape(title) +
    "</h1><p>" +
    escape(hello) +
    "</p><p>" +
    escape(intro) +
    '</p><table role="presentation" width="100%" cellpadding="8" style="background:#edf2f8;font-size:14px">' +
    fields
      .map(
        ([k, v]) =>
          '<tr><td valign="top"><b>' +
          escape(k) +
          '</b></td><td style="overflow-wrap:anywhere">' +
          escape(v) +
          "</td></tr>",
      )
      .join("") +
    "</table><p>" +
    escape(action) +
    '</p><p><a style="color:#234d94" href="' +
    escape(support) +
    '">Resmî destek merkezine ulaşın</a></p><p>' +
    escape(footer) +
    '</p></td></tr><tr><td style="padding:16px 24px;background:#eff3f8;font-size:12px">Bu bilgilendirme hesabınızla ilgili bir işlem üzerine otomatik gönderilmiştir.</td></tr></table></td></tr></table></body></html>';
  return {
    to: [to],
    from: cfg.from,
    subject,
    html,
    text,
    ...(cfg.replyTo ? { reply_to: cfg.replyTo } : {}),
  };
}
async function preview(uid, input, actor) {
  C.object(input, ["template", "reason"]);
  const db = C.db(),
    user = await identity(uid),
    context = await loadContext(db, uid, input.template);
  const now = Date.now(),
    reference = crypto.randomUUID(),
    reason = field(input.reason || "", 500);
  if (
    [
      "restricted",
      "closed",
      "shopping_blocked",
      "suspended",
      "suspicious",
      "information",
    ].includes(input.template) &&
    reason.length < 5
  )
    C.fail("MEMBER_REASON_REQUIRED", 400);
  const data = {
    ...context,
    template: input.template,
    reason,
    reference,
    at: now,
  };
  await db
    .collection("storeMemberNoticePreviews")
    .doc(reference)
    .set({
      uid,
      actor: actor.uid,
      data,
      addressHash: K.addressHash(user.email),
      expiresAt: now + 300000,
      purgeAfter: new Date(now + 86400000),
    });
  const { html, text, subject } = render(data, user.email);
  return { id: reference, recipient: user.email, html, text, subject };
}
async function send(uid, id, actor) {
  const user = await identity(uid),
    db = C.db(),
    preview = db.collection("storeMemberNoticePreviews").doc(C.id(id));
  const result = await db.runTransaction(async (tx) => {
    const p = (await tx.get(preview)).data();
    if (!p || p.uid !== uid || p.actor !== actor.uid)
      C.fail("MEMBER_NOTICE_PREVIEW_INVALID", 404);
    if (p.outboxId) return { id: p.outboxId, reference: id };
    if (p.expiresAt < Date.now() || p.addressHash !== K.addressHash(user.email))
      C.fail("MEMBER_NOTICE_PREVIEW_EXPIRED", 409);
    const live = await loadContext(db, uid, p.data.template, (ref) =>
      tx.get(ref),
    );
    if (live.version !== p.data.version || live.username !== p.data.username)
      C.fail("MEMBER_NOTICE_PREVIEW_CHANGED", 409);
    const key = require("./service").enqueue(tx, db, {
      uid,
      type: "member_notice",
      key: id,
      data: { ...p.data, addressHash: p.addressHash },
    });
    tx.update(preview, { outboxId: key });
    audit(tx, db, "store.user.notice.queued", actor, uid, {
      reference: id,
      template: p.data.template,
      outboxId: key,
    });
    return { id: key, reference: id };
  });
  require("./service").wake();
  return result;
}
async function stillValid(db, row, read = (ref) => ref.get()) {
  try {
    const s = await loadContext(db, row.uid, row.data.template, read);
    return s.status === row.data.status || !templates[row.data.template][3];
  } catch (e) {
    if (
      [
        "MEMBER_NOTICE_STATUS_MISMATCH",
        "MEMBER_NOTICE_TRANSITION_UNVERIFIED",
      ].includes(e.code)
    )
      return false;
    throw e;
  }
}
module.exports = { list, render, preview, send, stillValid };
