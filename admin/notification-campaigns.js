import { escapeHtml as e } from "./admin-core.js?v=116";
import { openAdminDialog } from "./admin-dialogs.js?v=116";

const endpoint = "/api/admin/store/commerce/notification-campaigns";
const clock = new Intl.DateTimeFormat("tr-TR", {
  timeZone: "Europe/Istanbul",
  dateStyle: "short",
  timeStyle: "short",
});
const date = (t) => (t ? clock.format(new Date(t)) : "—");
const local = (t) => (t ? Date.parse(t + (t.length === 16 ? ":00" : "") + "+03:00") : 0);
const icon = (name) => `<i class="fa-solid fa-${name}" aria-hidden="true"></i>`;
const labels = {
  draft: "Taslak",
  pending: "Alıcılar taranıyor",
  completed: "Alıcı taraması tamamlandı",
  cancelled: "İptal edildi",
  expired: "Süresi doldu",
  needs_review: "İnceleme gerekiyor",
  published: "Yayımlandı",
  queued: "Kuyrukta",
  retry: "Yeniden denenecek",
  sending: "Gönderiliyor",
  verifying: "Sağlayıcı teyidi bekleniyor",
  accepted: "Sağlayıcı kabul etti",
  delivered: "Teslim edildi",
  delayed: "Teslimat gecikti",
  failed: "Başarısız",
  bounced: "Adres teslimatı reddetti",
  complained: "Şikâyet bildirildi",
  suppressed: "Sağlayıcı engelledi",
  skipped: "Gönderilmedi",
};
const reasons = {
  identity: "Mağaza hesabı tanımlanamıyor",
  missing: "Hesap bulunamadı",
  disabled: "Hesap devre dışı",
  unverified: "E-posta doğrulanmamış",
  address: "Geçerli e-posta adresi yok",
  suspended: "Mağaza hesabı askıya alınmış",
  preferences: "Seçilen kanallar için kampanya izni yok",
};
const eligibleForRecovery = (row) =>
  row.source === "manual" &&
  row.state === "completed" &&
  !row.audience &&
  row.skipped > 0 &&
  !row.siteQueued &&
  !row.emailQueued &&
  (!row.endsAt || row.endsAt > Date.now());
const channel = (name, label, description, symbol) =>
  `<label class="dispatch-channel"><input type="checkbox" name="${name}" checked><span class="dispatch-channel__body">${icon(symbol)}<span><b>${label}</b><small>${description}</small></span><span class="dispatch-check">✓</span></span></label>`;
const compose = `<form data-campaign-form class="dispatch-form">
<div class="dispatch-field"><label for="dispatch-title">Bildirim başlığı</label><input id="dispatch-title" name="title" required maxlength="120" placeholder="Örn. Mağaza fiyat güncellemesi"></div>
<div class="dispatch-field"><label for="dispatch-message">Mesaj</label><textarea id="dispatch-message" name="message" required maxlength="1000" rows="4" placeholder="Üyelerinizin bilmesi gerekenleri yazın."></textarea></div>
<fieldset><legend>Gönderim kanalları</legend><div class="dispatch-channels">${channel("site", "Site içi", "Bildirimlerim kutusu", "bell")}${channel("email", "E-posta", "Doğrulanmış adres", "envelope")}</div></fieldset>
<div class="dispatch-field"><label for="dispatch-audience">Bildirim türü</label><select name="audience" id="dispatch-audience"><option value="subscribed">Kampanya · izin veren üyeler</option><option value="verified">Hizmet duyurusu · doğrulanmış üyeler</option></select></div>
<div class="dispatch-field"><label for="dispatch-group">Alıcılar</label><select name="group" id="dispatch-group"><option value="all">E-postasını doğrulamış tüm üyeler</option><option value="selected">Seçili doğrulanmış üyeler</option></select></div>
<div class="dispatch-field" data-targets hidden><label for="dispatch-uids">Hesap kimlikleri</label><textarea id="dispatch-uids" name="uids" rows="2" placeholder="Her satıra bir UID, en fazla 200"></textarea></div>
<fieldset><legend>Gönderim zamanı</legend><div class="dispatch-timing"><label><input type="radio" name="timing" value="now" checked><span>${icon("bolt")} Hemen</span></label><label><input type="radio" name="timing" value="scheduled"><span>${icon("clock")} Zamanla</span></label></div></fieldset>
<div class="dispatch-field" data-schedule hidden><label for="dispatch-start">Gönderim tarihi ve saati <small>Türkiye saati</small></label><input id="dispatch-start" name="startsAt" type="datetime-local"></div>
<details class="dispatch-expiry"><summary>Gönderime bitiş zamanı ekle</summary><label for="dispatch-end">Bitiş tarihi ve saati · Türkiye saati</label><input id="dispatch-end" name="endsAt" type="datetime-local"></details>
<p data-form-error role="alert" hidden></p><div class="dispatch-actions"><button type="submit" value="send" class="dispatch-primary">${icon("paper-plane")} <span data-send-label>Şimdi gönder</span></button><button type="submit" value="draft" class="dispatch-secondary">Taslak kaydet</button></div>
</form>`;
const shell = (allowed) =>
  `<header class="dispatch-heading"><div class="dispatch-emblem">${icon("paper-plane")}</div><div><h3>Bildirim gönderimi</h3><p>Doğrulanmış üyelere mağaza duyurusu gönderin.</p></div></header>${allowed ? compose : ""}<section class="dispatch-history" aria-labelledby="dispatch-history-title"><header><h4 id="dispatch-history-title">Gönderim geçmişi</h4><button type="button" class="dispatch-secondary" data-refresh>${icon("rotate-right")} Yenile</button></header><div data-jobs aria-live="polite"></div><button type="button" data-older class="dispatch-secondary" hidden>Daha eski gönderimler</button></section>`;
function jobCard(row, allowed) {
  const count = (x) => Number(x) || 0;
  const empty = row.state === "completed" && !row.siteQueued && !row.emailQueued;
  const title =
    row.state === "pending" && row.availableAt > Date.now() && !row.lastError
      ? "Zamanlandı"
      : empty
        ? "Hiçbir alıcıya kayıt oluşturulmadı"
        : labels[row.state] || row.state;
  const reasonText = Object.entries(row.skipReasons || {})
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${e(reasons[k] || k)} · ${count(n)}`)
    .join(" / ");
  const stale =
    row.state === "pending" &&
    row.availableAt <= Date.now() &&
    Date.now() - (row.updatedAt || row.availableAt) > 120000;
  const action = (state, label) =>
    `<button type="button" class="dispatch-secondary" data-state="${state}" data-revision="${count(row.revision)}">${label}</button>`;
  return `<article class="dispatch-job" data-job="${e(row.id)}"><div class="dispatch-job__top"><strong class="dispatch-state" data-tone="${empty || row.state === "needs_review" ? "warn" : row.state === "completed" ? "done" : "neutral"}">${e(title)}</strong><time>${date(row.startsAt || row.createdAt || row.availableAt)}</time></div><h5>${e(row.title)}</h5>
  ${Number.isSafeInteger(row.scanned) ? `<small class="dispatch-scanned">${row.scanned} hesap tarandı</small>` : ""}
  <dl class="dispatch-metrics"><div><dt>Site içi kayıt</dt><dd>${count(row.siteQueued)}</dd></div><div><dt>E-posta kuyruğu</dt><dd>${count(row.emailQueued)}</dd></div><div><dt>Kapsam dışı</dt><dd>${count(row.skipped)}</dd></div></dl>
  ${reasonText ? `<p>${reasonText}</p>` : ""}${empty && !row.audience && row.skipped ? "<p>Eski taramada kanal tercihi bulunmayan hesaplar atlanmış olabilir. Bu kayıtta alıcı nedenleri tutulmamış.</p>" : ""}
  ${stale || row.lastError ? `<p class="dispatch-warning">${stale ? "İşlem kontrol bekliyor. " : ""}${e(row.lastError || "")} · Deneme ${count(row.attempts)}</p>` : ""}
  <details><summary>İşlem ayrıntıları</summary><p>${row.audience === "verified" ? "Hizmet duyurusu" : "Kampanya"} · İşlem kimliği</p><code>${e(row.id)}</code></details>
  <div class="dispatch-actions"><button type="button" class="dispatch-secondary" data-trace="site">${icon("bell")} Site içi sonuçlar</button><button type="button" class="dispatch-secondary" data-trace="email">${icon("envelope")} E-posta sonuçları</button>
  ${allowed && eligibleForRecovery(row) ? action("recover", "Uygun alıcıları yeniden denetle") : ""}${allowed && ["draft", "needs_review"].includes(row.state) ? action("pending", row.state === "draft" ? "Taslağı onayla" : "İşlemeyi sürdür") : ""}
  ${allowed && row.source === "manual" && (["draft", "pending", "needs_review"].includes(row.state) || (row.state === "completed" && row.emailQueued > 0)) ? action("cancelled", "Kalan gönderimi iptal et") : ""}</div><div data-history aria-live="polite"></div></article>`;
}
function trace(result) {
  const info =
    result.total == null
      ? ""
      : `<p><strong>${Number(result.total)}</strong> alıcı kaydı${result.total < result.recorded ? " · Geçmiş sayaçla fark var." : ""}</p>`;
  const missing =
    result.channel === "email" && !result.emailReady
      ? "<p class='dispatch-warning'>E-posta gönderimi için sağlayıcı ayarları bekleniyor.</p>"
      : "";
  const delivery = result.delivery
    ? `<dl class="dispatch-mail-totals">${[
        ["pending", "İşleniyor"],
        ["accepted", "Sağlayıcıda"],
        ["delivered", "Teslim edildi"],
        ["attention", "Kontrol gerekli"],
      ]
        .map(
          ([key, label]) =>
            `<div><dt>${label}</dt><dd>${Number(result.delivery[key]) || 0}</dd></div>`,
        )
        .join("")}</dl>`
    : "";
  return (
    info +
    delivery +
    missing +
    (result.items.length
      ? result.items
          .map(
            (row) =>
              `<div class="dispatch-receipt"><b>${e(labels[row.state] || row.state)}</b><small>Hesap · ${e(row.uid)}</small><small>${date(row.updatedAt)} · ${Number(row.attempts) || 0} deneme</small>${row.failureCode ? `<small>${e(row.failureCode)}</small>` : ""}${row.stale ? "<small>İki dakikadan uzun süredir kontrol bekliyor.</small>" : ""}${row.nextAttemptAt ? `<small>Sonraki kontrol · ${date(row.nextAttemptAt)}</small>` : ""}<code>${e(row.id)}${row.providerId ? " · " + e(row.providerId) : ""}</code></div>`,
          )
          .join("")
      : "<p>Bu kanal için alıcı kaydı bulunmuyor.</p>") +
    (result.nextCursor
      ? `<button type="button" class="dispatch-secondary" data-trace="${e(result.channel)}" data-cursor="${e(result.nextCursor)}">Daha fazla sonuç</button>`
      : "")
  );
}
export function createNotificationCampaigns({ request, reauthenticate, allowed, notify }) {
  let mounted,
    version = 0,
    signature = "",
    requestKey = "",
    sending = false;
  function setup(host) {
    host.innerHTML = shell(allowed());
    const form = host.querySelector("form");
    const timing = () => {
      const scheduled = form.elements.timing.value === "scheduled";
      form.querySelector("[data-schedule]").hidden = !scheduled;
      form.elements.startsAt.required = scheduled;
      form.querySelector("[data-send-label]").textContent = scheduled
        ? "Gönderimi zamanla"
        : "Şimdi gönder";
    };
    if (form) {
      form.onchange = () => {
        form.querySelector("[data-targets]").hidden = form.elements.group.value !== "selected";
        timing();
      };
      form.onsubmit = async (event) => {
        event.preventDefault();
        if (sending || !allowed()) return;
        const values = new FormData(form),
          mode = event.submitter?.value === "draft" ? "draft" : values.get("timing");
        const input = {
          title: values.get("title").trim(),
          message: values.get("message").trim(),
          group: values.get("group"),
          audience: values.get("audience"),
          uids: [],
          channels: { site: values.has("site"), email: values.has("email") },
          startsAt: values.get("timing") === "scheduled" ? local(values.get("startsAt")) : 0,
          endsAt: local(values.get("endsAt")),
          mode,
        };
        if (input.group === "selected")
          input.uids = [
            ...new Set(
              String(values.get("uids"))
                .trim()
                .split(/[\s,;]+/)
                .filter(Boolean),
            ),
          ];
        const feedback = form.querySelector("[data-form-error]");
        const error =
          !input.title || !input.message
            ? "Başlık ve mesajı girin."
            : !input.channels.site && !input.channels.email
              ? "En az bir gönderim kanalı seçin."
              : input.group === "selected" && (!input.uids.length || input.uids.length > 200)
                ? "Bir ile 200 arasında hesap kimliği girin."
                : mode === "scheduled" && !(input.startsAt > Date.now())
                  ? "Gelecekte bir gönderim zamanı seçin."
                  : input.endsAt && input.endsAt <= Math.max(Date.now(), input.startsAt)
                    ? "Bitiş zamanı gönderimden sonra olmalıdır."
                    : "";
        feedback.textContent = error;
        feedback.hidden = !error;
        if (error) return;
        sending = true;
        const buttons = [...form.querySelectorAll('[type="submit"]')];
        buttons.forEach((b) => (b.disabled = true));
        try {
          const label =
            mode === "now"
              ? "Şimdi gönder"
              : mode === "draft"
                ? "Taslak kaydet"
                : "Gönderimi zamanla";
          const ok = await openAdminDialog({
            title: "Bildirim önizlemesi",
            confirmLabel: label,
            content: `<h3>${e(input.title)}</h3><p style="white-space:pre-wrap">${e(input.message)}</p><p>${input.group === "all" ? "E-postasını doğrulamış tüm üyeler" : input.uids.length + " seçili hesap"} · ${[input.channels.site ? "Site içi" : "", input.channels.email ? "E-posta" : ""].filter(Boolean).join(" ve ")}</p><p>${input.audience === "verified" ? "Hizmet duyurusu ilgili doğrulanmış üyelere iletilecek." : "Her kanal için üyenin güncel kampanya izni kontrol edilecek."}</p><p>${input.startsAt ? date(input.startsAt) + " · Türkiye saati" : "Hemen"}</p>`,
          });
          if (!ok || !(await reauthenticate())) return;
          const next = JSON.stringify(input);
          if (next !== signature) {
            signature = next;
            requestKey = crypto.randomUUID();
          }
          const { result } = await request(endpoint, {
            method: "POST",
            body: { ...input, requestKey },
          });
          if (!result?.id) throw Error("İşlem kimliği doğrulanamadı.");
          signature = "";
          form.reset();
          form.onchange();
          notify(
            "success",
            mode === "draft"
              ? "Taslak kaydedildi"
              : mode === "scheduled"
                ? "Gönderim zamanlandı"
                : "Gönderim işleme alındı",
            "İşlem kimliği " + result.id,
          );
          await historyPage(host);
        } catch (err) {
          feedback.textContent = err.message;
          feedback.hidden = false;
        } finally {
          sending = false;
          buttons.forEach((b) => (b.disabled = false));
        }
      };
    }
    host.onclick = async (event) => {
      const button = event.target.closest("button[type=button]");
      if (!button || button.disabled) return;
      const card = button.closest("[data-job]");
      button.disabled = true;
      try {
        if (button.hasAttribute("data-refresh")) await historyPage(host);
        else if (button.hasAttribute("data-older")) await historyPage(host, button.dataset.older);
        else if (card) {
          const path = endpoint + "/" + encodeURIComponent(card.dataset.job);
          if (button.dataset.trace) {
            const region = card.querySelector("[data-history]"),
              token = crypto.randomUUID();
            region.dataset.token = token;
            const { result } = await request(
              path +
                "/trace?" +
                new URLSearchParams({
                  channel: button.dataset.trace,
                  cursor: button.dataset.cursor || "",
                }),
            );
            if (region.dataset.token !== token || !card.isConnected) return;
            if (button.dataset.cursor) button.outerHTML = trace(result);
            else region.innerHTML = trace(result);
          } else if (button.dataset.state && allowed()) {
            const state = button.dataset.state,
              recover = state === "recover";
            const ok = await openAdminDialog({
              title: button.textContent,
              confirmLabel: recover ? "Yeniden işle" : "Onayla",
              description: recover
                ? "Kayıtlı kanallar ve güncel kampanya izinleri aynı işlem kimliğiyle yeniden denetlenecek. Var olan alıcı kayıtları korunacak."
                : card.querySelector("h5").textContent,
            });
            if (!ok || !(await reauthenticate())) return;
            await request(path + "/state", {
              method: "POST",
              body: { expectedRevision: Number(button.dataset.revision), state },
            });
            await historyPage(host);
          }
        }
      } catch (err) {
        notify("error", "İşlem tamamlanamadı", err.message);
      } finally {
        if (button.isConnected) button.disabled = false;
      }
    };
  }
  async function historyPage(host, cursor = "") {
    const turn = ++version,
      list = host.querySelector("[data-jobs]");
    try {
      const { result } = await request(
        endpoint + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
      );
      if (turn !== version || !host.isConnected) return;
      const rows = result.items.map((r) => jobCard(r, allowed())).join("");
      if (cursor) list.insertAdjacentHTML("beforeend", rows);
      else list.innerHTML = rows || "<p>Henüz gönderim yok.</p>";
      const next = host.querySelector("[data-older]");
      next.hidden = !result.nextCursor;
      next.dataset.older = result.nextCursor || "";
    } catch (err) {
      if (turn === version) notify("error", "Gönderim geçmişi yüklenemedi", err.message);
    }
  }
  return {
    async load(host) {
      if (!host?.isConnected) return;
      if (mounted !== host || host.dataset.writeAccess !== String(allowed())) {
        mounted = host;
        host.dataset.writeAccess = String(allowed());
        setup(host);
      }
      await historyPage(host);
    },
  };
}
