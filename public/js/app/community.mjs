import { createReviewThreads } from "./community-replies.mjs?v=117";
import { escape as e, icon, date, modal, field, toast } from "./ui.js?v=117";
import { profileAvatar, profileLabel, likerRow } from "./community-profile.mjs?v=117";
const BASE = "/api/store/commerce/community";
export function createCommunity({ api, userId, signIn }) {
  const states = new Map(),
    pending = new Map(),
    working = new Set();
  const controller = new AbortController();
  const identity = () => userId() || "guest";
  const stateKey = (id) => identity() + ":" + id;
  const options = () => ({ auth: !!userId(), headers: {} });
  const threads = createReviewThreads({
    api,
    userId,
    signal: controller.signal,
    state: (id) => states.get(stateKey(id)),
    repaint: paint,
    notify: toast,
  });
  async function load(id, { cursor = "" } = {}) {
    const key = stateKey(id),
      owner = identity();
    const response = await api(
      BASE + "/" + encodeURIComponent(id) + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
      { ...options(), signal: controller.signal },
    );
    if (controller.signal.aborted) throw new Error("Ürün penceresi kapatıldı.");
    if (owner !== identity()) throw new Error("Hesap değişti. Ürün etkileşimlerini yeniden aç.");
    const data = response.result;
    if (
      !data ||
      data.productId !== id ||
      !Number.isSafeInteger(data.likes) ||
      data.likes < 0 ||
      !Number.isSafeInteger(data.revision) ||
      data.revision < 0 ||
      typeof data.liked !== "boolean" ||
      !Array.isArray(data.reviews)
    )
      throw new Error("Ürün etkileşimleri doğrulanamadı.");
    const previous = states.get(key);
    if (cursor && previous)
      data.reviews = [
        ...new Map([...previous.reviews, ...data.reviews].map((x) => [x.id, x])).values(),
      ];
    if (previous && previous.revision > data.revision) {
      data.liked = previous.liked;
      data.likes = previous.likes;
      data.revision = previous.revision;
    }
    states.set(key, data);
    return data;
  }
  function markup(id) {
    const data = states.get(stateKey(id));
    if (!data)
      return `<section class="community panel" id="product-community" data-product="${e(id)}"><h2>Beğeniler ve yorumlar</h2><p>Ürün etkileşimleri henüz yüklenemedi.</p><button class="button secondary" data-community="refresh" data-id="${e(id)}">Yeniden dene</button></section>`;
    const eligible = data.eligibility?.eligible === true;
    const likeLabel = userId()
      ? data.liked
        ? "Beğeniyi geri al"
        : "Ürünü beğen"
      : "Beğenmek için giriş yap";
    const action = (name, label, symbol, extra = "") =>
      `<button type="button" data-community="${name}" data-id="${e(id)}" ${extra}>${icon(symbol)}<span>${e(label)}</span></button>`;
    const reviews = data.reviews
      .map(
        (row) => `<article class="community-comment">${profileAvatar(row.profile)}<div>
      <header><b class="community-author">${e(profileLabel(row.profile))}</b><span class="verified-badge">${icon("check")} Doğrulanmış satın alma</span></header>
      <span class="review-stars" aria-label="5 üzerinden ${e(row.rating)} puan">${"★".repeat(Math.max(0, Math.min(5, Number(row.rating) || 0)))}</span>
      <h4>${e(row.title)}</h4><p data-user-content>${e(row.message)}</p><time>${date(row.createdAt)}</time>${threads.markup(id, row)}</div></article>`,
      )
      .join("");
    return `<section class="community panel" id="product-community" data-product="${e(id)}" aria-labelledby="community-title">
      <div class="community-heading"><h3 id="community-title">Beğeniler ve yorumlar</h3>${action("refresh", "Yenile", "refresh")}</div>
      <div class="community-actions">${action(userId() ? "like" : "login", likeLabel, "heart", `class="community-like ${data.liked ? "is-liked" : ""}" aria-pressed="${data.liked}"`)}
      ${action("people", data.likes + " beğeni", "user", 'class="community-comments-link" aria-haspopup="dialog"')}</div>
      <div class="community-compose"><p>${eligible ? "Bu ürünü satın aldınız. Deneyiminizi paylaşabilirsiniz." : data.eligibility?.reason === "already-reviewed" ? "Bu ürün için yorumunuz kaydedildi." : "Yorum yazabilmek için bu ürünü satın almış olmanız gerekir."}</p>
      ${eligible ? action("review", "Yorum yaz", "comment", 'class="primary" aria-haspopup="dialog"') : ""}</div>
      <div class="community-comments">${reviews || '<p class="community-empty">Henüz yayımlanmış yorum yok.</p>'}</div>
      ${data.nextCursor ? action("more", "Daha fazla yorum göster", "down") : ""}</section>`;
  }
  function paint(id) {
    const node = document.querySelector(
      '#product-community[data-product="' + CSS.escape(id) + '"]',
    );
    if (!controller.signal.aborted && node) {
      const focused = node.contains(document.activeElement)
        ? document.activeElement.dataset.community
        : "";
      const reviewId = document.activeElement?.dataset?.review;
      node.outerHTML = markup(id);
      if (focused)
        document
          .querySelector(
            `#product-community [data-community="${CSS.escape(focused)}"]${reviewId ? `[data-review="${CSS.escape(reviewId)}"]` : ""}`,
          )
          ?.focus({ preventScroll: true });
    }
  }
  async function react(id) {
    if (!userId()) throw new Error("Beğenmek için hesabınıza giriş yapın.");
    const key = stateKey(id),
      owner = identity();
    if (working.has(key)) return;
    working.add(key);
    try {
      let current = states.get(key);
      if (!current) current = await load(id);
      const operation = pending.get(key) || {
        liked: !current.liked,
        expectedRevision: current.revision,
        mutationId: crypto.randomUUID(),
      };
      pending.set(key, operation);
      const response = await api(BASE + "/" + encodeURIComponent(id) + "/like", {
        ...options(),
        method: "PUT",
        body: operation,
      });
      if (owner !== identity()) throw new Error("Hesap oturumu değişti.");
      const result = response.result;
      if (
        result?.productId !== id ||
        typeof result.liked !== "boolean" ||
        (result.replayed !== true && result.liked !== operation.liked) ||
        !Number.isSafeInteger(result.likes) ||
        result.likes < 0 ||
        !Number.isSafeInteger(result.revision) ||
        result.revision < 0
      )
        throw new Error("Beğeni sonucu doğrulanamadı. Durumu kontrol et.");
      const latest = states.get(key) || current;
      if (result.revision >= latest.revision) states.set(key, { ...latest, ...result });
      pending.delete(key);
      paint(id);
    } catch (error) {
      if (!controller.signal.aborted && owner === identity()) {
        if (["COMMUNITY_REVISION_CONFLICT", "COMMUNITY_OPERATION_CONFLICT"].includes(error.code))
          pending.delete(key);
        await load(id)
          .then(() => paint(id))
          .catch(() => {});
      }
      throw error;
    } finally {
      working.delete(key);
    }
  }
  async function showLikers(id) {
    const owner = identity(),
      people = new Map();
    let cursor = "",
      loading = false;
    const dialog = modal({
      title: "Beğenenler",
      symbol: "heart",
      body: '<div class="community-people" aria-live="polite"><p>Beğenenler yükleniyor…</p></div>',
    });
    const container = dialog.element.querySelector(".community-people");
    async function page() {
      if (loading) return;
      loading = true;
      container.setAttribute("aria-busy", "true");
      container.querySelectorAll("button").forEach((button) => (button.disabled = true));
      try {
        const response = await api(
          BASE +
            "/" +
            encodeURIComponent(id) +
            "/likes" +
            (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
          { auth: false },
        );
        if (controller.signal.aborted || owner !== identity() || !dialog.element.isConnected)
          return;
        const data = response.result;
        if (
          data?.productId !== id ||
          !Array.isArray(data.people) ||
          data.people.some((person) => !person.id || !person.profile) ||
          typeof data.nextCursor !== "string"
        )
          throw new Error("Beğenenlerin profilleri doğrulanamadı.");
        data.people.forEach((person) => people.set(person.id, person));
        cursor = data.nextCursor;
        container.innerHTML =
          (people.size
            ? '<ul class="community-people-list">' +
              [...people.values()].map(likerRow).join("") +
              "</ul>"
            : "<p>Henüz beğeni yok. İlk beğenen sen olabilirsin.</p>") +
          (cursor
            ? '<button type="button" class="button secondary" data-likers-next>Daha fazla göster</button>'
            : "");
      } catch (error) {
        if (controller.signal.aborted || owner !== identity() || !dialog.element.isConnected)
          return;
        if (error.code === "COMMUNITY_CURSOR_INVALID") {
          cursor = "";
          people.clear();
        }
        container.innerHTML =
          (people.size
            ? '<ul class="community-people-list">' +
              [...people.values()].map(likerRow).join("") +
              "</ul>"
            : "") +
          '<div class="notice error" role="alert">' +
          icon("warning") +
          "<p>" +
          e(error.message || "Profiller yüklenemedi.") +
          '</p></div><button type="button" class="button secondary" data-likers-next>Yeniden dene</button>';
      } finally {
        loading = false;
        container.removeAttribute("aria-busy");
        container.querySelectorAll("button").forEach((button) => (button.disabled = false));
      }
    }
    container.addEventListener("click", (event) => {
      if (event.target.closest("[data-likers-next]")) void page();
    });
    await page();
  }
  function review(id) {
    const owner = identity(),
      data = states.get(stateKey(id));
    if (!userId() || !data?.eligibility?.eligible)
      throw new Error("Yorum yazmak için bu ürüne ait tamamlanmış satın alma gerekli.");
    let signature = "",
      requestId = "";
    modal({
      title: "Deneyimini paylaş",
      appearance: "sheet",
      submit: "Yorumu yayımla",
      symbol: "comment",
      body: `${field("title", "Kısa başlık", "text", "", 'required maxlength="100"')}<label class="field"><span>Puanın</span><select name="rating" required>${[5, 4, 3, 2, 1].map((n) => `<option value="${n}">${n} / 5</option>`).join("")}</select></label><label class="field"><span>Yorumun</span><textarea name="message" required minlength="3" maxlength="2000" rows="5" placeholder="Ürün hakkındaki deneyimini paylaş."></textarea></label><p class="fine-print">Kişisel bilgi, parola veya lisans kodu paylaşma.</p>`,
      onSubmit: async (form) => {
        if (controller.signal.aborted || owner !== identity())
          throw new Error("Hesap oturumu değişti.");
        const body = {
          orderId: data.eligibility.orderId,
          productId: id,
          title: form.get("title"),
          rating: Number(form.get("rating")),
          message: form.get("message"),
        };
        const next = JSON.stringify(body);
        if (signature !== next) {
          signature = next;
          requestId = crypto.randomUUID();
        }
        const response = await api("/api/store/commerce/reviews", {
          body: { ...body, mutationId: requestId },
        });
        if (
          controller.signal.aborted ||
          owner !== identity() ||
          response.result?.verifiedPurchase !== true
        )
          throw new Error("Yorumun kaydedildiği doğrulanamadı. Durumu yenile.");
        toast("Yorumun kaydedildi.");
        await load(id)
          .then(() => paint(id))
          .catch(() => {
            states.delete(stateKey(id));
            paint(id);
          });
      },
    });
  }
  async function click(event) {
    const button = event.target.closest("[data-community]");
    if (!button || button.disabled) return;
    event.preventDefault();
    const id = button.dataset.id,
      action = button.dataset.community;
    if (["thread", "thread-more", "reply"].includes(action)) {
      try {
        await threads.handle(action, id, button.dataset.review);
      } catch (error) {
        if (!controller.signal.aborted) toast(error.message, "error");
      }
      return;
    }
    if (action === "login") {
      signIn?.(button);
      return;
    }
    if (action === "review") {
      try {
        review(id);
      } catch (error) {
        toast(error.message, "error");
      }
      return;
    }
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try {
      if (action === "people") await showLikers(id);
      else if (action === "like") await react(id);
      else {
        const data = states.get(stateKey(id));
        await load(id, {
          cursor: action === "more" ? data?.nextCursor || "" : "",
        });
        paint(id);
      }
    } catch (error) {
      if (!controller.signal.aborted)
        toast(error.message || "İşlem doğrulanamadı. Durumu yenile.", "error");
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }
  const doubleTap = (event) => {
    const slide = event.target.closest?.(".product-gallery__slide");
    const id = slide?.closest("[data-product-gallery]")?.dataset.productGallery;
    if (!userId() || !id || states.get(stateKey(id))?.liked || !states.has(stateKey(id))) return;
    event.preventDefault();
    void react(id).catch((error) => toast(error.message, "error"));
  };
  const avatarError = (event) => {
    if (event.target.matches?.("img[data-community-avatar]")) event.target.hidden = true;
  };
  document.addEventListener("error", avatarError, true);
  document.addEventListener("dblclick", doubleTap);
  document.addEventListener("click", click);
  return {
    load,
    markup,
    react,
    dispose() {
      controller.abort();
      document.removeEventListener("click", click);
      document.removeEventListener("error", avatarError, true);
      document.removeEventListener("dblclick", doubleTap);
      states.clear();
      pending.clear();
    },
  };
}
