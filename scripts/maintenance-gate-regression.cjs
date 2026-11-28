"use strict";
const {test, before, after} = require("node:test");
const assert = require("node:assert/strict");
const {applicationFixture} = require("./helpers/application-fixture.cjs");
let f; before(async () => {f = await applicationFixture();}); after(async () => {await f?.close();});

test("public status works with App Check enforcement and returns no private settings", async t => {
  const response = await fetch(f.origin + "/api/store/status");
  assert.equal(response.status,200);
  assert.match(response.headers.get("cache-control"),/no-store/);
  const result = await response.json();
  assert.deepEqual(Object.keys(result).sort(),["checkedAt","maintenance","message","ok"]);
  assert.equal(result.maintenance,false);
});

test("admin maintenance blocks customer writes, stays observable, and can be disabled", async t => {
  const admin = await f.openAdmin();
  const on = await f.adminWrite(admin,"/api/admin/store/content","PATCH",{maintenance:true});
  assert.equal(on.status,200);
  assert.equal((await fetch(f.origin+"/api/store/status").then(r=>r.json())).maintenance,true);
  const blocked = await f.request("/api/store/balance-codes/redeem",{token:f.idToken("member"),method:"POST",body:{code:"EXAMPLE"}});
  assert.equal(blocked.status,503); assert.equal(blocked.body.error,"STORE_MAINTENANCE_ACTIVE");
  const off = await f.adminWrite(admin,"/api/admin/store/content","PATCH",{maintenance:false});
  assert.equal(off.status,200);
  assert.equal((await fetch(f.origin+"/api/store/status").then(r=>r.json())).maintenance,false);
  const customer = await f.request("/api/store/account",{token:f.idToken("member")});
  assert.equal(customer.status,200);
});

test("all account routes use the index document and old recovery pages redirect", async t => {
  for (const route of ["/","/hesabim","/bildirimler","/bildirim-tercihleri","/cihazlarim","/hesap-merkezi","/destek","/promosyonlar","/eposta-dogrula"]) {
    const response = await fetch(f.origin+route); assert.equal(response.status,200,route);
    const html = await response.text();
    assert(html.includes('id="accountHub"'),route); assert(html.includes('id="maintenanceGate"'),route);
    assert(!html.includes('/public/js/app/store.js'),route);
    assert(html.includes('initial-scale=0.85, minimum-scale=0.85, maximum-scale=0.85'),route);
  }
  for(const route of ["/sifre-yenile.html","/store-pages.html"]){
    const r=await fetch(f.origin+route,{redirect:"manual"});assert.equal(r.status,302);assert.equal(r.headers.get("location"),"/");
  }
});

test("account link parsing rejects external destinations and resolves the eight embedded screens", async () => {
  const {accountRoute} = await import("../public/js/store/account-routes.mjs");
  const origin="https://zentrastore.com.tr";
  const expected = {"/bildirimler":"notifications","/hesabim?bolum=preferences":"preferences","/hesabim?bolum=sessions":"devices","/hesap-merkezi":"security","/destek":"support","/promosyonlar":"promotions","/hesabim?islem=dogrula":"verification",["/#recovery="+"a".repeat(43)]:"reset"};
  for(const [route,view] of Object.entries(expected)) assert.equal(accountRoute(origin+route).view,view);
  for(const target of ["https://evil.invalid/hesabim","//evil.invalid/hesabim","/\\evil.invalid/hesabim"])
    assert.equal(accountRoute(origin+"/?devam="+encodeURIComponent(target)),null);
});
