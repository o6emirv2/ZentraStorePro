'use strict';
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { fork } = require('node:child_process');
const admin = require('firebase-admin');
const projectId = 'demo-zentra-inbox';
async function main() {
  assert.match(process.env.FIRESTORE_EMULATOR_HOST || '', /^(127\.0\.0\.1|localhost):\d+$/);
  assert.equal(process.env.GCLOUD_PROJECT,projectId);
  const app = admin.initializeApp({projectId}), db = app.firestore();
  require('./helpers/memory-firestore.cjs').mockModule(require.resolve('../server/config/firebaseAdmin'),{initFirebaseAdmin:()=>({admin,db})});
  const inbox = require('../server/core/customerNotificationService');
  const maintenance = require('../server/core/storeMaintenance');
  try {
    const owner = process.argv[3] || randomUUID(), mode = process.argv[2];
    if (mode==='reader') {
      assert.equal((await inbox.summary(owner)).unread,Number(process.argv[4]));
      assert.equal((await maintenance.status()).maintenance,process.argv[5]==='on');
      assert.equal((await db.doc('users/'+owner).get()).data().storeBalanceKurus,50000);
      assert.equal((await db.doc('storeOrders/'+owner).get()).data().uid,owner);
      return;
    }
    process.env.ADMIN_GATE_SIGNING_SECRET = randomBytes(64).toString('hex');
    const independent = (unread,mode) => new Promise((resolve,reject)=>{
      const child=fork(__filename,['reader',owner,String(unread),mode],{stdio:'inherit'});
      child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error('Restarted reader failed: '+code)));
    });
    const seed=db.batch();
    const event=id=>db.collection('storeNotifications').doc(owner+'-'+id);
    for(let i=0;i<316;i++) {
      const ref=i%2 ? event(i) : db.doc('storeUserNotifications/'+owner+'/items/'+i);
      seed.set(ref,{uid:owner,type:'security',createdAt:1000+Math.floor(i/2),...(i<12 ? {read:true,readAt:2} : i%3 ? {readAt:0} : {})});
    }
    seed.set(db.doc('storeCommerceProfiles/'+owner),{preferences:{stockNotifications:false}});
    seed.set(db.doc('users/'+owner),{storeBalanceKurus:50000});
    seed.set(db.doc('storeOrders/'+owner),{uid:owner,status:'delivered'});
    seed.set(db.doc('storefrontSettings/main'),{maintenance:false});
    await seed.commit();
    assert.equal((await inbox.summary(owner)).unread,304);
    await Promise.all([independent(304,'off'),independent(304,'off')]);
    const first=await inbox.markAllRead(owner);
    assert.ok(first.nextCursor);
    const next=await inbox.markAllRead(owner,first.nextCursor);
    assert.equal(next.complete,true);assert.equal(first.changed+next.changed,304);
    await db.doc('storefrontSettings/main').set({maintenance:true});
    await independent(0,'on');
    await event('new').set({uid:owner,type:'security',createdAt:4000,read:false});
    let cursor='', removed=0;
    do {const page=await inbox.deleteRead(owner,cursor);removed+=page.changed;cursor=page.nextCursor;} while(cursor);
    assert.equal(removed,316);
    assert.equal((await inbox.summary(owner)).unread,1);
    assert.equal((await inbox.list(owner,20,'',{inboxOnly:true})).notifications.length,1);
    await independent(1,'on');
    console.log(JSON.stringify({projectId,unreadBefore:304,marked:304,deleted:316,remainingUnread:1,independentWorkerChecks:4}));
  } finally { await app.delete(); }
}
main().catch(err=>{console.error(err);process.exitCode=1;});
