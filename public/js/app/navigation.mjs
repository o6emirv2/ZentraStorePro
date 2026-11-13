const accountPaths = new Set([
  "/hesabim",
  "/siparisler",
  "/bildirimler",
  "/kuponlar",
  "/favoriler",
]);
export function authMode(search = "") {
  return new URLSearchParams(search).get("islem") === "kayit"
    ? "register"
    : "login";
}
export function safeReturnTo(value = "") {
  if (
    typeof value !== "string" ||
    value.length > 1024 ||
    !value.startsWith("/") ||
    /[\\\x00-\x20]/.test(value)
  )
    return "";
  try {
    const url = new URL(value, "https://zentra.invalid");
    if (
      url.origin !== "https://zentra.invalid" ||
      !(
        /^\/(?:|magaza|sepet|hesabim|siparisler|bildirimler|kuponlar|favoriler|destek)$/.test(
          url.pathname,
        ) || /^\/(?:kategori|urun)\/[a-z0-9-]{1,80}$/.test(url.pathname)
      )
    )
      return "";
    return url.pathname === "/hesabim" ? "/hesabim" : url.pathname + url.search;
  } catch {
    return "";
  }
}
export function authPath(mode = "login", next = "") {
  const query = new URLSearchParams({
    islem: mode === "register" ? "kayit" : "giris",
  });
  const target = safeReturnTo(next);
  if (target && target !== "/hesabim") query.set("next", target);
  return "/hesabim?" + query;
}
export function navigationModel({
  signedIn = false,
  pathname = "/",
  search = "",
} = {}) {
  signedIn = signedIn === true;
  const path = pathname.replace(/\/+$/, "") || "/";
  const mode = authMode(search);
  const account = accountPaths.has(path);
  const active =
    path === "/"
      ? "home"
      : path === "/sepet"
        ? signedIn
          ? "cart"
          : ""
        : path === "/siparisler" && signedIn
          ? "orders"
          : account
            ? signedIn
              ? "account"
              : mode === "register"
                ? "register"
                : "login"
            : /^\/(?:magaza|kategori|urun)(?:\/|$)/.test(path)
              ? "products"
              : "";
  return {
    signedIn: signedIn === true,
    active,
    header: signedIn ? ["account", "cart"] : ["login", "register"],
    bottom: signedIn
      ? ["home", "products", "cart", "orders", "account"]
      : ["home", "products", "login", "register"],
  };
}
export function syncNavigation(doc, options = {}) {
  const model = navigationModel(options);
  for (const group of doc.querySelectorAll("[data-session-visible]"))
    group.hidden =
      (group.dataset.sessionVisible === "signed") !== model.signedIn;
  const nav = doc.querySelector(".bottom-nav");
  if (nav) nav.dataset.session = model.signedIn ? "signed" : "guest";
  for (const link of doc.querySelectorAll("[data-store-nav]")) {
    const active = link.dataset.storeNav === model.active;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  const value = Number(options.cartCount);
  const count =
    Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1500) : 0;
  for (const node of doc.querySelectorAll("[data-cart-count]"))
    node.textContent = String(count);
  for (const link of doc.querySelectorAll('[data-store-nav="cart"]'))
    link.setAttribute("aria-label", `Sepetim, ${count} ürün`);
  return model;
}
export function measureHeader(doc, view) {
  const header = doc.querySelector(".site-header");
  if (!header || !doc.documentElement?.style) return () => {};
  const measure = () => {
    const height = Math.ceil(header.getBoundingClientRect().height);
    if (height > 0 && height < 1000)
      doc.documentElement.style.setProperty(
        "--store-header-height",
        height + "px",
      );
  };
  measure();
  if (typeof view.ResizeObserver !== "function") return () => {};
  const observer = new view.ResizeObserver(measure);
  observer.observe(header);
  return () => observer.disconnect();
}
