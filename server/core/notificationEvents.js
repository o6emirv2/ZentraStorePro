"use strict";
// Canonical event vocabulary; recovery URLs are generated only by their secure services.
const entries = [
  ["recovery_password","Şifre sıfırlama bağlantısı","security","/hesabim?islem=sifre-yenile"],
  ["password_reset_completed","Şifre sıfırlama tamamlandı","security","/hesap-merkezi"],
  ["recovery_username","Kullanıcı adı hatırlatma","security","/hesabim?islem=giris"],
  ["username_changed","Kullanıcı adı değiştirildi","security","/hesap-merkezi"],
  ["email_changed","E-posta adresi değiştirildi","security","/hesap-merkezi"],
  ["new_device","Yeni cihazdan giriş","security","/cihazlarim"],
  ["suspicious_login","Şüpheli giriş tespit edildi","security","/cihazlarim"],
  ["account_created","Yeni hesap oluşturuldu","security","/hesabim"],
  ["verification","E-posta doğrulama","security","/hesabim?islem=dogrula"],
  ["security_updated","Hesap güvenliği güncellendi","security","/hesap-merkezi"],
  ["wallet_credit","Bakiye eklendi","wallet","/hesabim"],
  ["wallet_debit","Bakiye düşüldü","wallet","/hesabim"],
  ["wallet_request_created","Bakiye yükleme talebi alındı","wallet","/hesabim"],
  ["wallet_request_approved","Bakiye yükleme onaylandı","wallet","/hesabim"],
  ["wallet_request_rejected","Bakiye yükleme reddedildi","wallet","/destek"],
  ["coupon_assigned","Kupon kodu tanımlandı","coupon","/kuponlar"],
  ["promo_added","Promosyon kodu tanımlandı","promo","/promosyonlar"],
  ["coupon_used","Kupon kullanıldı","coupon","/siparisler"],
  ["promo_used","Promosyon kullanıldı","promo","/promosyonlar"],
  ["price","Favori ürün indirime girdi","price","/magaza"],
  ["stock","Takip edilen ürünün stoğu yenilendi","stock","/magaza"],
  ["restock","Stok Gelince Bildir","stock","/magaza"],
  ["order_created","Yeni sipariş oluşturuldu","order","/siparisler"],
  ["order_approved","Sipariş onaylandı","order","/siparisler"],
  ["order_preparing","Sipariş hazırlanıyor","order","/siparisler"],
  ["paid_delivered","Sipariş teslim edildi","order","/siparisler"],
  ["order_cancelled","Sipariş iptal edildi","order","/siparisler"],
  ["refund_completed","İade tamamlandı","order","/siparisler"],
  ["support_created","Destek talebi oluşturuldu","support","/destek"],
  ["support_replied","Destek talebine yanıt verildi","support","/destek"],
  ["support_closed","Destek talebi kapatıldı","support","/destek"],
  ["review_invitation","Ürün yorumu daveti","review","/magaza"],
  ["system_announcement","Sistem duyurusu","campaign","/bildirimler"],
];
entries.push(['password_changed','Şifre değişikliği','security','/hesap-merkezi'],['license','Lisans süresi','license','/siparisler'],['gift_received','Hediye alındı','order','/hesabim?bolum=gifts'],['test','Test iletisi','test','/bildirimler']);
const EVENTS = Object.freeze(Object.fromEntries(entries.map(([type,title,category,path]) => [type,Object.freeze({type,title,category,path})])));
function destination(type,data={}) {
  if (!EVENTS[type]) throw new Error("NOTIFICATION_TYPE_INVALID");
  const id = value => encodeURIComponent(String(value || ''));
  if (type === 'gift_received') return '/hesabim?bolum=gifts' + (data.orderId ? '&hediye=' + id(data.orderId) : '');
  if (['wallet_credit','wallet_debit','promo_used'].includes(type))
    return '/hesabim?bolum=wallet' + (data.transactionId ? '&hareket=' + id(data.transactionId) : data.walletRequestId ? '&talep=' + id(data.walletRequestId) : '');
  if (type.startsWith('wallet_request_')) return '/hesabim?bolum=wallet' + (data.walletRequestId ? '&talep=' + id(data.walletRequestId) : '');
  if (type.startsWith('support_') && data.ticketId) return '/destek?ticket=' + id(data.ticketId);
  if (type==='review_invitation' && data.productId) return '/urun/'+id(data.productId)+'?bolum=yorumlar';
  if (['price','stock','restock'].includes(type) && data.productId) return '/urun/' + id(data.productId) + (data.planKey ? '?paket=' + id(data.planKey) : '');
  if (['coupon_used','license','paid_delivered','refund_completed'].includes(type) || type.startsWith('order_'))
    return data.orderId ? '/siparisler?order=' + id(data.orderId) : '/siparisler';
  return EVENTS[type].path;
}
function record(tx,db,{uid,type,key,data={},site=true,email=true,now=Date.now()}) {
  const event=EVENTS[type];
  if(!event || !uid || !key) throw new Error("NOTIFICATION_EVENT_INVALID");
  const id=require("node:crypto").createHash("sha256").update([uid,type,key].join("\0")).digest("hex");
  const wording=require("./notificationPresentation").presentation(type);
  if(site) tx.set(db.collection("storeNotifications").doc(id),{...data,uid,type:event.category,templateType:type,title:data.title || wording.subject,message:data.message || wording.intro,actionLabel:wording.label,href:destination(type,data),createdAt:now,readAt:0},{merge:true});
  if(email && !["recovery_password","recovery_username","verification"].includes(type)) require("../email/service").enqueue(tx,db,{uid,type,key,data,now});
  return id;
}
module.exports={EVENTS,destination,record};
