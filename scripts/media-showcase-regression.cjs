'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { applicationFixture } = require('./helpers/application-fixture.cjs');
const { browserModule } = require('./helpers/browser-module.cjs');
const cover = '/public/assets/products/ESign.WEBP';
const gallery = Array.from({ length: 7 }, (_, i) => '/public/assets/products/gallery/ultıma/menu-0' + (i + 1) + '.png');
const row = (image, enabled = true) => ({ image, enabled, title: 'Vitrin görseli', productId: '' });
let app, owner, media;
before(async () => {
  app = await applicationFixture();
  owner = await app.openAdmin();
  media = await browserModule('public/js/store/product-media.js');
});
after(async () => app?.close());

test('all eight original repository files are delivered byte-for-byte by the shipping server', async () => {
  for (const source of [cover, ...gallery]) {
    const response = await fetch(app.origin + source);
    assert.equal(response.status, 200, source);
    assert.match(response.headers.get('content-type'), /^image\/(png|webp)/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), fs.readFileSync(path.join(__dirname, '..', source)));
  }
});

test('a missing Turkish gallery asset records a diagnostic without accepting URL secrets', async () => {
  const report = source => app.request('/api/client-errors', { method: 'POST', body: { code: 'BROWSER_ASSET_FAILED', source, line: 0, column: 0 } });
  assert.equal((await report(encodeURI(gallery[1]))).status, 202);
  assert.equal((await report(gallery[1] + '?token=private')).status, 400);
});

test('asset reads preserve exact spelling, unique case variants, thumbnails, and validated Storage queries', async () => {
  const images = require('../public/js/store/image-path.mjs');
  assert.equal(images.repositorySourcePath('/assets/products/esign.webp'), cover);
  assert.equal(images.repositorySourcePath(encodeURI(gallery[0])), gallery[0]);
  const stored = 'https://firebasestorage.googleapis.com/v0/b/images.firebasestorage.app/o/store-product-images%2Faaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg?token=bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb&alt=media';
  assert.equal(images.storageImagePath(stored, 'images.firebasestorage.app'), stored);
  assert.equal(images.storageImagePath(stored, 'other.bucket'), '');
  assert.equal(images.storageImagePath(stored + '&alt=media'), '');
  const rows = media.getProductMedia({ image: cover, galleryPaths: [gallery[1], '/public/scripts/a.js', gallery[0], gallery[1], stored] });
  assert.deepEqual(rows.map(item => item.src.split('?')[0]), [gallery[1], gallery[0], stored.split('?')[0]]);
  assert.deepEqual(media.productCoverSources({ image: '', galleryPaths: [gallery[0]] }).map(url => url.split('?')[0]), [gallery[0]]);
});

test('a missing old gallery file cannot remove an otherwise valid stored product', () => {
  const { readCustomProducts, normalizeCreatedProduct } = require('../server/core/storeProductCreation');
  const product = { id: 'esign-legacy', name: 'ESign', categoryKey: 'gbox-iphone', description: 'Yıllık paket açıklaması.',
    platform: 'ios', game: 'gbox', inventoryType: 'license', fulfillmentMode: 'telegram_only', image: cover,
    galleryPaths: [cover, '/public/assets/products/missing-legacy.png', '/public/config.js'],
    plans: [{ key: 'year', label: 'Yıllık', duration: '12 ay', priceKurus: 80000 }] };
  assert.throws(() => normalizeCreatedProduct(product), { code: 'STORE_GALLERY_PATH_INVALID' });
  const [old] = readCustomProducts({ [product.id]: product });
  assert.equal(old.id, product.id);
  assert.equal(old.image, cover);
  assert.deepEqual(old.galleryPaths, product.galleryPaths.slice(0, 2));
});

test('owner publishing is ordered, filters hidden rows, rejects stale revisions, and supports an empty slider', async () => {
  const endpoint = '/api/admin/store/content';
  const patch = expected => app.adminWrite(owner, endpoint, 'PATCH', expected);
  const published = async () => (await app.request('/api/store/catalog')).body.catalog.storefront;
  assert.equal((await published()).showcaseSlides, undefined);
  const slides = [row(gallery[3]), row(cover, false), row(gallery[0])];
  assert.equal((await app.request(endpoint, { method: 'PATCH', uid: 'member', body: { expectedShowcaseRevision: 0, showcaseSlides: slides } })).status >= 400, true);
  const result = await patch({ expectedShowcaseRevision: 0, showcaseSlides: slides });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.storefront.showcaseSlides, slides);
  assert.deepEqual((await published()).showcaseSlides, [slides[0], slides[2]]);
  assert.equal((await patch({ expectedShowcaseRevision: 0, showcaseSlides: [] })).status, 409);
  assert.equal((await patch({ maintenance: true })).status, 200);
  assert.deepEqual((await published()).showcaseSlides, [slides[0], slides[2]]);
  assert.equal((await patch({ expectedShowcaseRevision: 1, showcaseSlides: [row('/public/assets/products/missing.png')] })).status, 400);
  assert.equal((await patch({ expectedShowcaseRevision: 1, showcaseSlides: [row(cover), row('/assets/products/esign.webp')] })).status, 400);
  assert.equal((await patch({ expectedShowcaseRevision: 1, showcaseSlides: [] })).status, 200);
  assert.deepEqual((await published()).showcaseSlides, []);
});
