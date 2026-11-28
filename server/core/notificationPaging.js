"use strict";
const crypto=require("node:crypto"),{purposeKey}=require("./adminAccessService");
const sign=(uid,value)=>crypto.createHmac("sha256",purposeKey("notification-cursor-v1")).update(uid+"\0"+value).digest("base64url");
function encode(uid,row,scope={}){const value=Buffer.from(JSON.stringify({t:Number(row.d.data().createdAt)||0,k:row.source,id:row.d.id,...scope})).toString("base64url");return value+"."+sign(uid,value);}
function decode(uid,value){
  if(!value)return null;
  try{
    if(typeof value!=="string"||value.length>700)throw Error();const [body,signature,...extra]=value.split('.'),expected=sign(uid,body);
    if(extra.length||!signature||signature.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))throw Error();
    const row=JSON.parse(Buffer.from(body,"base64url").toString());
    if(!Number.isSafeInteger(row.t)||row.t<0||!["legacy","event"].includes(row.k)||!/^[-_a-zA-Z0-9]{1,160}$/.test(row.id))throw Error();return row;
  }catch{throw Object.assign(new Error("STORE_NOTIFICATION_CURSOR_INVALID"),{code:"STORE_NOTIFICATION_CURSOR_INVALID",statusCode:400});}
}
function snapshot(uid, mode, at=Date.now()) {
  return at+"."+sign(uid,mode+":"+at);
}
function snapshotTime(uid,mode,token) {
  if(!token) return Date.now();
  if(typeof token==="string" && token.length<100) {
    const at=Number(token.split(".")[0]);
    if(Number.isSafeInteger(at) && at>0 && at<=Date.now() && token===snapshot(uid,mode,at)) return at;
  }
  throw Object.assign(new Error("STORE_NOTIFICATION_CURSOR_INVALID"),{code:"STORE_NOTIFICATION_CURSOR_INVALID",statusCode:400});
}
function buildQuery(base,kind,limit,cursor,admin){
  let result=base.orderBy("createdAt","desc").orderBy(admin.firestore.FieldPath.documentId(),"desc");
  if(cursor){if(cursor.k===kind)result=result.startAfter(cursor.t,cursor.id);else result=result.where("createdAt",kind<cursor.k?"<=":"<",cursor.t);}
  return result.limit(limit+1);
}
function query(...args){return buildQuery(...args).get();}
function order(a,b){return (Number(b.d.data().createdAt)||0)-(Number(a.d.data().createdAt)||0)||((a.source+"_"+a.d.id)<(b.source+"_"+b.d.id)?1:-1);}
module.exports={encode,decode,buildQuery,query,order,snapshot,snapshotTime};
