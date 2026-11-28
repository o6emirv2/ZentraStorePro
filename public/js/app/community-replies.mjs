import { escape as e, icon, date, modal } from "./ui.js?v=117";
import { profileLabel, profileAvatar } from "./community-profile.mjs?v=117";

export function createReviewThreads({ api, userId, signal, state, repaint, notify }) {
  const threads = new Map();
  const key = (id, reviewId) => (userId() || "guest") + ":" + id + ":" + reviewId;
  const endpoint = (id, reviewId) =>
    "/api/store/commerce/community/" +
    encodeURIComponent(id) +
    "/reviews/" +
    encodeURIComponent(reviewId) +
    "/replies";
  function markup(id, review) {
    const thread = threads.get(key(id, review.id)),
      open = thread?.open === true;
    const button = (action, label, attrs = "") =>
      `<button type="button" class="thread-button" data-community="${action}" data-id="${e(id)}" data-review="${e(review.id)}" ${attrs}>${e(label)}</button>`;
    const list = (thread?.items || [])
      .map(
        (reply) =>
          `<li>${profileAvatar(reply.profile)}<div><b>${e(profileLabel(reply.profile))}</b><p data-user-content>${e(reply.message)}</p><time>${date(reply.createdAt)}</time></div></li>`,
      )
      .join("");
    return `<div class="review-thread"><div class="thread-actions">${review.replyCount > 0 ? button("thread", open ? "Yanıtları gizle" : review.replyCount + " yanıtı gör", `aria-expanded="${!!open}" aria-controls="thread-${e(review.id)}"`) : ""}
    ${review.canReply ? button("reply", "Yanıt yaz", 'aria-haspopup="dialog"') : ""}</div>
    ${
      open
        ? `<div id="thread-${e(review.id)}" class="thread-body" aria-live="polite"><ul>${list}</ul>
    ${thread.loading ? "<p>Yanıtlar yükleniyor…</p>" : ""}${thread.error ? `<p role="alert">${e(thread.error)}</p>` : ""}
    ${!thread.loading && (thread.error || thread.cursor) ? button("thread-more", thread.error ? "Yeniden dene" : "Diğer yanıtları göster") : ""}</div>`
        : ""
    }</div>`;
  }
  async function load(id, reviewId, { more = false } = {}) {
    const k = key(id, reviewId),
      previous = threads.get(k),
      marker = { ...(previous || {}), open: true, loading: true, error: "" };
    const cursor = more ? previous?.cursor || "" : "";
    threads.set(k, marker);
    repaint(id);
    try {
      const { result } = await api(
        endpoint(id, reviewId) + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
        { auth: false, signal },
      );
      if (signal.aborted || k !== key(id, reviewId) || threads.get(k) !== marker) return;
      if (
        result?.reviewId !== reviewId ||
        !Array.isArray(result.items) ||
        typeof result.nextCursor !== "string"
      )
        throw Error("Yanıtlar doğrulanamadı.");
      const rows = cursor ? [...(previous?.items || []), ...result.items] : result.items;
      threads.set(k, {
        open: true,
        items: [...new Map(rows.map((row) => [row.id, row])).values()],
        cursor: result.nextCursor,
      });
    } catch (err) {
      if (signal.aborted || threads.get(k) !== marker) return;
      threads.set(k, { ...marker, loading: false, error: err.message || "Yanıtlar yüklenemedi." });
    }
    if (!signal.aborted && k === key(id, reviewId)) repaint(id);
  }
  function compose(id, review) {
    const data = state(id),
      owner = userId();
    if (!owner || !review?.canReply || !data.eligibility?.orderId) return;
    let prior, mutationId;
    modal({
      title: "Yoruma yanıt ver",
      symbol: "comment",
      submit: "Yanıtı yayımla",
      appearance: "sheet",
      body: `<blockquote class="reply-context"><b>${e(profileLabel(review.profile))}</b><p>${e(review.message)}</p></blockquote>
      <label class="field"><span>Yanıtınız</span><textarea name="message" required minlength="3" maxlength="1500" rows="4" placeholder="Bu yorumla ilgili deneyiminizi paylaşın."></textarea></label>`,
      onSubmit: async (form) => {
        if (signal.aborted || userId() !== owner) throw Error("Hesap oturumu değişti.");
        const message = String(form.get("message") || "").trim();
        if (message !== prior) {
          prior = message;
          mutationId = crypto.randomUUID();
        }
        const { result } = await api(endpoint(id, review.id), {
          method: "POST",
          auth: true,
          body: { orderId: data.eligibility.orderId, message, mutationId },
        });
        if (signal.aborted || userId() !== owner) return;
        if (!result?.id || result.reviewId !== review.id || !Number.isInteger(result.replyCount))
          throw Error("Yanıtın kaydedildiği doğrulanamadı.");
        const current = state(id)?.reviews.find((row) => row.id === review.id);
        if (current) current.replyCount = result.replyCount;
        await load(id, review.id);
        notify("Yanıtınız yayımlandı.");
      },
    });
  }
  async function handle(action, id, reviewId) {
    const review = state(id)?.reviews.find((row) => row.id === reviewId);
    if (!review) return;
    if (action === "reply") {
      compose(id, review);
      return;
    }
    const k = key(id, reviewId),
      current = threads.get(k);
    if (action === "thread" && current?.open) {
      threads.set(k, { ...current, open: false });
      repaint(id);
      return;
    }
    await load(id, reviewId, { more: action === "thread-more" });
  }
  return { markup, handle };
}
