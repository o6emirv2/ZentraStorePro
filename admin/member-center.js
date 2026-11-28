import { escapeHtml as h } from "./admin-core.js?v=116";
import { openAdminDialog as dialog } from "./admin-dialogs.js?v=116";
import {
  accountStates,
  stateLabel,
} from "../public/js/store/account-states.mjs?v=116";

const apiBase = "/api/admin/store/members";
const cash = new Intl.NumberFormat("tr-TR", {
  style: "currency",
  currency: "TRY",
});
const clock = new Intl.DateTimeFormat("tr-TR", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "Europe/Istanbul",
});
const money = (v) =>
  Number.isSafeInteger(v) ? cash.format(v / 100) : "Kayıt bulunmuyor";
const when = (v) =>
  Number(v) > 0 ? clock.format(new Date(Number(v))) : "Kayıt bulunmuyor";
const confirmed = (v) =>
  v === true
    ? "Doğrulandı"
    : v === false
      ? "Doğrulama bekleniyor"
      : "Bilgi alınamadı";
const labels = {
  queued: "Gönderim bekliyor",
  sending: "Gönderiliyor",
  accepted: "E-posta sağlayıcısına iletildi",
  delivered: "Teslim edildi",
  retry: "Yeniden gönderim bekliyor",
  bounced: "Alıcı adresi reddetti",
  complained: "Spam bildirimi",
  failed: "Başarısız",
  skipped: "Gönderim durduruldu",
  delayed: "Teslimat gecikti",
  needs_review: "İnceleme gerekiyor",
  completed: "Tamamlandı",
  pending: "Bekliyor",
  paid: "Ödeme onaylandı",
  processing: "Hazırlanıyor",
  cancelled: "İptal edildi",
  refunded: "İade tamamlandı",
  payment_pending: "Ödeme bekliyor",
  payment_rejected: "Ödeme reddedildi",
  delivery_pending: "Teslimat bekliyor",
  verified: "Doğrulandı",
  captured: "Tahsil edildi",
  wallet: "Bakiye",
  telegram: "Telegram",
  shopier: "Shopier",
  CREDIT: "Bakiye yükleme",
  DEBIT: "Bakiye kullanımı",
  REFUND: "İade",
  CORRECTION: "Düzeltme",
  HOLD: "Bloke",
  RELEASE: "Bloke kaldırma",
};
const label = (v) => labels[v] || v || "Kayıt bulunmuyor";
function btn(action, title, cls = "secondary-action", attrs = "") {
  return (
    '<button type="button" class="' +
    cls +
    '" data-member-action="' +
    action +
    '" ' +
    attrs +
    ">" +
    h(title) +
    "</button>"
  );
}
function fact(k, v, extra = "") {
  return (
    '<div class="member-fact"><dt>' +
    h(k) +
    "</dt><dd>" +
    h(String(v ?? "Kayıt bulunmuyor")) +
    extra +
    "</dd></div>"
  );
}
function options(name, items, value) {
  return (
    '<fieldset class="status-choices member-choices"><legend>' +
    h(name) +
    "</legend>" +
    items
      .map(
        ([id, title, desc]) =>
          '<label><input type="radio" name="' +
          h(name) +
          '" value="' +
          h(id) +
          '" ' +
          (value === id ? "checked" : "") +
          " required><span><strong>" +
          h(title) +
          "</strong>" +
          (desc ? "<small>" + h(desc) + "</small>" : "") +
          "</span></label>",
      )
      .join("") +
    "</fieldset>"
  );
}
function codeField() {
  return '<label class="operation-field">Doğrulama uygulamasındaki güncel kod<input name="totp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label>';
}
const collectionNames = {
  storeMemberNoticePreviews: "E-posta önizlemeleri",
  storeRemovalConfirmations: "Silme onayları",
  storeCommerceProfiles: "Mağaza profilleri",
  storeAccountVerifications: "Hesap doğrulama kayıtları",
  storeEmailVerificationChallenges: "E-posta doğrulama talepleri",
  storeCustomerSessions: "Mağaza oturumları",
  storeCustomerAuthSessions: "Kimlik doğrulama oturumları",
  storeCustomerAuthRevocations: "Oturum iptalleri",
  storeUserNotifications: "Hesap bildirimleri",
  storeNotifications: "Site içi bildirimler",
  storeCommerceNotificationReceipts: "Bildirim alındı kayıtları",
  storeProductWatches: "Takip edilen ürünler",
  storeRestockSubscriptions: "Stok bildirim abonelikleri",
  storeEmailOutbox: "Giden e-posta kayıtları",
  storeAnalyticsEvents: "Hesap etkinlikleri",
  storeReviewParticipation: "Değerlendirme katılımı",
  storeReviewReplies: "Yorum yanıtları",
  storeReviews: "Ürün değerlendirmeleri",
  storeProductReactions: "Ürün beğenileri",
  storeProductReactionReceipts: "Beğeni işlem kayıtları",
  storeAccountRecoveryRequests: "Hesap kurtarma talepleri",
  storeAccountRecoveryTokens: "Kurtarma anahtarları",
  storeAccountRecoveryHeads: "Kurtarma durumu",
  storeAccountRecoverySendLocks: "Kurtarma gönderim kilitleri",
  storeMemberModerationIntents: "Bekleyen hesap işlemleri",
  usernameRegistry: "Kullanıcı adı kaydı",
  storeSupportAttachments: "Destek ekleri",
  storeSupportTickets: "Destek talepleri",
  storeDataRequests: "Veri talepleri",
  storeReservationOwners: "Rezervasyon sahipliği",
  storeAdminFactors: "Yönetici doğrulayıcıları",
  adminUsers: "Görevli hesap kaydı",
  storeInternalUserNotes: "Dahili yönetici notları",
  storeCustomerSessionRevocations: "Oturum iptal kayıtları",
  users: "Kullanıcı profili",
  storeOrders: "Siparişler",
  storeOrderArchives: "Sipariş arşivi",
  storeWalletLedger: "Bakiye hareketleri",
  storeWalletAdjustments: "Bakiye düzeltmeleri",
  storeWalletRequests: "Bakiye talepleri",
  storeBalanceCodeRedemptions: "Bakiye kodu işlemleri",
  storeDeliveries: "Teslimatlar",
  storeMemberStatusHistory: "Hesap durumu geçmişi",
};
const listing = {
  orders: ["Sipariş ve Teslimat", "store.orders.read"],
  ledger: ["Bakiye Hareketleri", "store.wallet.read"],
  activity: ["Denetim", "store.audit.read"],
  notices: ["E-posta geçmişi", "store.users.write"],
};
function record(kind, r) {
  let fields, title;
  if (kind === "orders") {
    title = "Sipariş " + r.number;
    fields = [
      ["Kanal", label(r.method)],
      ["Sipariş", label(r.status)],
      ["Ödeme", label(r.payment)],
      ["Teslimat", label(r.delivery)],
      ["Tutar", money(r.amount)],
      ["İade", label(r.refund)],
      ["Oluşturma", when(r.createdAt)],
      ["Tahsilat", when(r.paidAt)],
      ["Teslim", when(r.deliveredAt)],
    ];
  } else if (kind === "ledger") {
    title = label(r.type);
    fields = [
      ["Önceki bakiye", money(r.balanceBeforeKurus)],
      ["İşlem tutarı", money(r.amountKurus)],
      ["Yeni bakiye", money(r.balanceAfterKurus)],
      ["Kaynak", label(r.source)],
      ["Referans", r.transactionId],
      ["Tarih", when(r.createdAt)],
      ["Gerekçe", label(r.reason)],
    ];
  } else if (kind === "notices") {
    title = label(r.state);
    fields = [
      ["Tarih", when(r.at)],
      ["Referans", r.reference],
      ["Sağlayıcı kaydı", label(r.providerId)],
      ["Son hata", r.error || "Yok"],
    ];
  } else {
    title = label(r.action);
    fields = [
      ["Tarih", when(r.at)],
      ["İşlemi yapan", label(r.actor)],
      ["Kaynak", r.name],
      ["Sonuç", label(r.state)],
      ["Referans", r.reference],
    ];
  }
  return (
    '<article class="member-record"><h4>' +
    h(title) +
    "</h4><dl>" +
    fields.map(([k, v]) => fact(k, v)).join("") +
    "</dl></article>"
  );
}
export function createMemberCenter({ request, reauth, can, notify }) {
  let jobTimer;
  function stopJob() {
    clearTimeout(jobTimer);
    jobTimer = undefined;
  }
  let root,
    listEpoch = 0,
    detailEpoch = 0,
    historyEpoch = 0,
    selected = null,
    draft = "",
    cursor = "",
    historyKind = "",
    historyCursor = "",
    filters = {},
    rows = [];
  const $ = (sel) => root.querySelector(sel);
  const member = (uid, suffix) =>
    apiBase + "/" + encodeURIComponent(uid) + "/" + suffix;
  const call = async (path, body) =>
    (await request(path, { method: "POST", body })).result;
  function renderRows() {
    $("#userDirectory").innerHTML =
      rows
        .map(
          (u) =>
            '<button type="button" class="member-row" data-member-open="' +
            h(u.uid) +
            '"><span><strong>' +
            h(u.username || "Mağaza hesabı") +
            "</strong><small>" +
            h(u.email || "E-posta kaydı bulunmuyor") +
            '</small></span><span class="member-state">' +
            h(stateLabel(u.accountStatus)) +
            "</span></button>",
        )
        .join("") ||
      "<p>" +
        (cursor
          ? "Bu sayfada filtreye uyan hesap yok. Sonraki sayfayı inceleyebilirsiniz."
          : "Eşleşen hesap bulunamadı.") +
        "</p>";
    $("#memberMore").hidden = !cursor;
  }
  async function directory(append = false) {
    const epoch = ++listEpoch;
    const params = new URLSearchParams({
      limit: "50",
      view: "directory",
      ...filters,
      query: $("#userSearch").value.trim(),
    });
    if (append && cursor) params.set("pageToken", cursor);
    $("#memberListState").textContent = "Hesaplar yükleniyor…";
    try {
      const result = await request("/api/admin/store/users?" + params, {
        timeoutMs: 45000,
      });
      if (epoch !== listEpoch) return;
      rows = [
        ...new Map(
          [...(append ? rows : []), ...result.users].map((x) => [x.uid, x]),
        ).values(),
      ];
      cursor = result.nextPageToken || "";
      renderRows();
      $("#memberListState").textContent = rows.length + " hesap gösteriliyor.";
    } catch (e) {
      if (epoch !== listEpoch) return;
      if (!append) {
        rows = [];
        cursor = "";
        renderRows();
        $("#userDirectory").replaceChildren();
      }
      $("#memberListState").textContent =
        e.status === 404
          ? "Aranan hesap bulunamadı."
          : "Liste yüklenemedi. " + e.message;
    }
  }
  function draw() {
    const u = selected,
      fin = can("store.wallet.read"),
      write = can("store.users.write");
    draft = u.accountStatus;
    const copy = (key) =>
      btn(
        "copy",
        "Kopyala",
        "member-copy",
        'data-field="' +
          key +
          '" aria-label="' +
          (key === "email" ? "E-posta adresini" : "Hesap UID bilgisini") +
          ' kopyala"',
      );
    $("#userResult").innerHTML =
      '<article class="admin-card member-profile" data-user-card="' +
      h(u.uid) +
      '"><header><div><small>Hesap ayrıntıları</small><h2>' +
      h(u.username || "Mağaza hesabı") +
      '</h2></div><span class="member-state">' +
      h(stateLabel(u.accountStatus)) +
      '</span></header><dl class="member-facts">' +
      fact(
        "E-posta",
        u.email || "Kayıt bulunmuyor",
        u.email ? copy("email") : "",
      ) +
      fact("Hesap UDİD (Firebase UID)", u.uid, copy("uid")) +
      '<div class="member-wide">' +
      fact("E-posta doğrulama durumu", confirmed(u.emailVerified)) +
      "</div>" +
      (fin ? fact("Kullanılabilir bakiye", money(u.balanceKurus)) : "") +
      fact("Toplam sipariş", u.orderCount) +
      (fin
        ? fact("İade nedeniyle kapatılacak tutar", money(u.walletDebtKurus)) +
          fact("Toplam harcama", money(u.totalSpendKurus)) +
          fact("Toplam iade", money(u.refundedKurus))
        : "") +
      fact("Hesap oluşturma tarihi", when(u.createdAt)) +
      fact("Son giriş", when(u.lastSignInAt)) +
      fact("Son sipariş teslimatı", when(u.lastDeliveryAt)) +
      "</dl>" +
      '<div class="member-editor"><label>Hesap durumu</label>' +
      (write
        ? btn(
            "status",
            stateLabel(draft),
            "secondary-action",
            'id="memberStatus" aria-haspopup="dialog"',
          )
        : h(stateLabel(draft))) +
      (write
        ? '<label>Kullanıcı notu</label><div class="member-inline">' +
          btn("compose", "E-posta şablonu seç") +
          btn("notices", "E-posta geçmişi") +
          '</div><label for="memberNote">Yönetici notu</label><textarea id="memberNote" maxlength="1000" rows="3" placeholder="Yalnız yetkili yöneticiler görebilir">' +
          h(u.adminNote || "") +
          "</textarea>" +
          (u.noteUpdatedAt
            ? "<small>Son düzenleme " +
              h(when(u.noteUpdatedAt)) +
              " · " +
              h(u.noteUpdatedBy) +
              "</small>"
            : "") +
          btn("save", "Değişiklikleri Kaydet", "primary-action")
        : "") +
      "</div>" +
      '<div class="member-actions">' +
      ["orders", "ledger", "activity"]
        .filter((x) => can(listing[x][1]))
        .map((x) => btn(x, listing[x][0]))
        .join("") +
      (can("store.users.delete")
        ? btn("delete", "Hesabı Kalıcı Olarak Sil", "danger-action") +
          btn(
            "ban",
            "Hesabı Kalıcı Olarak Sil ve Mail Adresini Kara Listeye Al — Yeniden Kaydı Engelle",
            "danger-action member-wide",
          )
        : "") +
      '</div><section id="memberHistory" aria-live="polite"></section></article>';
  }
  async function select(uid) {
    stopJob();
    const epoch = ++detailEpoch;
    ++historyEpoch;
    selected = null;
    $("#userResult").textContent = "Hesap ayrıntıları yükleniyor…";
    try {
      const res = await request(
        "/api/admin/store/users/resolve?identifier=" + encodeURIComponent(uid),
      );
      if (epoch !== detailEpoch) return;
      selected = res.user;
      draw();
      $("#userResult").scrollIntoView({ block: "start" });
    } catch (e) {
      if (epoch === detailEpoch)
        $("#userResult").textContent = "Hesap yüklenemedi. " + e.message;
    }
  }
  async function history(uid, kind, more = false) {
    stopJob();
    const epoch = ++historyEpoch,
      token = more ? historyCursor : "";
    historyKind = kind;
    const host = $("#memberHistory");
    if (!more)
      host.innerHTML =
        "<h3>" + h(listing[kind][0]) + "</h3><div data-records></div>";
    host.querySelector('[data-member-action="history-more"]')?.remove();
    const path =
      kind === "ledger"
        ? "/api/admin/store/users/" + encodeURIComponent(uid) + "/wallet-ledger"
        : member(uid, kind);
    const res = await request(
      path + "?limit=25&cursor=" + encodeURIComponent(token),
    );
    if (epoch !== historyEpoch || selected?.uid !== uid) return;
    const data = res.result || res;
    historyCursor = data.nextCursor || "";
    const items = data.items || data.ledger || [];
    host
      .querySelector("[data-records]")
      .insertAdjacentHTML(
        "beforeend",
        items.map((r) => record(kind, r)).join("") ||
          "<p>Kayıt bulunmuyor.</p>",
      );
    if (historyCursor)
      host.insertAdjacentHTML(
        "beforeend",
        btn("history-more", "Önceki kayıtlar"),
      );
  }
  async function compose(uid) {
    const list = (await request(apiBase + "/templates")).result,
      choice = await dialog({
        title: "Kullanıcı notu",
        content:
          options(
            "Şablon",
            list.map((x) => [x.id, x.title]),
            "information",
          ) +
          '<label class="operation-field">Kullanıcıya iletilecek açıklama<textarea name="reason" maxlength="500" rows="3"></textarea></label>',
        confirmLabel: "Önizlemeyi Aç",
        collect: (f) => ({
          template: f.elements["Şablon"].value,
          reason: f.elements.reason.value.trim(),
        }),
      });
    if (!choice) return;
    const p = await call(member(uid, "notice/preview"), choice);
    if (
      !(await dialog({
        title: "E-posta önizlemesi",
        description: p.recipient,
        content:
          "<h3>" +
          h(p.subject) +
          '</h3><iframe title="E-posta içeriği" sandbox="" class="member-mail-preview" srcdoc="' +
          h(p.html) +
          '"></iframe>',
        confirmLabel: "Gönderimi Onayla",
      }))
    )
      return;
    if (!(await reauth())) return;
    const out = await call(member(uid, "notice/send"), { id: p.id });
    notify("success", "Gönderim kuyruğa kaydedildi", out.reference);
    if (selected?.uid === uid) await history(uid, "notices");
  }
  async function remove(uid, mode) {
    const p = await call(member(uid, "removal/preview"), { mode }),
      counts = (items) =>
        items
          .filter((x) => x.count)
          .map(
            (x) =>
              "<li>" +
              h(collectionNames[x.name] || x.name) +
              " · " +
              Number(x.count) +
              "</li>",
          )
          .join("") || "<li>Kayıt yok</li>";
    const proceed = await dialog({
      title: "Hesap silme önizlemesi",
      description: p.email + " · " + uid,
      content:
        "<h3>Silinecek veya anonimleştirilecek</h3><ul>" +
        counts(p.personal) +
        "</ul><h3>Korunacak kayıtlar</h3><ul>" +
        counts(p.financial) +
        "</ul>" +
        (p.blockers.length
          ? "<h3>İşlemi engelleyen kayıtlar</h3><ul>" +
            p.blockers.map((x) => "<li>" + h(x) + "</li>").join("") +
            "</ul>"
          : ""),
      confirmLabel: p.blockers.length ? "Kapat" : "İkinci Onaya Geç",
      destructive: !p.blockers.length,
    });
    if (!proceed || p.blockers.length) return;
    const proof = await dialog({
      title:
        mode === "ban" ? "Kalıcı silme ve kayıt engeli" : "Kalıcı silme onayı",
      description:
        p.email +
        " hesabının silinebilir verileri ve oturumları kaldırılacak. Bu işlem geri alınamaz." +
        (mode === "ban" ? " Bu e-posta ile yeniden kayıt engellenecek." : ""),
      content:
        '<label class="operation-field">İşlem gerekçesi<textarea name="reason" minlength="5" maxlength="350" required></textarea></label>' +
        codeField(),
      confirmLabel: "Parolayla Doğrula",
      destructive: true,
      collect: (f) => ({
        reason: f.elements.reason.value.trim(),
        totp: f.elements.totp.value,
      }),
    });
    if (!proof || !(await reauth())) return;
    const job = await call(member(uid, "removal/confirm"), {
      mode,
      token: p.token,
      ...proof,
    });
    await showJob(uid, job);
  }
  async function showJob(uid, job) {
    stopJob();
    if (selected?.uid !== uid || !job) return;
    const epoch = ++historyEpoch;
    const host = $("#memberHistory");
    host.innerHTML =
      "<h3>Hesap silme işlemi</h3><p>" +
      h(label(job.state)) +
      " · " +
      job.step +
      " / " +
      job.totalSteps +
      '</p><progress max="' +
      Number(job.totalSteps) +
      '" value="' +
      Number(job.step) +
      '"></progress><p>İşlem referansı ' +
      h(job.id) +
      "</p>" +
      (job.lastError ? "<p>" + h(job.lastError) + "</p>" : "") +
      btn("job", "Sonucu yenile");
    if (job.state === "completed") {
      const result = host.cloneNode(true);
      result.querySelector("button")?.remove();
      selected = null;
      $("#userResult").replaceChildren(result);
      await directory();
      return;
    }
    if (job.state === "pending")
      jobTimer = setTimeout(async () => {
        if (epoch !== historyEpoch || selected?.uid !== uid) return;
        try {
          const result = await request(member(uid, "removal"));
          if (epoch === historyEpoch) await showJob(uid, result.result);
        } catch (e) {
          if (epoch === historyEpoch) {
            const msg = document.createElement("p");
            msg.textContent = "İşlem durumu alınamadı. " + e.message;
            host.append(msg);
          }
        }
      }, 3500);
  }
  async function action(el) {
    const kind = el.dataset.memberAction;
    if (kind === "more" || kind === "refresh")
      return directory(kind === "more");
    if (kind === "filters") {
      const bool = [
          ["", "Tümü"],
          ["yes", "Evet"],
          ["no", "Hayır"],
        ],
        groups = [
          [
            "status",
            "Hesap durumu",
            [
              ["", "Tümü"],
              ...Object.entries(accountStates).map(([k, v]) => [k, v[0]]),
            ],
          ],
          ["verified", "E-posta doğrulandı", bool],
          ["orders", "Siparişi var", bool],
          ...(can("store.wallet.read")
            ? [["balance", "Bakiyesi var", bool]]
            : []),
        ];
      const result = await dialog({
        title: "Hesap filtreleri",
        confirmLabel: "Filtreleri Uygula",
        content: groups
          .map(([k, n, opts]) => options(n, opts, filters[k] || ""))
          .join(""),
        collect: (f) =>
          Object.fromEntries(groups.map(([k, n]) => [k, f.elements[n].value])),
      });
      if (result) {
        filters = result;
        return directory();
      }
      return;
    }
    const u = selected;
    if (!u) return;
    if (kind === "status") {
      const value = await dialog({
        title: "Hesap durumu",
        content: options(
          "Durum",
          Object.entries(accountStates).map(([k, [v, d]]) => [k, v, d]),
          draft,
        ),
        confirmLabel: "Seçimi Uygula",
        collect: (f) => f.elements.Durum.value,
      });
      if (value && selected === u) {
        draft = value;
        el.textContent = stateLabel(value);
      }
      return;
    }
    if (kind === "save") {
      const body = {
        status: draft,
        adminNote: $("#memberNote").value,
        expectedRevision: u.revision,
      };
      if (
        draft === u.accountStatus &&
        body.adminNote === (u.adminNote || "") &&
        !u.changePending
      )
        return notify("info", "Kaydedilecek değişiklik yok", "");
      if (u.accountStatus === "security_locked" && draft !== u.accountStatus) {
        const code = await dialog({
          title: "Güvenlik kilidini kaldır",
          content: codeField(),
          collect: (f) => f.elements.totp.value,
        });
        if (!code) return;
        body.securityCode = code;
      }
      if (!(await reauth())) return;
      const res = await request(
        "/api/admin/store/users/" + encodeURIComponent(u.uid),
        { method: "PATCH", body },
      );
      if (selected !== u) return;
      selected = res.user;
      draw();
      notify("success", "Değişiklikler kaydedildi", "");
      return directory();
    }
    if (kind === "copy") {
      await navigator.clipboard.writeText(u[el.dataset.field]);
      return notify("success", "Panoya kopyalandı", "");
    }
    if (kind === "compose") return compose(u.uid);
    if (kind === "delete" || kind === "ban") return remove(u.uid, kind);
    if (kind === "job")
      return showJob(u.uid, (await request(member(u.uid, "removal"))).result);
    if (listing[kind]) return history(u.uid, kind);
    if (kind === "history-more") return history(u.uid, historyKind, true);
  }
  function mount(host) {
    root = host;
    root.innerHTML =
      '<form id="userSearchForm" class="member-search"><label for="userSearch">Kullanıcı adı, e-posta veya Firebase UID</label><div><input id="userSearch" type="search" autocomplete="off" placeholder="Hesap ara"><button type="submit" class="primary-action">Ara</button>' +
      btn("filters", "Filtreler") +
      '</div></form><div class="member-directory"><header><h2>Mağaza hesapları</h2>' +
      btn("refresh", "Yenile") +
      '</header><p id="memberListState" role="status"></p><div id="userDirectory"></div>' +
      btn(
        "more",
        "Sonraki sayfa",
        "secondary-action",
        'id="memberMore" hidden',
      ) +
      '</div><div id="userResult" aria-live="polite"></div>';
    $("#userSearchForm").addEventListener("submit", (e) => {
      e.preventDefault();
      void directory();
    });
    root.addEventListener("click", async (e) => {
      const b = e.target.closest("button");
      if (!b || b.disabled) return;
      b.disabled = true;
      try {
        if (b.dataset.memberOpen) await select(b.dataset.memberOpen);
        else if (b.dataset.memberAction) await action(b);
      } catch (err) {
        notify("error", "İşlem tamamlanamadı", err.message);
      } finally {
        b.disabled = false;
      }
    });
  }
  return {
    leave() {
      stopJob();
      listEpoch++;
      detailEpoch++;
      historyEpoch++;
    },
    async load(host) {
      if (root !== host) mount(host);
      return directory();
    },
  };
}
