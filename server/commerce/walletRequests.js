"use strict";
const C=require("./common"),M=require("../core/storeMoney"),events=require("../core/notificationEvents");
async function create(uid,input){
  C.object(input,["amountKurus","reference","idempotencyKey"]);
  const amountKurus=C.integer(input.amountKurus,1,100000000),reference=C.text(input.reference,160,{required:true}),key=C.id(input.idempotencyKey,100),db=C.db(),ref=db.collection("storeWalletRequests").doc(C.hash(uid,key));
  return db.runTransaction(async tx=>{
    await C.activeUser(uid,{transaction:tx,database:db});const old=(await tx.get(ref)).data();
    if(old){if(old.amountKurus!==amountKurus||old.reference!==reference)C.fail("COMMERCE_IDEMPOTENCY_CONFLICT",409);return{id:ref.id,...old};}
    const now=Date.now(),row={uid,amountKurus,reference,status:"pending",revision:1,createdAt:now,updatedAt:now};
    tx.create(ref,row);events.record(tx,db,{uid,type:"wallet_request_created",key:ref.id,data:{walletRequestId:ref.id,amountKurus}});return{id:ref.id,...row};
  });
}
async function list(uid,query={}){await C.activeUser(uid);return C.publicRows(await C.page("storeWalletRequests",{...query,uid}));}
async function adminList(query={}){return C.publicRows(await C.page("storeWalletRequests",query));}
async function decide(id,input,actor){
  C.object(input,["expectedRevision","decision","paymentReference"]);
  if(actor.financialPermission!==true)C.fail("STORE_PERMISSION_DENIED",403);
  const decision=C.choice(input.decision,["approved","rejected"]),paymentReference=C.text(input.paymentReference || "",160),db=C.db(),ref=db.collection("storeWalletRequests").doc(C.id(id));
  if(decision==="approved"&&!paymentReference)C.fail("WALLET_PAYMENT_REFERENCE_REQUIRED");
  return db.runTransaction(async tx=>{
    const old=(await tx.get(ref)).data();if(!old)C.fail("WALLET_REQUEST_NOT_FOUND",404);
    if(old.status!=="pending"){if(old.status!==decision)C.fail("COMMERCE_REVISION_CONFLICT",409);return{id:ref.id,...old,replayed:true};}
    C.requireRevision(old.revision,input.expectedRevision);
    const profile=await C.activeUser(old.uid,{transaction:tx,database:db}),userRef=db.collection("users").doc(old.uid),ledgerRef=db.collection("storeWalletLedger").doc(C.hash("topup",ref.id)),paymentRef=db.collection("storeWalletPaymentReferences").doc(C.hash(paymentReference)),now=Date.now();
    const payment=decision==="approved"?(await tx.get(paymentRef)).data():null;
    if(payment&&payment.requestId!==ref.id)C.fail("WALLET_PAYMENT_REFERENCE_USED",409);
    const row={...old,status:decision,revision:old.revision+1,updatedAt:now,reviewedBy:actor.uid};
    if(decision==="approved"){
      const before=M.readStoredBalance(profile),after=M.checkedBalance(before+old.amountKurus);
      tx.set(userRef,{storeBalanceKurus:after,storeUpdatedAt:now},{merge:true});
      tx.create(ledgerRef,{uid:old.uid,transactionId:ledgerRef.id,type:"CREDIT",amountKurus:old.amountKurus,balanceBeforeKurus:before,balanceAfterKurus:after,reason:"Onaylanan bakiye yükleme talebi",source:"wallet-request",walletRequestId:ref.id,actor:{uid:actor.uid},createdAt:now});
      tx.set(paymentRef,{requestId:ref.id,createdAt:now});row.transactionId=ledgerRef.id;
      events.record(tx,db,{uid:old.uid,type:"wallet_credit",key:ledgerRef.id,data:{transactionId:ledgerRef.id,walletRequestId:ref.id,amountKurus:old.amountKurus}});
    }
    tx.set(ref,row);events.record(tx,db,{uid:old.uid,type:decision==="approved"?"wallet_request_approved":"wallet_request_rejected",key:ref.id,data:{walletRequestId:ref.id,amountKurus:old.amountKurus}});
    C.audit(tx,db,"commerce.wallet-request."+decision,actor,{requestId:ref.id,amountKurus:old.amountKurus});return{id:ref.id,...row};
  });
}
async function ledger(uid,query={}){
  await C.activeUser(uid);return C.publicRows(await C.page("storeWalletLedger",{...query,uid}),row=>({id:row.id,type:row.type,amountKurus:row.amountKurus,balanceBeforeKurus:row.balanceBeforeKurus,balanceAfterKurus:row.balanceAfterKurus,reason:row.reason,createdAt:row.createdAt,orderId:row.orderId || ""}));
}
async function detail(uid, id, request) {
  const db = C.db();
  await C.activeUser(uid);
  const entry = (await db.collection(request ? 'storeWalletRequests' : 'storeWalletLedger').doc(C.id(id)).get()).data();
  if (!entry || entry.uid !== uid) C.fail('WALLET_RECORD_NOT_FOUND',404);
  return {id,amountKurus:entry.amountKurus,createdAt:entry.createdAt,
    ...(request ? {status:entry.status,reference:entry.reference || ''} : {type:entry.type,reason:entry.reason || '',balanceAfterKurus:entry.balanceAfterKurus})};
}
module.exports={create,list,adminList,decide,ledger,detail};
