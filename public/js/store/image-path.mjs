import { repositoryImages } from "../../data/repository-images.mjs?v=117";

export function localImagePath(value, { query = false } = {}) {
  if (typeof value !== "string" || value.length > 1200) return "";
  const raw = value
    .trim()
    .replace(/^public\//, "/public/")
    .replace(/^\/assets\//, "/public/assets/");
  const match = /^([^?#]+)(?:\?v=([a-zA-Z0-9._-]{1,48}))?$/.exec(raw);
  if (!match || (match[2] && !query)) return "";
  let path;
  try {
    path = decodeURIComponent(match[1]).normalize("NFC");
  } catch {
    return "";
  }
  if (
    !path.startsWith("/public/") || path.startsWith("/public/gallery-previews/") ||
    /[\\\x00-\x1f\x7f<>?#%]/.test(path)
  )
    return "";
  if (
    path
      .slice(1)
      .split("/")
      .some((part) => !part || part.startsWith("."))
  )
    return "";
  return path + (match[2] ? "?v=" + match[2] : "");
}

const sourceBySpelling = new Map();
for (const path of Object.keys(repositoryImages)) {
  const key = path.normalize("NFC").toLowerCase();
  sourceBySpelling.set(key, sourceBySpelling.has(key) ? "" : path);
}

export function repositorySourcePath(value) {
  const path = localImagePath(value, { query: true }).split("?")[0];
  return Object.hasOwn(repositoryImages, path) ? path : sourceBySpelling.get(path.toLowerCase()) || "";
}

export function repositoryImagePath(value) {
  const path = repositorySourcePath(value);
  const served =
    Object.hasOwn(repositoryImages, path) && repositoryImages[path];
  return served || "";
}

// Deployed storefronts can receive newer catalog records before their image index refreshes.
export function storedLocalImage(value) {
  const path = localImagePath(value, { query: true }).split("?")[0];
  const known = repositorySourcePath(path);
  if (known) return known;
  return path.startsWith("/public/assets/") && /\.(?:jpe?g|jfif|png|webp|gif|avif|bmp|ico)$/i.test(path) ? path : "";
}

export function storageImagePath(value, bucket) {
  if (typeof value !== "string" || value.length > 500 || !value.startsWith("https://firebasestorage.googleapis.com/")) return "";
  try {
    const url = new URL(value);
    const match = /^\/v0\/b\/([a-z0-9.-]+)\/o\/store-product-images%2F[a-f0-9-]{36}\.(?:png|jpe?g|webp)$/i.exec(url.pathname);
    if (!match || (bucket !== undefined && match[1] !== bucket) || url.hash ||
        url.searchParams.size !== 2 || url.searchParams.get("alt") !== "media" ||
        !/^[a-f0-9-]{36}$/i.test(url.searchParams.get("token") || "")) return "";
    return url.href;
  } catch {
    return "";
  }
}

export function mediaImageUrl(value, version = "storefront-v113") {
  const served = repositoryImagePath(value);
  return served ? served + "?v=" + encodeURIComponent(version) : "";
}

export function isPreviewUrl(value) {
  return /^\/public\/gallery-previews\/[a-f0-9]{64}\.png(?:\?v=[a-zA-Z0-9._-]{1,48})?$/.test(
    value,
  );
}
