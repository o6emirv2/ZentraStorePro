'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { applicationFixture } = require('./helpers/application-fixture.cjs');
let f, inbox;
before(async () => {
  f = await applicationFixture({rateLimitStore:'memory', transientStore:'memory'});
  inbox = require('../server/core/customerNotificationService');
});
after(async () => f?.close());

test('unread count, paged bulk actions and deletion isolate owners and both storage generations', async () => {
  const owner = 'inbox-owner';
  for (let i = 0; i < 366; i++) {
    const path = (i % 2 ? 'storeNotifications/' : `storeUserNotifications/${owner}/items/`) + 'item' + i;
    f.db.records.set(path, {uid:owner, type:'security', createdAt:1000 + Math.floor(i/5), ...(i < 12 ? {read:i%2===0,readAt:42} : i%3 ? {read:false} : {})});
  }
  f.db.records.set('storeNotifications/other-owner', {uid:'other-inbox-owner',type:'security',createdAt:999,read:false});
  assert.equal((await inbox.summary(owner)).unread, 354);
  const first = await inbox.markAllRead(owner, '');
  assert.ok(first.nextCursor);
  await assert.rejects(()=>inbox.markAllRead('other-inbox-owner', first.nextCursor), {code:'STORE_NOTIFICATION_CURSOR_INVALID'});
  const second = await inbox.markAllRead(owner, first.nextCursor);
  assert.equal(second.complete, true);
  assert.equal(first.changed + second.changed, 354);
  assert.equal((await inbox.summary(owner)).unread, 0);
  f.db.records.set('storeNotifications/arrived', {uid:owner,type:'security',createdAt:2001,readAt:0});
  let cursor = '', changed = 0;
  do { const result = await inbox.deleteRead(owner,cursor); changed += result.changed; cursor = result.nextCursor; } while (cursor);
  assert.equal(changed,366);
  assert.equal((await inbox.deleteRead(owner)).changed,0);
  assert.equal((await inbox.summary(owner)).unread,1);
  assert.equal((await inbox.summary('other-inbox-owner')).unread,1);
  const list = await inbox.list(owner,20,'',{inboxOnly:true});
  assert.deepEqual(list.notifications.map(row=>row.id),['event_arrived']);
  assert.equal('emailDelivery' in list,false);
});

test('preference-filtered unread count covers imported records and pages larger than 300', async () => {
  const uid = 'filtered-owner';
  f.db.records.set('storeCommerceProfiles/'+uid, {preferences:{stockNotifications:false}});
  for (let i=0; i<325; i++) {
    f.db.records.set('storeNotifications/filtered'+i,{uid,type:i%2?'stock':'security',createdAt:i+1,...(i===0?{}:{readAt:0})});
  }
  assert.equal((await inbox.summary(uid)).unread,163);
  await inbox.markRead(uid,'event_filtered0');
  assert.equal((await inbox.summary(uid)).unread,162);
});

test('cart preflight uses the authoritative price, selected SKU, stock quantity and channel', async () => {
  const catalog = require('../server/core/storeCatalog').STORE_CATALOG;
  const product = catalog.products.find(p=>p.id==='kingmod'), plan = product.plans[0];
  const sku = require('../server/core/storeInventoryService').inventoryTarget(catalog,product,plan).sku;
  const path = `/api/store/catalog/${product.id}/plans/${plan.key}?`;
  const check = (price,quantity,channel) => f.request(path+new URLSearchParams({price,quantity,channel}));
  f.db.records.set('storeInventorySummary/'+sku,{availableCount:1});
  const result = await check(plan.priceKurus,1,'automatic');
  assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal(result.body.selection.unitPriceKurus,plan.priceKurus);
  assert.equal((await check(plan.priceKurus,2,'automatic')).status,409);
  assert.equal((await check(plan.priceKurus+1,1,'automatic')).status,409);
  assert.equal((await check(plan.priceKurus,1,'telegram')).status,200);
  assert.equal((await check(plan.priceKurus,0,'telegram')).status,400);
  assert.equal(f.db.records.get('storeInventorySummary/'+sku).availableCount,1);
});

test('category coupons take the product category from the server and exclude other lines', async () => {
  const { previewPromotion } = require('../server/core/storePromotionService');
  const { normalizeCart } = require('../server/core/storeService');
  const catalog = require('../server/core/storeCatalog').STORE_CATALOG;
  const a = catalog.products.find(p=>p.id==='kingmod'), b = catalog.products.find(p=>p.categoryKey!==a.categoryKey);
  const line = p=>({productId:p.id,planKey:p.plans[0].key,quantity:1,categoryKey:a.categoryKey});
  const coupon = {active:true,type:'percent',value:10,categoryKeys:[a.categoryKey]};
  f.db.records.set('storePromotions/SCOPE10',{...coupon,code:'SCOPE10'});
  const preview=items=>previewPromotion({uid:'member',code:'SCOPE10',cart:normalizeCart(items,catalog)});
  await assert.rejects(()=>preview([line(b)]),{code:'STORE_PROMOTION_SCOPE_INVALID'});
  const result = await preview([line(a),line(b)]);
  assert.equal(result.discountKurus,Math.floor(a.plans[0].priceKurus/10));
});

test('duplicate delivery acknowledgment returns the stored timestamp without additional writes', async () => {
  const orders = require('../server/commerce/orders');
  f.db.records.set('storeOrders/ack-one',{uid:'member',status:'delivered',createdAt:1,delivery:{status:'delivered'}});
  const first = await orders.acknowledge('member','ack-one');
  const before = f.db.stats.writes;
  assert.deepEqual(await orders.acknowledge('member','ack-one'),first);
  assert.equal(f.db.stats.writes,before);
  await assert.rejects(()=>orders.acknowledge('viewer','ack-one'));
});

test('bell discards the previous account response, preserves exact counts and respects reduced motion', async () => {
  const {installInboxBell} = await import('../public/js/store/inbox-bell.mjs');
  const view=new EventTarget(), doc=new EventTarget(), requests=[], classes=new Set();
  const badge={hidden:true,textContent:'',classList:{toggle(){}}};
  let label='', owner='', animations=0;
  const icon={animate(){animations++;},getAnimations:()=>[]};
  const button={querySelector:selector=>selector==='i'?icon:badge,setAttribute:(name,value)=>{if(name==='aria-label')label=value;},
    classList:{toggle:(key,on)=>on?classes.add(key):classes.delete(key)}};
  view.matchMedia=()=>({matches:true});view.setTimeout=setTimeout;
  const channel=global.BroadcastChannel;
  global.BroadcastChannel=class extends EventTarget { postMessage(){} };
  let change;
  try {
    change=installInboxBell(button,{view,doc,readUid:()=>owner,api:(url,{signal})=>new Promise(resolve=>requests.push({url,signal,resolve}))});
    owner='first'; change(owner); owner='second'; change(owner);
    assert.equal(requests[0].signal.aborted,true);
    requests[1].resolve({unread:132}); await new Promise(setImmediate);
    requests[0].resolve({unread:2}); await new Promise(setImmediate);
    assert.equal(badge.textContent,'132');assert.match(label,/132/);assert.equal(animations,0);
    doc.hidden=true;doc.dispatchEvent(new Event('visibilitychange'));
    view.dispatchEvent(new Event('zentra:inbox-change')); assert.equal(requests.length,2);
    doc.hidden=false;doc.dispatchEvent(new Event('visibilitychange'));
    requests[2].resolve({unread:0});await new Promise(setImmediate);
    assert.equal(badge.hidden,true);assert.equal(classes.has('has-unread'),false);
  } finally { owner='';change?.(owner);global.BroadcastChannel=channel; }
});
