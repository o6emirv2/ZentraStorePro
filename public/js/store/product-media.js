import { renditions } from '../../data/image-renditions.mjs?v=117';
import { PRODUCT_IMAGE_PATTERN, productImagePath, versionedProductImage } from './product-fields.js?v=117';
const PRODUCT_ASSET_ROOT = '/public/assets/products';
const MEDIA_VERSION = 'storefront-v68';
const EMPTY_MEDIA = Object.freeze([]);

export const PRODUCT_MEDIA_SOURCE_PATTERN = { test: (value) => PRODUCT_IMAGE_PATTERN.test(value) || Boolean(productImagePath(value)) };

function versionedMediaPath(path) {
  return `${path}?v=${MEDIA_VERSION}`;
}

function numberedGameMedia(key, label, count) {
  return Array.from({ length: count }, (_, index) => Object.freeze({
    src: versionedMediaPath(`${PRODUCT_ASSET_ROOT}/gallery/${key}/game-${String(index + 1).padStart(2, '0')}.jpeg`),
    alt: `${label} oyun görseli ${index + 1}`,
    kind: 'game'
  }));
}

function mediaGroup({ key, label, productIds, gameCount }) {
  const logo = Object.freeze({
    src: versionedMediaPath(`${PRODUCT_ASSET_ROOT}/${key}.jpeg`),
    alt: `${label} yazılı ürün görseli`,
    kind: 'logo'
  });
  return Object.freeze({
    key,
    label,
    productIds: Object.freeze([...productIds]),
    images: Object.freeze([logo, ...numberedGameMedia(key, label, gameCount)])
  });
}

export const PRODUCT_MEDIA_GROUPS = Object.freeze([
  mediaGroup({ key: 'kingmod', label: 'KİNGMOD', productIds: ['kingmod', 'android-kingmod', 'ios-kingmod'], gameCount: 9 }),
  mediaGroup({ key: 'star', label: 'STAR', productIds: ['ios-star'], gameCount: 9 }),
  mediaGroup({ key: 'oasis', label: 'OASİS', productIds: ['ios-oasis'], gameCount: 4 }),
  mediaGroup({ key: 'contra-hax', label: 'CONTRAHAX', productIds: ['contra-hax', 'android-contra-hax', 'contra-hax-ios'], gameCount: 7 }),
  mediaGroup({ key: 'zolo', label: 'ZOLO', productIds: ['zolo', 'android-zolo'], gameCount: 5 }),
  mediaGroup({ key: 'moon', label: 'MOON', productIds: ['moon', 'android-moon'], gameCount: 6 }),
  mediaGroup({ key: 'dolphin', label: 'DelphinİOS', productIds: ['ios-dolphin'], gameCount: 5 })
]);

const PRODUCT_MEDIA_BY_ID = new Map(
  PRODUCT_MEDIA_GROUPS.flatMap((group) => group.productIds.map((productId) => [productId, group.images]))
);

export const SHOWCASE_MEDIA = Object.freeze(PRODUCT_MEDIA_GROUPS.flatMap((group) => (
  [...group.images.slice(1), group.images[0]].map((image, groupIndex) => Object.freeze({
    ...image,
    groupKey: group.key,
    groupLabel: group.label,
    groupIndex,
    groupTotal: group.images.length
  }))
)));

export function getProductMedia(product = {}) {
  if (Array.isArray(product.galleryPaths)) {
    const sources = [...new Set(product.galleryPaths.map(path => versionedProductImage(path)).filter(Boolean))];
    if (sources.length) return sources.map((src, index) => ({
      src, alt: `${product.name || 'Ürün'} görseli ${index + 1}`, kind: 'game'
    }));
    const primary = versionedProductImage(product.image);
    return primary ? [{src: primary, alt: (product.name || 'Ürün') + ' kapak görseli', kind: 'logo'}] : EMPTY_MEDIA;
  }
  const configured = PRODUCT_MEDIA_BY_ID.get(String(product.id || '').trim()) || EMPTY_MEDIA;
  const source = versionedProductImage(product.image);
  if (!source) return configured;
  const primary = Object.freeze({ src: source, alt: `${String(product.name || 'Ürün')} ürün görseli`, kind: 'logo' });
  return Object.freeze([primary, ...configured.filter((item) => item.kind !== 'logo')]);
}

export function productCoverSources(product = {}) {
  const sources = [product.image, ...(Array.isArray(product.galleryPaths) ? product.galleryPaths : [])];
  return [...new Set(sources.map(source => versionedProductImage(source)).filter(Boolean))];
}

const showcaseByImage = new Map(SHOWCASE_MEDIA.map(item => [item.src.split('?')[0], item]));

export function defaultShowcaseRows() {
  return SHOWCASE_MEDIA.map(item => ({
    image: item.src.split('?')[0], title: item.groupLabel, productId: '', enabled: true
  }));
}

export function configuredShowcaseMedia(rows) {
  if (!Array.isArray(rows)) return SHOWCASE_MEDIA;
  const visible = rows.filter(row => row?.enabled === true).map(row => {
    const src = versionedProductImage(row.image);
    if (!src) return null;
    const original = showcaseByImage.get(row.image);
    const title = row.title || original?.groupLabel || row.image.split('/').pop().split('?')[0];
    return {
      src, alt: row.title || original?.alt || title, title, kind: original?.kind || 'game',
      productId: row.productId || '', groupKey: row.productId || original?.groupKey || title,
      groupLabel: title, defaultGroup: original?.groupKey || ''
    };
  }).filter(Boolean);
  return visible;
}

export function imageRenditions(source) {
  try {
    const path = decodeURIComponent(source.split('?')[0]).normalize('NFC');
    return Object.hasOwn(renditions, path) ? renditions[path] : null;
  } catch {
    return null;
  }
}
