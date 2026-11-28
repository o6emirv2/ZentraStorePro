"use strict";
const crypto = require("node:crypto");
const { initFirebaseAdmin } = require("../config/firebaseAdmin");
const { failure } = require("../email/config");
const emailLabels = Object.freeze({
  queued: "Kuyrukta",
  processing: "Gönderiliyor",
  sending: "Gönderiliyor",
  retry: "Yeniden deneme bekliyor",
  verifying: "Sağlayıcı teyidi bekleniyor",
  uncertain: "Sonucu belirsiz",
  accepted: "Sağlayıcı kabul etti",
  delivered: "Teslim edildi",
  delayed: "Teslimat gecikti",
  failed: "Gönderim reddedildi",
  rejected: "Gönderim reddedildi",
  bounced: "Adres teslimatı reddetti",
  complained: "Şikâyet bildirildi",
  suppressed: "Gönderim engellendi",
  skipped: "Gönderilmedi",
  expired: "Talebin süresi doldu",
  needs_review: "Kontrol gerekiyor",
});
const types = Object.freeze({
  new_device: "Yeni cihazdan giriş", promo_added: "Promosyon kodu", restock: "Stok gelince bildir",
  password: "Şifre yenileme",
  username: "Kullanıcı adı hatırlatma",
  password_changed: "Şifre güvenliği",
  username_changed: "Kullanıcı adı güvenliği",
  wallet_credit: "Bakiye bildirimi",
  coupon_assigned: "Kupon bildirimi",
  paid_delivered: "Sipariş ve teslimat",
  order_created: "Sipariş",
  stock: "Stok bildirimi",
  price: "Fiyat bildirimi",
  license: "Lisans bildirimi",
  gift_received: "Hediye",
  wallet: "Bakiye",
  coupon: "Kupon",
});
function database() {
  const { db } = initFirebaseAdmin();
  if (!db) throw failure("STORE_STORAGE_UNAVAILABLE", 503);
  return db;
}
const text = (value, max = 240) =>
  typeof value === "string" ? value.slice(0, max) : "";
function target(row, kind) {
  const { EVENTS, destination } = require("./notificationEvents");
  if (Object.hasOwn(EVENTS,kind)) return destination(kind,row);
  if (row.walletRequestId) return "/hesabim?bolum=wallet";
  if (row.ticketId) return "/destek?ticket=" + encodeURIComponent(text(row.ticketId,160));
  if (row.orderId)
    return "/siparisler?order=" + encodeURIComponent(text(row.orderId, 160));
  if (row.productId)
    return (
      "/urun/" +
      encodeURIComponent(text(row.productId, 80)) +
      (row.planKey ? "?paket=" + encodeURIComponent(text(row.planKey, 40)) : "")
    );
  if (row.type === "promo_added") return "/promosyonlar";
  return row.type === "security" || row.type === "new_device" || row.type === "account"
    ? "/hesabim?bolum=sessions"
    : row.type === "coupon"
      ? "/kuponlar"
      : "/hesabim";
}
const paging = require("./notificationPaging");
const { EVENTS } = require("./notificationEvents");
const preferenceKeys = {
  stock: "stockNotifications", price: "priceNotifications", coupon: "couponNotifications",
  promo: "promoNotifications", order: "orderNotifications", wallet: "walletNotifications",
  support: "supportNotifications", campaign: "campaignNotifications", license: "licenseReminders",
};
function templateKind(row) {
  return row.templateType || ({wallet: "wallet_credit", coupon: "coupon_assigned",
    account: "username_changed", security: "password_changed", commerce: row.planKey ? "price" : "stock"})[row.type] || row.type;
}
function visible(row, prefs) {
  const key = preferenceKeys[EVENTS[templateKind(row)]?.category || row.type];
  return !row.inboxDeleted && (row.templateType === "system_announcement" && row.audience === "verified" || !key || prefs[key] !== false);
}
const isRead = row => Number(row.readAt) > 0 || row.read === true;
function scopes(db, uid) {
  return { event: db.collection("storeNotifications").where("uid", "==", uid),
    legacy: db.collection("storeUserNotifications").doc(uid).collection("items") };
}

// Both generations of inbox records are counted from the same Firestore snapshot.
async function summary(uid) {
  const db = database();
  return db.runTransaction(async tx => {
    const prefs = (await tx.get(db.collection("storeCommerceProfiles").doc(uid))).data()?.preferences || {};
    const restricted = Object.values(preferenceKeys).some(key => prefs[key] === false);
    const totals = await Promise.all(Object.values(scopes(db, uid)).map(async scope => {
      const count = async q => (await tx.get(q.count())).data().count;
      const dated = scope.where("readAt", ">", 0);
      const flagged = scope.where("read", "==", true);
      const total = await count(scope);
      if (!total) return 0;
      const [stamps, flags] = await Promise.all([count(dated), count(flagged)]);
      const both = stamps && flags ? await count(dated.where("read", "==", true)) : 0;
      const unread = total - stamps - flags + both;
      if (!restricted || !unread) return unread;

      // Current and legacy writers use different fields. Only fetch unread candidates.
      const seen = new Set();
      let allowed = 0;
      const tally = doc => {
        if (seen.has(doc.id) || isRead(doc.data())) return;
        seen.add(doc.id);
        if (visible(doc.data(), prefs)) allowed++;
      };
      const fields = ["type", "templateType", "audience", "planKey", "readAt", "read", "inboxDeleted"];
      const id = initFirebaseAdmin().admin.firestore.FieldPath.documentId();
      async function visit(query) {
        const first = query.orderBy(id).select(...fields).limit(300);
        let page = first;
        while (seen.size < unread) {
          const snap = await tx.get(page);
          for (const doc of snap.docs) tally(doc);
          if (snap.size < 300) break;
          page = first.startAfter(snap.docs.at(-1).id);
        }
      }
      await visit(scope.where("readAt", "==", 0));
      await visit(scope.where("read", "==", false));
      // Imported records can lack both flags. Only visit the fallback if some are unaccounted for.
      if (seen.size < unread) await visit(scope);
      return allowed;
    }));
    return { unread: totals.reduce((sum, value) => sum + value, 0) };
  }, {readOnly: true});
}
const pendingLists=new Map();
function list(uid, requested=30, requestedCursor="", {inboxOnly=false}={}) {
  const key=JSON.stringify([uid,requested,requestedCursor,inboxOnly]);
  if(pendingLists.has(key)) return pendingLists.get(key);
  const result=readList(uid,requested,requestedCursor,{inboxOnly});
  if(pendingLists.size>=128)return result;
  pendingLists.set(key,result);
  const clear=()=>{if(pendingLists.get(key)===result)pendingLists.delete(key);};
  result.then(clear,clear);
  return result;
}
async function readList(uid, requested = 30, requestedCursor = "", { inboxOnly = false } = {}) {
  const db = database(),
    limit = Math.max(1, Math.min(50, Math.trunc(Number(requested) || 30)));
  const cursor=paging.decode(uid,requestedCursor),admin=initFirebaseAdmin().admin;
  const [legacy, current, emails, recovery] = await Promise.all([
    paging.query(db.collection("storeUserNotifications").doc(uid).collection("items"),"legacy",limit,cursor,admin),
    paging.query(db.collection("storeNotifications").where("uid","==",uid),"event",limit,cursor,admin),
    inboxOnly ? { docs: [] } : db
      .collection("storeEmailOutbox")
      .where("uid", "==", uid)
      .orderBy("createdAt", "desc")
      .limit(20)
      .get(),
    inboxOnly ? { docs: [] } : db
      .collection("storeAccountRecoveryRequests")
      .where("uid", "==", uid)
      .orderBy("createdAt", "desc")
      .limit(10)
      .get(),
  ]);
  const rawRows = [
    ...legacy.docs.map((d) => ({ d, source: "legacy" })),
    ...current.docs.map((d) => ({ d, source: "event" })),
  ].sort(paging.order);
  const candidates=rawRows.slice(0,limit);
  const needsPrefs=candidates.some(({d})=>{const row=d.data();return !!preferenceKeys[EVENTS[templateKind(row)]?.category || row.type];});
  const [{templates},profile]=await Promise.all([
    candidates.length ? require("../email/editor").read(db) : {templates:{}},
    needsPrefs ? db.collection("storeCommerceProfiles").doc(uid).get() : null
  ]);
  const preferences=profile?.data()?.preferences || {};
  const nextCursor=rawRows.length>limit ? paging.encode(uid,candidates.at(-1)) : "";
  const notifications=candidates.filter(({d}) => visible(d.data(), preferences))
    .map(({ d, source }) => {
      const r = d.data();
      const kind = templateKind(r);
      const defaults = require("./notificationEvents").EVENTS[kind] && require("./notificationPresentation").presentation(kind);
      const custom = kind === "system_announcement" || !defaults;
      const copy = require("../email/editor").apply(templates[kind], {subject: custom ? text(r.title,120) : defaults.subject, intro:custom ? text(r.message,1000) : defaults.intro, label:defaults?.label || "Ayrıntıları Gör"}, {tarih:new Date(Number(r.createdAt)||0).toLocaleString("tr-TR",{timeZone:"Europe/Istanbul"}), urun:r.productName, kod:r.code, cihaz:r.label, kullanici:r.username, tutar:Number.isSafeInteger(r.amountKurus) ? (r.amountKurus/100).toLocaleString("tr-TR",{style:"currency",currency:"TRY"}) : undefined});
      return {
        id: source + "_" + d.id,
        type: text(r.type, 30),
        category: require("./notificationEvents").EVENTS[kind]?.category || text(r.type,30),
        title: copy.subject,
        message: copy.intro,
        actionLabel:copy.label,
        createdAt: Number(r.createdAt) || 0,
        readAt:
          Number(r.readAt) || (r.read === true ? Number(r.createdAt) || 1 : 0),
        href: target(r,kind),
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
  if (inboxOnly) return {notifications, nextCursor, limit};
  const emailDelivery = [...emails.docs, ...recovery.docs]
    .map((d) => {
      const r = d.data(),
        state = Object.hasOwn(emailLabels, r.state) ? r.state : "uncertain";
      return {
        id: d.id,
        label: types[r.type || r.kind] || "Hesap bildirimi",
        state,
        stateLabel: emailLabels[state],
        createdAt: r.createdAt || 0,
        acceptedAt: r.acceptedAt || 0,
        deliveredAt: r.deliveredAt || 0,
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 20);
  return {
    notifications,
    nextCursor,
    emailDelivery,
    webhookConfigured:
      require("../email/config").configuration().webhookConfigured,
    limit,
  };
}
async function markRead(uid, id) {
  if (
    typeof id !== "string" ||
    !/^(?:legacy|event)_[A-Za-z0-9_-]{1,160}$/.test(id)
  )
    throw failure("STORE_NOTIFICATION_ID_REQUIRED", 400);
  const db = database(),
    legacy = id.startsWith("legacy_"),
    raw = id.slice(legacy ? 7 : 6);
  const ref = legacy
    ? db
        .collection("storeUserNotifications")
        .doc(uid)
        .collection("items")
        .doc(raw)
    : db.collection("storeNotifications").doc(raw);
  await db.runTransaction(async (tx) => {
    const r = (await tx.get(ref)).data();
    if (!r || r.inboxDeleted || (!legacy && r.uid !== uid))
      throw failure("STORE_NOTIFICATION_NOT_FOUND", 404);
    if (!isRead(r)) tx.update(ref, { readAt: Date.now(), read: true });
  });
  return { read: true };
}
function recordEvent(
  tx,
  db,
  { uid, key, type, title, message, templateType, username, amountKurus, transactionId, code, now = Date.now() },
) {
  if (
    !uid ||
    !key ||
    !["wallet", "coupon", "security", "account"].includes(type)
  )
    throw failure("STORE_NOTIFICATION_EVENT_INVALID");
  const id = crypto
    .createHash("sha256")
    .update([uid, type, key].join("\0"))
    .digest("hex");
  tx.create(db.collection("storeNotifications").doc(id), {
    id,
    uid,
    type,
    title,
    message,
    ...(templateType ? {templateType} : {}),
    ...(transactionId ? {transactionId} : {}),
    ...(username ? {username} : {}),
    ...(Number.isSafeInteger(amountKurus) ? {amountKurus} : {}),
    ...(code ? {code} : {}),
    createdAt: now,
    readAt: 0,
  });
}
async function deletionPreview(uid) {
  const db=database(), at=Date.now(), id=initFirebaseAdmin().admin.firestore.FieldPath.documentId();
  const count=await db.runTransaction(async tx=>{
    let total=0;
    for (const scope of Object.values(scopes(db,uid))) {
      const base=scope.orderBy("createdAt","desc").orderBy(id,"desc").select("createdAt","read","readAt","inboxDeleted").limit(300);
      let query=base;
      for (;;) {
        const page=await tx.get(query);
        for(const d of page.docs) {
          const r=d.data();
          if(!r.inboxDeleted && isRead(r) && !(d.createTime?.toMillis()>at) && !(r.readAt>at)) total++;
        }
        if(page.size<300) break;
        const last=page.docs.at(-1); query=base.startAfter(last.data().createdAt,last.id);
      }
    }
    return total;
  },{readOnly:true});
  return {count,snapshot:paging.snapshot(uid,"delete",at)};
}
async function bulkPage(uid, cursorValue, remove = false, token = "") {
  const db = database(), admin = initFirebaseAdmin().admin;
  const sources = scopes(db, uid), cursor = paging.decode(uid, cursorValue);
  const mode=remove?"delete":"read";
  if(cursor?.mode && cursor.mode!==mode) throw failure("STORE_NOTIFICATION_CURSOR_INVALID");
  const at=cursor?.at ?? paging.snapshotTime(uid,mode,token);
  const limit = 300;
  return db.runTransaction(async tx => {
    const results = await Promise.all(Object.entries(sources).map(async ([source, scope]) => {
      const query = paging.buildQuery(scope, source, limit, cursor, admin);
      const snap = await tx.get(query);
      return snap.docs.map(d => ({ d, source }));
    }));
    const merged = results.flat().sort(paging.order), page = merged.slice(0, limit);
    let changed = 0;
    const now = Date.now();
    for (const {d, source} of page) {
      const row = d.data();
      if (row.inboxDeleted || d.createTime?.toMillis()>at || isRead(row) !== remove || (remove && row.readAt>at)) continue;
      if (!remove) tx.update(d.ref, {readAt: now, read: true});
      else if (source === "legacy") tx.delete(d.ref);
      else {
        // Retain the event ID for delivery deduplication. Removing createdAt removes it from the inbox query.
        tx.set(d.ref, {uid, inboxDeleted: true, read: true, readAt: Number(row.readAt) || now,...(row.campaignId?{campaignId:row.campaignId,publishedAt:row.createdAt}:{})});
      }
      changed++;
    }
    const nextCursor = merged.length > limit ? paging.encode(uid, page.at(-1),{mode,at}) : "";
    return {changed, complete: !nextCursor, nextCursor};
  });
}
const markAllRead = (uid, cursor = "") => bulkPage(uid, cursor);
const deleteRead = (uid, cursor = "", snapshot = "") => bulkPage(uid, cursor, true, snapshot);
module.exports = { list, summary, markRead, markAllRead, deleteRead, deletionPreview, recordEvent };
