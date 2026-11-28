"use strict";
const crypto = require("node:crypto");
const C = require("./common");
const {initFirebaseAdmin} = require("../config/firebaseAdmin");
const MAX_BYTES = 2 * 1024 * 1024;
function validate(input) {
  C.object(input,["name","contentType","data","idempotencyKey"]);
  const name = C.text(input.name,100,{required:true});
  if (/[\\/\x00-\x1f]/.test(name)) C.fail("SUPPORT_FILE_INVALID");
  const type = C.choice(input.contentType,["image/png","image/jpeg","application/pdf"]);
  if (typeof input.data !== "string" || input.data.length > Math.ceil(MAX_BYTES/3)*4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.data)) C.fail("SUPPORT_FILE_INVALID");
  const bytes=Buffer.from(input.data,"base64");
  if (!bytes.length || bytes.length>MAX_BYTES || bytes.toString("base64")!==input.data) C.fail("SUPPORT_FILE_INVALID");
  const magic=type==="image/png" ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : type==="image/jpeg" ? bytes[0]===255 && bytes[1]===216 && bytes[2]===255 : bytes.subarray(0,5).toString()==="%PDF-";
  if(!magic) C.fail("SUPPORT_FILE_TYPE_MISMATCH");
  return {name,type,bytes,key:C.id(input.idempotencyKey,100),digest:crypto.createHash("sha256").update(bytes).digest("hex")};
}
async function ticket(uid,ticketId,{admin=false}={}) {
  await C.activeUser(uid);
  const row=(await C.db().collection("storeSupportTickets").doc(C.id(ticketId)).get()).data();
  if(!row || (!admin && row.uid!==uid)) C.fail("COMMERCE_TICKET_NOT_FOUND",404);
  return row;
}
function bucket() {
  const {admin,app}=initFirebaseAdmin();
  if(!app) C.fail("SUPPORT_STORAGE_UNAVAILABLE",503);
  try{return admin.storage(app).bucket();}catch{C.fail("SUPPORT_STORAGE_UNAVAILABLE",503);}
}
async function upload(uid,ticketId,input,{storage=bucket}={}) {
  await ticket(uid,ticketId);
  const data=validate(input),db=C.db(),id=C.hash(uid,ticketId,data.key),ref=db.collection("storeSupportAttachments").doc(id),now=Date.now();
  const grant=await db.runTransaction(async tx=>{
    const old=(await tx.get(ref)).data();
    if(old){if(old.uid!==uid || old.digest!==data.digest) C.fail("COMMERCE_IDEMPOTENCY_CONFLICT",409);if(old.state==="ready")return {ready:true};if(old.leaseUntil>now)C.fail("SUPPORT_FILE_PENDING",409);}
    tx.set(ref,{uid,ticketId,name:data.name,contentType:data.type,size:data.bytes.length,digest:data.digest,state:"uploading",leaseUntil:now+60000,createdAt:old?.createdAt || now});return {ready:false};
  });
  if(!grant.ready){
    try {
      await storage().file("support/"+uid+"/"+ticketId+"/"+id).save(data.bytes,{resumable:false,validation:"crc32c",metadata:{contentType:data.type,cacheControl:"private,no-store"},preconditionOpts:{ifGenerationMatch:0}});
    } catch(error) {
      // A previous attempt may have stored the same immutable object before its
      // metadata commit was interrupted. Its content hash is checked on download.
      if(Number(error.code)!==412){await ref.set({state:"failed",leaseUntil:0},{merge:true});C.fail("SUPPORT_STORAGE_UNAVAILABLE",503);}
    }
    await ref.set({state:"ready",leaseUntil:0},{merge:true});
  }
  return {id,name:data.name,contentType:data.type,size:data.bytes.length};
}
async function list(uid,ticketId,{admin=false}={}) {
  const owner=(await ticket(uid,ticketId,{admin})).uid;
  const rows=await C.db().collection("storeSupportAttachments").where("ticketId","==",ticketId).where("uid","==",owner).where("state","==","ready").limit(20).get();
  return rows.docs.map(d=>({id:d.id,name:d.data().name,size:d.data().size,contentType:d.data().contentType}));
}
async function download(uid,id,{storage=bucket,admin=false}={}) {
  await C.activeUser(uid);
  const row=(await C.db().collection("storeSupportAttachments").doc(C.id(id,100)).get()).data();
  if(!row || (!admin && row.uid!==uid) || row.state!=="ready")C.fail("SUPPORT_FILE_NOT_FOUND",404);
  await ticket(uid,row.ticketId,{admin});
  const [bytes]=await storage().file("support/"+row.uid+"/"+row.ticketId+"/"+id).download();
  if(bytes.length!==row.size || crypto.createHash("sha256").update(bytes).digest("hex")!==row.digest)C.fail("SUPPORT_FILE_CORRUPT",503);
  return {...row,bytes};
}
module.exports={MAX_BYTES,validate,upload,list,download};
