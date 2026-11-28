'use strict';

const env = require('../config/env');
const { retiredProduct } = require('./retiredProducts');
const { productCategory, normalizeFeatures } = require('./storeProductSchema');
const { GAME_KEYS, normalizeProductId, validProductId } = require('../../public/js/store/catalog-schema.mjs');
const { normalizeBadgeKey, resolveBadge } = require('./storeBadgeCatalog');

const { CARD_STYLES, GALLERY_LIMIT, galleryPath } = require('../../public/js/store/card-appearance.mjs');
function validateAppearance(input, previousGallery = []) {
  const style = input.cardStyle ?? 'classic';
  if (!Object.hasOwn(CARD_STYLES, style)) throw failure('STORE_CARD_STYLE_INVALID');
  if(input.premiumAnimation!==undefined && typeof input.premiumAnimation!=='boolean')throw failure('STORE_CARD_STYLE_INVALID');
  if(input.featuredBadgeText!==undefined && (typeof input.featuredBadgeText!=='string' || input.featuredBadgeText.length>40 || /[<>\x00-\x1f]/.test(input.featuredBadgeText)))throw failure('STORE_CARD_STYLE_INVALID');
  const appearance={premiumAnimation:input.premiumAnimation!==false,featuredBadgeText:input.featuredBadgeText?.trim() || 'ÖNE ÇIKAN ÜRÜN'};
  if (input.galleryPaths === undefined) return { cardStyle: style, ...appearance };
  if (!Array.isArray(input.galleryPaths) || input.galleryPaths.length > GALLERY_LIMIT) throw failure('STORE_GALLERY_LIMIT');
  const paths = input.galleryPaths.map(galleryPath);
  const retained = new Set(Array.isArray(previousGallery) ? previousGallery.map(path => productImage(path, '')).filter(Boolean) : []);
  if (paths.some(p => !p || (!retained.has(p) && !isValidProductImage(p)))) throw failure('STORE_GALLERY_PATH_INVALID');
  if (new Set(paths).size !== paths.length) throw failure('STORE_GALLERY_DUPLICATE');
  return { cardStyle: style, ...appearance, galleryPaths: paths };
}
const PLAN_ID = /^[a-z][a-z0-9-]{0,39}$/;
const { localImagePath, repositorySourcePath, storageImagePath, storedLocalImage } = require('../../public/js/store/image-path.mjs');
const DEFAULT_IMAGE = '/public/assets/images/zentra-mark.webp';
const MAX_CUSTOM_PRODUCTS = 80;

function failure(code, statusCode = 400) {
  return Object.assign(new Error(code), { code, statusCode });
}

function safeText(value, max = 80) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
}

function isValidProductImage(value) {
  if (typeof value !== 'string' || value.length > 500) return false;
  const local = localImagePath(value);
  if (local) return repositorySourcePath(local) === local;
  return Boolean(storageImagePath(value, String(env.firebase.storageBucket || '')));
}

function productImage(value = '', fallback = DEFAULT_IMAGE) {
  return storedLocalImage(value) || storageImagePath(value, String(env.firebase.storageBucket || '')) || fallback;
}

function normalizeCreatedProduct(value, { stored = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('STORE_PRODUCT_CREATE_INVALID');
  const id = normalizeProductId(value.id);
  if (retiredProduct(id) || (value.game === 'pubg' && retiredProduct(id, value.name, value.platform))) throw failure('STORE_PRODUCT_ID_INVALID');
  if (!validProductId(id)) throw failure('STORE_PRODUCT_ID_INVALID');
  const name = safeText(value.name, 80);
  const description = safeText(value.description, 240);
  if (name.length < 3 || description.length < 8) throw failure('STORE_PRODUCT_DETAILS_REQUIRED');
  if (!['android', 'ios'].includes(value.platform)) throw failure('STORE_PRODUCT_PLATFORM_INVALID');
  if (!GAME_KEYS.includes(value.game)) throw failure('STORE_PRODUCT_GAME_INVALID');
  if (!['license', 'account'].includes(value.inventoryType)) throw failure('STORE_PRODUCT_INVENTORY_TYPE_INVALID');
  if (!['automatic', 'telegram_only'].includes(value.fulfillmentMode)) throw failure('STORE_PRODUCT_FULFILLMENT_INVALID');
  const suppliedImage = typeof value.image === 'string' ? value.image.trim() : '';
  if (value.image !== undefined && typeof value.image !== 'string') throw failure('STORE_PRODUCT_IMAGE_INVALID');
  if (!stored && suppliedImage && !isValidProductImage(suppliedImage)) throw failure('STORE_PRODUCT_IMAGE_INVALID');
  if (!Array.isArray(value.plans) || value.plans.length < 1 || value.plans.length > 12) throw failure('STORE_PRODUCT_PLANS_INVALID');
  const seen = new Set();
  const plans = value.plans.map((entry) => {
    const key = normalizeProductId(entry?.key);
    const priceKurus = Number(entry?.priceKurus);
    if (!PLAN_ID.test(key) || seen.has(key) || !Number.isSafeInteger(priceKurus) || priceKurus < 1 || priceKurus > 100_000_000) {
      throw failure('STORE_PRODUCT_PLAN_INVALID');
    }
    seen.add(key);
    const label = safeText(entry.label, 50);
    const duration = safeText(entry.duration, 50);
    if (!label || !duration) throw failure('STORE_PRODUCT_PLAN_DETAILS_REQUIRED');
    return { key, label, duration, priceKurus };
  });
  if (value.sortOrder !== undefined && (!Number.isSafeInteger(value.sortOrder) || value.sortOrder < 0 || value.sortOrder > 10000)) throw failure('STORE_PRODUCT_SORT_INVALID');
  const badgeKey = normalizeBadgeKey(value.badgeKey || 'premium');
  if (!badgeKey) throw failure('STORE_PRODUCT_BADGE_INVALID');
  const badge = resolveBadge({ badgeKey });
  const category = productCategory(value, {}, { creating: true });
  if (category.platform !== value.platform || category.game !== value.game) throw failure('STORE_PRODUCT_CATEGORY_CONFLICT');
  return {
    id,
    name,
    description,
    features: normalizeFeatures(value.features === undefined ? [] : value.features, { strict: true }),
    platform: value.platform,
    game: value.game,
    inventoryType: value.inventoryType,
    inventoryPoolId: '',
    fulfillmentMode: value.fulfillmentMode,
    ...category,
    badgeKey: badge.key,
    badge: badge.label,
    badgeIcon: badge.icon,
    badgeTone: badge.tone,
    icon: 'fa-box',
    image: productImage(suppliedImage),
    accent: '55,165,255',
    ...validateAppearance(stored ? { ...value, galleryPaths: undefined } : value),
    ...(stored && Array.isArray(value.galleryPaths) ? {
      galleryPaths: [...new Set(value.galleryPaths.map(path => productImage(path, '')).filter(Boolean))].slice(0, GALLERY_LIMIT)
    } : {}),
    featured: value.featured === true,
    sortOrder: value.sortOrder ?? 500,
    tags: [],
    plans,
    custom: true
  };
}

function readCustomProducts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, source]) => {
    try {
      const product = normalizeCreatedProduct({ ...source, image: productImage(source?.image), features: normalizeFeatures(source?.features || []) }, { stored: true });
      return product.id === key ? [product] : [];
    } catch (_) { return []; }
  });
}

module.exports = { validateAppearance, MAX_CUSTOM_PRODUCTS, normalizeCreatedProduct, readCustomProducts, isValidProductImage, productImage };
