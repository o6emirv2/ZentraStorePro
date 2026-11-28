'use strict';
const {createRequire}=require('node:module');
const path=require('node:path');
// Run from the release to measure; both versions use the same data and operations.
const fromProject=createRequire(path.resolve('package.json'));
async function main(){
  const f=await fromProject('./scripts/helpers/application-fixture.cjs').applicationFixture({rateLimitStore:'memory',transientStore:'memory'});
  const sample={}, stats=f.db.stats;
  let listeners=0;
  const chain=new Set(['where','orderBy','limit','doc','collection','select','startAfter']);
  function track(ref){
    return new Proxy(ref,{get(target,key){
      if(key==='onSnapshot')return (...args)=>{
        listeners++;
        if(typeof target.onSnapshot!=='function')throw Error('This fixture cannot deliver live snapshots');
        return target.onSnapshot(...args);
      };
      if(chain.has(key) && typeof target[key]==='function')return (...args)=>track(target[key](...args));
      return target[key];
    }});
  }
  for(const key of ['collection','doc','collectionGroup']){
    const open=f.db[key].bind(f.db); f.db[key]=(...args)=>track(open(...args));
  }
  async function measure(label,work){
    const initial={...stats,listeners}; await work();
    sample[label]={reads:stats.reads-initial.reads,queries:stats.queries-initial.queries,writes:stats.writes-initial.writes,listeners:listeners-initial.listeners};
  }
  try{
    const inbox=fromProject('./server/core/customerNotificationService'), gate=fromProject('./server/core/storeMaintenance');
    const orders=fromProject('./server/commerce/orders');
    for(let i=0;i<20;i++){
      f.db.records.set('storeEmailOutbox/probe'+i,{uid:'member',createdAt:i+1});
      f.db.records.set('storeNotifications/probe'+i,{uid:'member',type:'security',readAt:i<5?1:0,createdAt:i+1});
      if(i<10)f.db.records.set('storeAccountRecoveryRequests/probe'+i,{uid:'member',createdAt:i+1});
    }
    f.db.records.set('storeOrders/usage-test',{uid:'member',status:'delivered',createdAt:1,delivery:{status:'delivered'}});
    await measure('maintenance10',()=>Promise.all(Array.from({length:10},()=>gate.status())));
    await measure('inbox2',async()=>{ for(let i=0;i<2;i++)await inbox.list('member',20,'',{inboxOnly:true}); });
    await measure('acknowledge2',async()=>{for(let i=0;i<2;i++)await orders.acknowledge('member','usage-test');});
    console.log(JSON.stringify(sample));
  } finally { await f.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
