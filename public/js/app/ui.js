import { imageVariants } from "./images.mjs?v=92";
export const escape = (value = "") =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const money = (value) =>
  new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency: "TRY",
    maximumFractionDigits: 2,
  }).format((Number(value) || 0) / 100);
export const date = (value) =>
  value
    ? new Intl.DateTimeFormat("tr-TR", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Europe/Istanbul",
      }).format(Number(value))
    : "—";
const paths = {
  copy: "M9 9h12v12H9zM15 9V3H3v12h6",
  home: "m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z",
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  search: "m21 21-4.8-4.8M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0",
  bag: "M5 7h14l2 14H3ZM9 8V6a3 3 0 0 1 6 0v2",
  user: "M20 21v-2a6 6 0 0 0-6-6h-4a6 6 0 0 0-6 6v2M16 5a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  heart:
    "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z",
  arrow: "M4 12h16m-6-6 6 6-6 6",
  back: "M20 12H4m6-6-6 6 6 6",
  down: "m6 9 6 6 6-6",
  check: "m5 12 4 4L19 6",
  close: "m6 6 12 12M6 18 18 6",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  shield: "m12 2 9 4v6c0 6-9 10-9 10S3 18 3 12V6Zm-4 10 3 3 5-6",
  bolt: "m13 2-9 12h7l-1 8L21 9h-7Z",
  box: "m12 3 9 5v9l-9 5-9-5V8Zm0 9 9-4m-9 4L3 8m9 4v10m-4.5-16.5 9 5",
  support:
    "M4 14v-3a8 8 0 0 1 16 0v3M4 12H2v7h4v-7Zm16 0h2v7h-4v-7ZM19 19a4 4 0 0 1-4 3h-3",
  telegram: "m22 3-4 18-6-5-4 4 1-7 10-7-12 6-5-2Z",
  filter: "M4 7h16M7 12h10M10 17h4",
  logout: "M9 5H4v14h5m5-14 7 7-7 7m-6-7h13",
  clock: "M12 8v4l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  edit: "m16 3 5 5-12 12-6 1 1-6ZM13 6l5 5",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4",
  chart: "M3 3v18h18M7 15l4-5 4 3 6-8",
  settings:
    "M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2",
  wallet: "M3 6V4h16v4H3v12h18V8H3m13 4h5v4h-5z",
  sun: "M12 3v2m0 14v2M3 12h2m14 0h2M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
};
export const icon = (name, cls = "") =>
  `<svg class="icon ${escape(cls)}" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.box}"/></svg>`;
export const brand = () =>
  '<a class="brand" href="/" aria-label="Zentra Store ana sayfa"><img class="brand-image" src="/public/assets/images/apple-touch-icon.png" alt="Zentra Store" width="192" height="192" draggable="false"/><span class="brand-text" aria-hidden="true">ZENTRA STORE<small>DİJİTAL ÜRÜN MAĞAZASI</small></span></a>';
export async function copyText(value) {
  if (!navigator.clipboard?.writeText)
    throw new Error("Bu tarayıcıda güvenli kopyalama kullanılamıyor.");
  await navigator.clipboard.writeText(String(value));
}
export function toast(message, kind = "success") {
  const region = document.getElementById("toasts");
  if (!region) return;
  const node = document.createElement("div");
  node.className = `toast ${kind}`;
  node.setAttribute("role", kind === "error" ? "alert" : "status");
  node.innerHTML = `${icon(kind === "error" ? "shield" : "check")}<span>${escape(message)}</span>`;
  region.append(node);
  setTimeout(() => node.remove(), 6500);
}
export function busy(button, value, label = "İşleniyor…") {
  if (!button) return;
  if (value) {
    button.dataset.oldHtml = button.innerHTML;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.innerHTML = `<span class="spinner" aria-hidden="true"></span>${escape(label)}`;
  } else {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    if (button.dataset.oldHtml) button.innerHTML = button.dataset.oldHtml;
    delete button.dataset.oldHtml;
  }
}
export function modal({
  title,
  body = "",
  submit = "Kaydet",
  danger = false,
  onSubmit,
} = {}) {
  const previous = document.activeElement,
    dlg = document.createElement("dialog"),
    id = `dialog-${crypto.randomUUID()}`;
  dlg.className = "app-dialog";
  dlg.setAttribute("aria-labelledby", id);
  dlg.innerHTML = `<form class="dialog-form"><header><div><span class="eyebrow">ZENTRA STORE</span><h2 id="${id}">${escape(title)}</h2></div><button type="button" class="icon-button" data-close aria-label="Pencereyi kapat">${icon("close")}</button></header><div class="dialog-body">${body}<p class="form-error" role="alert" hidden></p></div><footer><button type="button" class="button secondary" data-close>Vazgeç</button>${onSubmit ? `<button class="button ${danger ? "danger" : "primary"}" type="submit">${escape(submit)}</button>` : ""}</footer></form>`;
  document.body.append(dlg);
  document.documentElement.classList.add("dialog-open");
  dlg.showModal();
  let pending = false;
  const close = () => {
    if (pending) return;
    dlg.close();
    dlg.remove();
    if (!document.querySelector("dialog[open]"))
      document.documentElement.classList.remove("dialog-open");
    previous?.isConnected && previous.focus({ preventScroll: true });
  };
  dlg
    .querySelectorAll("[data-close]")
    .forEach((b) => b.addEventListener("click", close));
  dlg.addEventListener("click", (event) => {
    if (event.target.closest("a[data-nav]")) {
      if (pending) {
        event.preventDefault();
        event.stopPropagation();
      } else close();
    }
  });
  dlg.addEventListener("cancel", (e) => {
    e.preventDefault();
    close();
  });
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) {
      const r = dlg.getBoundingClientRect();
      if (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      )
        close();
    }
  });
  dlg.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (pending || !onSubmit) return;
    pending = true;
    const button = dlg.querySelector("[type=submit]"),
      error = dlg.querySelector(".form-error");
    error.hidden = true;
    busy(button, true);
    try {
      const result = await onSubmit(new FormData(e.target), e.target);
      pending = false;
      if (result !== false) close();
    } catch (err) {
      pending = false;
      error.textContent = err.message || "İşlem tamamlanamadı.";
      error.hidden = false;
      error.tabIndex = -1;
      error.focus();
    } finally {
      busy(button, false);
    }
  });
  return { element: dlg, close };
}
export const empty = (
  title,
  message,
  link = "/magaza",
  label = "Ürünleri keşfet",
) =>
  `<div class="empty-state">${icon("box")}<h2>${escape(title)}</h2><p>${escape(message)}</p>${link ? `<a class="button primary" href="${escape(link)}" data-nav>${escape(label)} ${icon("arrow")}</a>` : ""}</div>`;
export const field = (name, label, type = "text", value = "", extra = "") =>
  `<label class="field"><span>${escape(label)}</span><input name="${escape(name)}" type="${escape(type)}" value="${escape(value)}" ${extra}/></label>`;
export const statusNames = {
  awaiting_payment: "Ödeme bekliyor",
  payment_review: "Ödeme inceleniyor",
  payment_rejected: "Ödeme reddedildi",
  paid: "Ödeme onaylandı",
  processing: "Hazırlanıyor",
  delivery_pending: "Teslimat bekliyor",
  delivered: "Teslim edildi",
  cancelled: "İptal edildi",
  refunded: "İade tamamlandı",
};
export const status = (value) =>
  `<span class="status-pill ${["delivered", "paid"].includes(value) ? "green" : ["cancelled", "payment_rejected"].includes(value) ? "red" : "amber"}">${escape(statusNames[value] || value || "Bekliyor")}</span>`;
export function safeImage(value = "") {
  if (imageVariants[value]) return imageVariants[value];
  return /^\/public\/assets\/[a-zA-Z0-9._/-]+$/.test(value)
    ? value
    : /^https:\/\/firebasestorage\.googleapis\.com\//.test(value)
      ? value
      : "/public/assets/images/zentra-mark.webp";
}
