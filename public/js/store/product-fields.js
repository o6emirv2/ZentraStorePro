import { isPreviewUrl, mediaImageUrl, storageImagePath, storedLocalImage } from './image-path.mjs?v=117';

export function productImagePath(value = '') {
  return storedLocalImage(value) || storageImagePath(value) || (isPreviewUrl(value) ? value : '');
}

export const PRODUCT_IMAGE_PATTERN = { test: value => Boolean(productImagePath(value)) };

export function versionedProductImage(value, version = 'storefront-v113') {
  const source = productImagePath(value);
  if (!source || source.startsWith('https:')) return source;
  return mediaImageUrl(source, version) || source.split('?')[0] + '?v=' + encodeURIComponent(version);
}

export function productFeatures(value = []) {
  const rows = typeof value === 'string' ? value.split(/\r?\n/) : Array.isArray(value) ? value : [];
  return [...new Set(rows.filter((row) => typeof row === 'string')
    .map((row) => row.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/^[✅✔☑•\s-]+/u, '').replace(/\s+/g, ' ').trim())
    .filter((row) => row && row.replace(/[🏆\s]/gu, '').toLocaleLowerCase('tr-TR') !== 'özellikler'))].slice(0, 40).map((row) => row.slice(0, 160));
}
