"use strict";
const {test,before,after}=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const {applicationFixture}=require("./helpers/application-fixture.cjs");
let f,adminSession;before(async()=>{f=await applicationFixture({appCheckMode:"off"});});after(async()=>{await f?.close();});
test("selected session revocation rejects its previous bearer even without a device marker",async()=>{
  const token=f.idToken("member"),decoded=await f.auth.verifyIdToken(token,true);
  f.db.records.set("storeCustomerSessions/revoke-test",{uid:"member",deviceId:"test",label:"Test",authTime:decoded.auth_time*1000,lastSeenAt:Date.now(),createdAt:Date.now(),revokedAt:0});
  const result=await require("../server/commerce/account").revokeSessions("member",{mode:"selected",sessionId:"revoke-test"},{user:decoded});
  assert.equal(result.count,1);
  const response=await f.request("/api/store/account",{token});assert.equal(response.status,401);
  const other=await f.request("/api/store/account",{token:f.idToken("finance")});assert.equal(other.status,200);
  f.db.records.delete("storeCustomerAuthRevocations/"+require("../server/core/customerSessionAccess").key("member",decoded.auth_time*1000));
});
test("a foreign selected-session identifier cannot revoke any session",async()=>{
  f.db.records.set("storeCustomerSessions/foreign",{uid:"finance",deviceId:"foreign",authTime:1000,revokedAt:0});
  await assert.rejects(()=>require("../server/commerce/account").revokeSessions("member",{mode:"selected",sessionId:"foreign"}),e=>e.code==="COMMERCE_SESSION_NOT_FOUND");
  assert.equal(f.db.records.get("storeCustomerSessions/foreign").revokedAt,0);
});
test("support creation without an order, category, closure and reopening persist with revision checks",async()=>{
  const api=require("../server/commerce/support"),input={subject:"Genel destek",message:"Siparişsiz talep",category:"technical",idempotencyKey:crypto.randomUUID()};
  const ticket=await api.create("member",input);assert.equal(ticket.orderId,"");assert.equal(ticket.category,"technical");
  assert.equal((await api.create("member",input)).id,ticket.id);
  await assert.rejects(()=>api.get("finance",ticket.id),e=>e.code==="COMMERCE_TICKET_NOT_FOUND");
  const closed=await api.setTicketState("member",ticket.id,{status:"resolved",expectedRevision:ticket.revision});assert.equal(closed.status,"resolved");
  await assert.rejects(()=>api.setTicketState("member",ticket.id,{status:"open",expectedRevision:ticket.revision}),e=>e.code==="COMMERCE_REVISION_CONFLICT");
  const opened=await api.setTicketState("member",ticket.id,{status:"open",expectedRevision:closed.revision});assert.equal(opened.status,"open");
});
test("support attachments validate size, signatures, MIME, ownership and repeated uploads",async()=>{
  const support=require("../server/commerce/support"),files=require("../server/commerce/supportFiles");
  const ticket=await support.create("member",{subject:"Ek testi",message:"Dosya",idempotencyKey:crypto.randomUUID()});
  const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII=","base64"),objects=new Map();
  const storage=()=>({file:name=>({save:async bytes=>objects.set(name,Buffer.from(bytes)),download:async()=>[objects.get(name)]})});
  const input={name:"ek.png",contentType:"image/png",data:png.toString("base64"),idempotencyKey:crypto.randomUUID()};
  const first=await files.upload("member",ticket.id,input,{storage});assert.equal((await files.upload("member",ticket.id,input,{storage})).id,first.id);assert.equal(objects.size,1);
  assert((await files.download("member",first.id,{storage})).bytes.equals(png));
  await assert.rejects(()=>files.download("finance",first.id,{storage}),e=>e.code==="SUPPORT_FILE_NOT_FOUND");
  assert.throws(()=>files.validate({...input,contentType:"application/pdf"}),e=>e.code==="SUPPORT_FILE_TYPE_MISMATCH");
  assert.throws(()=>files.validate({...input,data:Buffer.alloc(files.MAX_BYTES+1).toString("base64")}),e=>e.code==="SUPPORT_FILE_INVALID");
  assert.throws(()=>files.validate({...input,name:"../private.png"}));
});
test("the 37 notification templates have safe destinations and all requested template variables are accepted",()=>{
  const {EVENTS,destination}=require("../server/core/notificationEvents"),editor=require("../server/email/editor");
  assert.equal(Object.keys(EVENTS).length,37);
  const { safeStorePath } = require("../public/js/app/routes.mjs");
  for(const type of Object.keys(EVENTS)) assert.equal(safeStorePath(destination(type)), destination(type));
  assert.equal(destination("order_created", {orderId:"a&b"}), "/siparisler?order=a%26b");
  assert.equal(destination("support_replied", {ticketId:"b&c"}), "/destek?ticket=b%26c");
  assert.equal(destination("new_device"), "/cihazlarim");
  assert.deepEqual(Object.keys(EVENTS).sort(), [...require("../server/core/notificationPresentation").types].sort());
  for(const variable of ["kullanici_adi","urun_adi","siparis_no","tarih","saat","bakiye","indirim_orani","kupon_kodu","promosyon_kodu"])
    assert.equal(editor.normalize({subject:"{"+variable+"}",intro:"",label:""}).subject,"{"+variable+"}");
  assert.throws(()=>editor.normalize({subject:"{unknown_variable}",intro:"",label:""}));
  assert.throws(()=>editor.normalize({subject:"<script>x</script>",intro:"",label:""}));
});

test("wallet requests do not credit funds until a finance-approved transaction and cannot credit twice",async()=>{
  const service=require("../server/commerce/walletRequests"),old=f.db.records.get("users/member").storeBalanceKurus;
  const result=await f.request("/api/store/commerce/wallet-requests",{token:f.idToken("member"),method:"POST",body:{amountKurus:12345,reference:"İzole ödeme referansı",idempotencyKey:crypto.randomUUID()}});
  assert.equal(result.status,200);const row=result.body.result;assert.equal(f.db.records.get("users/member").storeBalanceKurus,old);
  await assert.rejects(()=>service.decide(row.id,{expectedRevision:1,decision:"approved",paymentReference:"BANK-UNIQUE"},{uid:"member",financialPermission:false}),e=>e.code==="STORE_PERMISSION_DENIED");
  const admin=adminSession || await f.openAdmin();adminSession=admin;const path="/api/admin/store/commerce/wallet-requests/"+row.id+"/decision",body={expectedRevision:1,decision:"approved",paymentReference:"BANK-UNIQUE"};
  assert.equal((await f.adminWrite(admin,path,"POST",body)).status,200);
  assert.equal(f.db.records.get("users/member").storeBalanceKurus,old+12345);
  assert.equal((await f.adminWrite(admin,path,"POST",body)).status,200);
  assert.equal(f.db.records.get("users/member").storeBalanceKurus,old+12345);
  const second=await service.create("member",{amountKurus:100,reference:"İkinci talep",idempotencyKey:crypto.randomUUID()});
  await assert.rejects(()=>service.decide(second.id,{expectedRevision:1,decision:"approved",paymentReference:"BANK-UNIQUE"},{uid:"owneruid",financialPermission:true}),e=>e.code==="WALLET_PAYMENT_REFERENCE_USED");
  const rejected=await service.decide(second.id,{expectedRevision:1,decision:"rejected",paymentReference:""},{uid:"owneruid",financialPermission:true});assert.equal(rejected.status,"rejected");
  assert.equal(f.db.records.get("users/member").storeBalanceKurus,old+12345);
});

test("system announcements honor campaign channel preferences and cancel superseded jobs",async()=>{
  const service=require("../server/core/systemAnnouncements"),event={enabled:true,title:"Test duyurusu",message:"Kampanya testi"};
  const a=f.db.records.get("storeCommerceProfiles/member") || {};
  f.db.records.set("storeCommerceProfiles/member",{...a,preferences:{...(a.preferences || {}),campaignNotifications:true,emailCampaignNotifications:false}});
  f.db.records.set("storefrontSettings/main",{...(f.db.records.get("storefrontSettings/main") || {}),announcement:event});
  await f.db.runTransaction(async tx=>service.schedule(tx,f.db,event,{}));
  assert.equal(await service.run(),1);
  const events=[...f.db.records.values()].filter(x=>x.uid==="member"&&x.templateType==="system_announcement");assert.equal(events.length,1);
  await f.db.runTransaction(async tx=>service.schedule(tx,f.db,{...event,message:"Eski içerik"},{}));
  await service.run();assert([...f.db.records.values()].some(x=>x.state==="cancelled"&&x.fingerprint));
});

test("notification pages preserve same-time records across both sources and bind cursors to the owner",async()=>{
  const service=require("../server/core/customerNotificationService"),now=Date.now()+10000;
  for(let i=0;i<75;i++)for(const legacy of [false,true]){
    const id='page'+String(i).padStart(3,'0');f.db.records.set(legacy?'storeUserNotifications/member/items/'+id:'storeNotifications/'+id,{uid:'member',type:'security',title:id,message:'Sayfalama testi',createdAt:now,readAt:0});
  }
  let cursor='',ids=new Set(),pages=0;
  do{const result=await service.list('member',10,cursor);for(const row of result.notifications){assert(!ids.has(row.id),row.id);ids.add(row.id);}cursor=result.nextCursor;pages++;assert(pages<30);}while(cursor);
  assert.equal([...ids].filter(id=>id.includes('page')).length,150);
  const first=await service.list('member',10);await assert.rejects(()=>service.list('finance',10,first.nextCursor),e=>e.code==='STORE_NOTIFICATION_CURSOR_INVALID');
  const read=await service.markAllRead('member');assert.equal(read.complete,true);assert((await service.list('member',10)).notifications.every(row=>row.readAt>0));
});

test("revoking a device covers its earlier tokens while another same-second login stays valid",async()=>{
  const service=require('../server/commerce/account'),access=require('../server/core/customerSessionAccess'),time=Math.floor(Date.now()/1000);
  const a='a'.repeat(32),b='b'.repeat(32),c='c'.repeat(32),phone=f.idToken('member',time,{zentraSessionId:a}),desktop=f.idToken('member',time,{zentraSessionId:b}),prior=f.idToken('member',time-20,{zentraSessionId:c});
  const desktopUser=await f.auth.verifyIdToken(desktop,true);
  f.db.records.set('storeCustomerSessions/phone-current',{uid:'member',deviceId:'phone',sessionKey:'s:'+a,authTime:time*1000,lastSeenAt:Date.now(),revokedAt:0});
  f.db.records.set('storeCustomerAuthSessions/phone-old',{uid:'member',deviceId:'phone',sessionKey:'s:'+c,authTime:(time-20)*1000,lastSeenAt:Date.now()-100});
  const result=await service.revokeSessions('member',{mode:'selected',sessionId:'phone-current'},{user:desktopUser});assert.equal(result.signInRequired,false);
  assert.equal((await f.request('/api/store/account',{token:phone})).status,401);
  assert.equal((await f.request('/api/store/account',{token:prior})).status,401);
  assert.equal((await f.request('/api/store/account',{token:desktop})).status,200);
});

test("existing product updates persist card level, animation, badge and gallery through a fresh public catalog",async()=>{
  const service=require('../server/core/storeCatalogService'),gallery='/public/assets/products/gallery/contra-hax/game-01.jpeg';
  const updated=await service.updateProductSettings('kingmod',{cardStyle:'signature',premiumAnimation:false,featuredBadgeText:'ÖZEL ÜRÜN',galleryPaths:[gallery]},{uid:'owneruid'});
  assert.equal(updated.cardStyle,'signature');assert.equal(updated.premiumAnimation,false);assert.deepEqual(updated.galleryPaths,[gallery]);
  const catalog=await service.getEffectiveCatalog({fresh:true}),product=catalog.products.find(x=>x.id==='kingmod');
  assert.equal(product.cardStyle,'signature');assert.equal(product.featuredBadgeText,'ÖZEL ÜRÜN');assert.equal(product.premiumAnimation,false);assert.deepEqual(product.galleryPaths,[gallery]);
  await assert.rejects(()=>service.updateProductSettings('kingmod',{galleryPaths:Array.from({length:21},()=>gallery)},{uid:'owneruid'}),e=>e.code==='STORE_GALLERY_LIMIT');
});

test("manual notification campaigns require approval, respect time, target and channel, and can be cancelled",async()=>{
  const service=require('../server/core/systemAnnouncements'),actor={uid:'owneruid'},now=Date.now();
  const admin=adminSession || await f.openAdmin();adminSession=admin;const draft=await f.adminWrite(admin,'/api/admin/store/commerce/notification-campaigns','POST',{title:'Seçili kampanya',message:'Onaylı içerik',group:'selected',uids:['member'],channels:{site:true,email:false},startsAt:now+60000,endsAt:now+120000});assert.equal(draft.status,200);const row=draft.body.result;
  assert.equal(row.state,'draft');assert.equal(await service.run(),0);
  const approval=await f.adminWrite(admin,'/api/admin/store/commerce/notification-campaigns/'+row.id+'/state','POST',{expectedRevision:row.revision,state:'pending'});assert.equal(approval.status,200);const approved=approval.body.result;assert.equal(await service.run(),0);
  f.db.records.set('storeSystemAnnouncementJobs/'+row.id,{...approved,availableAt:now-1});
  await service.run();
  const notes=[...f.db.records.values()].filter(x=>x.campaignId===row.id);assert(notes.some(x=>x.uid==='member'));assert(notes.every(x=>x.uid==='member'));
  assert.equal(f.db.records.get('storeSystemAnnouncementJobs/'+row.id).state,'completed');
  await service.setState(row.id,{expectedRevision:approved.revision,state:'cancelled'},actor);assert.equal(f.db.records.get('storeSystemAnnouncementJobs/'+row.id).state,'cancelled');
  await assert.rejects(()=>service.createDraft({title:'x',message:'x',group:'selected',uids:[],channels:{site:true,email:false},startsAt:0,endsAt:0},actor),e=>e.code==='CAMPAIGN_TARGET_REQUIRED');
});

test("a deletion request can be completed only after provider and profile deletion are verified",async()=>{
  const account=require('../server/commerce/account'),request=await account.dataRequest('finance',{kind:'deletion',message:'Silme talebi',idempotencyKey:crypto.randomUUID()});
  await assert.rejects(()=>account.dataDecision(request.id,{status:'completed',reply:'Kontrol'},{uid:'owneruid'}),e=>e.code==='COMMERCE_DELETION_NOT_VERIFIED');
  f.users.delete('finance');f.db.records.delete('users/finance');
  const result=await account.dataDecision(request.id,{status:'completed',reply:'Sağlayıcı ve profil doğrulandı.'},{uid:'owneruid'});assert.equal(result.status,'completed');assert.equal(result.financialRecordsRetained,true);
});
