"use strict";
// Shared Turkish wording and action intent for site and mail channels.
const copy = {
  review_invitation: ["Satın aldığınız ürün hakkındaki görüşünüzü merak ediyoruz",
    "Satın aldığınız ürün için yeni bir müşteri yorumu yayımlandı. Sizin deneyiminiz nasıldı? Ürünle ilgili görüşünüzü paylaşarak diğer alıcıların daha bilinçli seçim yapmasına yardımcı olabilirsiniz.",
    "Ürünü değerlendir"],
  recovery_password: [
    "Şifrenizi yenileyin",
    "Şifrenizi yenilemek için güvenli bağlantıyı kullanın. Bağlantının süresi sınırlıdır.",
    "Şifremi Yenile",
  ],
  password_reset_completed: [
    "Şifreniz yenilendi",
    "Şifre yenileme işleminiz tamamlandı. Bu işlemi siz yapmadıysanız oturumlarınızı inceleyin.",
    "Hesap Güvenliğini İncele",
  ],
  recovery_username: [
    "Kullanıcı adı hatırlatma",
    "Kayıtlı kullanıcı adınız bu e-postada yer almaktadır. Hesabınıza giriş yapabilirsiniz.",
    "Giriş Yap",
  ],
  username_changed: [
    "Kullanıcı adınız güncellendi",
    "Hesabınızın kullanıcı adı değiştirildi. Size ait olmayan bir işlem görüyorsanız güvenlik ayarlarınızı kontrol edin.",
    "Hesap Güvenliğini İncele",
  ],
  email_changed: [
    "E-posta adresiniz güncellendi",
    "Hesabınızın e-posta adresi doğrulama işleminin ardından güncellendi.",
    "Hesap Güvenliğini İncele",
  ],
  new_device: [
    "Yeni cihazdan giriş yapıldı",
    "Hesabınızda yeni bir cihaz oturumu açıldı. Cihazı tanımıyorsanız oturumu sonlandırın.",
    "Cihazlarımı İncele",
  ],
  suspicious_login: [
    "Hesap güvenliğinizi kontrol edin",
    "Hesabınızla ilişkili olağan dışı bir oturum olayı tespit edildi. Cihazlarınızı ve güvenlik ayarlarınızı inceleyin.",
    "Cihazlarımı İncele",
  ],
  account_created: [
    "ZENTRA STORE’a hoş geldiniz",
    "Hesabınız oluşturuldu. Hesap bilgilerinizi kontrol edebilir ve mağazamızı keşfedebilirsiniz.",
    "Hesabıma Git",
  ],
  verification: [
    "E-posta adresinizi doğrulayın",
    "Hesabınızı etkinleştirmek için e-posta doğrulama işlemini tamamlayın.",
    "E-postamı Doğrula",
  ],
  security_updated: [
    "Güvenlik ayarlarınız güncellendi",
    "Hesabınızın güvenlik ayarlarında değişiklik yapıldı. İşlem size ait değilse hesabınızı kontrol edin.",
    "Hesap Güvenliğini İncele",
  ],
  wallet_credit: [
    "Bakiyeniz güncellendi",
    "Bakiye ekleme işlemi hesabınıza kaydedildi. Tutarı ve işlem ayrıntılarını bakiye hareketlerinizden inceleyebilirsiniz.",
    "Bakiye Hareketini Gör",
  ],
  wallet_debit: [
    "Bakiye işleminiz kaydedildi",
    "Hesabınızda bir bakiye düşümü kaydedildi. İşlem ayrıntıları bakiye hareketlerinizde hazır.",
    "Bakiye Hareketini Gör",
  ],
  wallet_request_created: [
    "Bakiye yükleme talebiniz alındı",
    "Talebiniz finans ekibimizin kontrolüne iletildi. Ödemeniz doğrulandıktan sonra sonuç size bildirilecek.",
    "Yükleme Talebimi Gör",
  ],
  wallet_request_approved: [
    "Bakiye yüklemeniz onaylandı",
    "Ödemeniz doğrulandı ve onaylanan tutar hesabınıza eklendi.",
    "Yükleme Sonucunu Gör",
  ],
  wallet_request_rejected: [
    "Bakiye yükleme talebiniz sonuçlandı",
    "Yükleme talebiniz onaylanamadı. Talep ayrıntılarını inceleyebilir ve destek ekibimizle iletişime geçebilirsiniz.",
    "Yükleme Sonucunu Gör",
  ],
  coupon_assigned: [
    "İndirim kuponunuz hazır",
    "Kuponunuzu geçerlilik süresi içinde uygun bir alışverişte kullanabilirsiniz. Kullanım koşullarını inceleyin.",
    "Kuponlarımı Gör",
  ],
  promo_added: [
    "Promosyon kodunuz hazır",
    "Size sunulan promosyonun ödülünü ve koşullarını inceleyerek kodunuzu kullanabilirsiniz.",
    "Promosyon Kodunu Kullan",
  ],
  coupon_used: [
    "Kuponunuz uygulandı",
    "Kupon indiriminiz ilgili siparişe kaydedildi. İndirim ve ödeme ayrıntılarını siparişinizden inceleyebilirsiniz.",
    "Siparişimi Gör",
  ],
  promo_used: [
    "Promosyonunuz kullanıldı",
    "Promosyon ödülünüz hesabınıza veya ilgili işleminize uygulandı. Güncel hareketlerinizi inceleyebilirsiniz.",
    "Promosyon İşlemini Gör",
  ],
  price: [
    "Takip ettiğiniz üründe indirim var",
    "Favorilerinize eklediğiniz veya takip ettiğiniz ürünün fiyatı güncellendi. Güncel paket fiyatlarını inceleyebilirsiniz.",
    "Ürünü İncele",
  ],
  stock: [
    "Takip ettiğiniz ürün yeniden stokta",
    "Takip ettiğiniz ürün için yeni stok doğrulandı. Güncel paket ve stok durumunu inceleyebilirsiniz.",
    "Ürünü İncele",
  ],
  restock: [
    "Beklediğiniz paket yeniden stokta",
    "Stok bildirimi istediğiniz paket yeniden kullanılabilir. Stok durumu satın alma sırasında tekrar doğrulanır.",
    "Paketi İncele",
  ],
  order_created: [
    "Siparişiniz alındı",
    "Sipariş kaydınız oluşturuldu. Ödeme ve teslimatın güncel durumunu hesabınızdan takip edebilirsiniz.",
    "Siparişimi Gör",
  ],
  order_approved: [
    "Siparişiniz onaylandı",
    "Siparişinizin onay işlemi tamamlandı. Teslimat aşamalarını sipariş ayrıntılarından takip edebilirsiniz.",
    "Siparişimi Gör",
  ],
  order_preparing: [
    "Siparişiniz hazırlanıyor",
    "Siparişiniz teslimat için hazırlanıyor. Güncel durum sipariş ayrıntılarınızda gösterilir.",
    "Siparişimi Takip Et",
  ],
  paid_delivered: [
    "Ödemeniz onaylandı, teslimatınız hazır",
    "Ödeme ve dijital teslimat işleminiz tamamlandı. Teslimat bilgilerinize yalnızca hesabınızdaki korumalı alandan erişebilirsiniz.",
    "Teslimatımı Gör",
  ],
  order_cancelled: [
    "Siparişiniz iptal edildi",
    "Siparişinizin iptal işlemi kaydedildi. İptal ve ilgili ödeme hareketlerinin ayrıntılarını hesabınızdan inceleyebilirsiniz.",
    "Sipariş Sonucunu Gör",
  ],
  refund_completed: [
    "İade işleminiz tamamlandı",
    "Onaylanan iade işleminiz kaydedildi. İade tutarı ve ödeme hareketleri ilgili siparişinizde gösterilir.",
    "İade Kaydını Gör",
  ],
  support_created: [
    "Destek talebiniz alındı",
    "Talebiniz destek ekibimize ulaştı. Mesajlarınızı ve talebinizin durumunu destek merkezinden takip edebilirsiniz.",
    "Destek Talebimi Aç",
  ],
  support_replied: [
    "Destek talebinize yanıt geldi",
    "Destek ekibimiz talebinize yanıt verdi. Görüşmeye hesabınızdaki destek merkezi üzerinden devam edebilirsiniz.",
    "Yanıtı Gör",
  ],
  support_closed: [
    "Destek talebiniz kapatıldı",
    "Destek görüşmeniz sonuçlandırıldı. Talep geçmişinizi ve yeniden açma seçeneklerini destek merkezinden inceleyebilirsiniz.",
    "Talep Sonucunu Gör",
  ],
  system_announcement: [
    "ZENTRA STORE’dan haber var",
    "Hesabınızla ilgili yeni duyuruyu bildirim merkezinden inceleyebilirsiniz.",
    "Duyuruyu Gör",
  ],
  password_changed: [
    "Şifreniz değiştirildi",
    "Hesap şifreniz güncellendi. İşlem size ait değilse oturumlarınızı sonlandırın ve destek ekibimizle iletişime geçin.",
    "Hesap Güvenliğini İncele",
  ],
  license: [
    "Lisans süreniz yaklaşıyor",
    "Siparişinizde kayıtlı lisans bitiş tarihi yaklaşıyor. Geçerlilik ve kullanım bilgilerini siparişinizden kontrol edebilirsiniz.",
    "Lisans Bilgilerini Gör",
  ],
  gift_received: [
    "Hesabınıza bir hediye gönderildi",
    "Size gönderilen dijital ürünün teslimatı hazır. Hediye bilgilerini kendi hesabınızdan güvenle görüntüleyebilirsiniz.",
    "Hediyemi Gör",
  ],
  test: [
    "ZENTRA STORE · Test iletisi",
    "Bu ileti, yönetim panelinden başlatılan e-posta kontrolü için gönderilmiştir.",
    "Bildirim Merkezini Aç",
  ],
};
function presentation(type) {
  const c = copy[type];
  if (!c) throw Error("NOTIFICATION_TYPE_INVALID");
  return { subject: c[0], intro: c[1], label: c[2] };
}
module.exports = { presentation, types: Object.freeze(Object.keys(copy)) };
