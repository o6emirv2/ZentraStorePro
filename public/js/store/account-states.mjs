export const accountStates = Object.freeze({
  active: ["Aktif", "Hesap işlemleri kullanıma açık."],
  under_review: [
    "İnceleme altında",
    "Hesap, sipariş geçmişi ve destek açık. Yeni mali işlemler inceleme sonuna kadar kapalı.",
  ],
  restricted: [
    "Kısıtlandı",
    "Geçmiş kayıtları görüntüleme, güvenlik ve destek işlemleri açık. Diğer değişiklikler kapalı.",
  ],
  purchase_blocked: [
    "Alışveriş engeli uygulandı",
    "Giriş, sipariş geçmişi ve destek açık. Yeni sipariş ve ödeme başlatılamaz.",
  ],
  suspended: [
    "Geçici olarak askıya alındı",
    "Oturumlar iptal edilir. Yönetici yeniden açana kadar erişim durdurulur.",
  ],
  verification_pending: [
    "E-posta doğrulaması bekleniyor",
    "Doğrulama işlemi açık. Hesap incelemesi kaldırılana kadar yeni alışveriş yapılamaz.",
  ],
  security_locked: [
    "Güvenlik nedeniyle kilitlendi",
    "Oturumlar iptal edilir. Kilit, güvenlik incelemesi ve yönetici doğrulamasıyla kaldırılabilir.",
  ],
  closed: [
    "Hesap kapatıldı",
    "Giriş ve kullanıcı işlemleri kapalı. Finansal geçmiş korunur.",
  ],
});
export const stateLabel = (state) =>
  accountStates[state]?.[0] || "Durum doğrulanamadı";
export const blocksAccess = (state) =>
  ["suspended", "security_locked", "closed"].includes(state);
export const blocksPurchases = (state) => (state || "active") !== "active";
