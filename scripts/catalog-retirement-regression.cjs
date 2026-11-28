"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {applicationFixture} = require("./helpers/application-fixture.cjs");
test("retirement excludes the product, drains eligible stock and keeps delivered inventory and order history",async()=>{
  const f=await applicationFixture();
  try {
    const {retiredId:id,retiredProduct} = require("../server/core/retiredProducts");
    const deletion=require("../server/core/productDeletion");
    const response=await f.request("/api/store/catalog");
    assert.equal(response.status,200);
    assert(!response.body.catalog.products.some(p=>p.id===id));
    assert(retiredProduct("lion_ios"));
    const cfg=f.db.records.get("storefrontSettings/main");
    cfg.catalog.products[id]={};
    f.db.records.set("storefrontSettings/main",cfg);
    const sku=id+"__daily", prefix="storeInventory/"+sku+"/items/";
    f.db.records.set(prefix+"unused",{status:"available",sku});
    f.db.records.set(prefix+"sold",{status:"delivered",orderId:"historic"});
    f.db.records.set("storeOrders/historic",{status:"delivered",items:[{productId:id}]});
    f.db.records.set("storeOrders/open",{status:"processing",items:[{productId:id}]});
    await assert.rejects(deletion.request(id,id,{uid:"owneruid"}),{code:"STORE_DELETE_ACTIVE_ORDERS"});
    f.db.records.delete("storeOrders/open");
    await deletion.request(id,id,{uid:"owneruid"});
    const ref=f.db.collection("storeProductDeletionJobs").doc(id);
    for(let n=0;n<200 && (await ref.get()).exists;n++)await deletion.advance(f.db,ref);
    assert(!(await ref.get()).exists);
    assert(!f.db.records.has(prefix+"unused"));
    assert(f.db.records.has(prefix+"sold"));
    assert(f.db.records.has("storeOrders/historic"));
    assert.equal(f.db.records.get("storefrontSettings/main").catalog.deletedProductIds[id],true);
    assert.equal((await deletion.request(id,id,{uid:"owneruid"})).state,"completed");
  } finally {await f.close();}
});
test("email retry observes provider delays, supports HTTP dates and adds bounded jitter",()=>{
  const {retryDelayMs}=require("../server/email/config");
  const now=Date.UTC(2026,0,1);
  assert.equal(retryDelayMs(1,"120",now,()=>0),120000);
  assert.equal(retryDelayMs(1,new Date(now+7200000).toUTCString(),now,()=>0),7200000);
  assert.equal(retryDelayMs(2,null,now,()=>.5),66000);
});
