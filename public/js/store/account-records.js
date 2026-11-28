import { escape as e, date, money } from "../app/ui.js?v=117";

const labels = {
  pending: "İnceleniyor",
  approved: "Onaylandı",
  rejected: "Reddedildi",
  confirmed: "Onaylandı", captured: "Ödendi", confirmed_manually: "Ödeme onaylandı",
  reserved: "Tutar rezerve edildi", not_captured: "Tahsil edilmedi", unverified: "Doğrulanamadı",
  closed: "Kapandı", ready: "Hazır",
  awaiting_payment: "Ödeme bekleniyor",
  payment_review: "Ödeme inceleniyor",
  paid: "Ödendi",
  processing: "Hazırlanıyor",
  delivery_pending: "Teslimat bekleniyor",
  delivered: "Teslim edildi",
  cancelled: "İptal edildi",
  refunded: "İade edildi",
  payment_rejected: "Ödeme reddedildi",
  created: "Oluşturuldu",
};
const label = (value) => e(labels[value] || "Durum güncelleniyor");
const section = (title, html) =>
  '<section class="hub-card"><h3>' + e(title) + "</h3>" + html + "</section>";

export async function accountRecord(route, call) {
  if (route.orderId) {
    const record = await call("/orders/" + encodeURIComponent(route.orderId));
    const history = record.timeline
      .map(
        (x) => "<li>" + label(x.status) + " · " + date(x.createdAt) + "</li>",
      )
      .join("");
    const delivery = record.canReveal
      ? '<button type="button" class="screen-button" data-hub-action="show-delivery">Teslimat Bilgilerini Göster</button>'
      : "";
    return section(
      (record.gift ? "Hediye" : "Sipariş") + " " + record.orderNumber,
      '<dl class="hub-details">' +
        '<div><dt>Sipariş durumu</dt><dd>' + label(record.status) + '</dd></div>' +
        '<div><dt>Tarih</dt><dd>' + date(record.createdAt) + '</dd></div>' +
        (Number.isSafeInteger(record.totalKurus) ? '<div><dt>Sipariş tutarı</dt><dd>' + money(record.totalKurus) + '</dd></div>' : '') +
        '<div><dt>Ödeme</dt><dd>' + label(record.paymentState || record.paymentStatus) + '</dd></div>' +
        '<div><dt>Teslimat</dt><dd>' + label(record.deliveryState === 'pending' ? 'delivery_pending' : record.deliveryState) + '</dd></div></dl>' +
        (record.items?.length ? '<ul>' + record.items.map(i=>'<li>'+ e(i.productName) +' · '+ e(i.planLabel) +' · '+e(i.quantity)+' adet</li>').join('') + '</ul>' : '') +
        (record.license
          ? "<p>Lisans bitişi · " + date(record.license.expiresAt) + "</p>"
          : "") +
        '<h4>İşlem geçmişi</h4><ol>' +
        history +
        "</ol>" +
        delivery,
    );
  }
  if (route.gifts) {
    const { items } = await call("/gifts");
    return section(
      "Hediyelerim",
      items.length
        ? items
            .map(
              (x) =>
                '<button type="button" class="screen-button" data-hub-action="order-record" data-id="' +
                e(x.id) +
                '">' +
                e(x.orderNumber) +
                "</button>",
            )
            .join("")
        : "<p>Hesabınıza gönderilmiş hediye bulunmuyor.</p>",
    );
  }
  const request = Boolean(route.requestId),
    row = await call(
      (request ? "/wallet-requests/" : "/wallet/") +
        encodeURIComponent(route.requestId || route.transactionId),
    );
  return section(
    request ? "Bakiye Yükleme Talebi" : "Bakiye Hareketi",
    "<p>" +
      money(row.amountKurus) +
      " · " +
      date(row.createdAt) +
      "</p>" +
      (request
        ? "<p>" + label(row.status) + "</p><p>" + e(row.reference) + "</p>"
        : "<p>" +
          e(row.reason) +
          "</p><p>İşlem sonrası bakiye · " +
          money(row.balanceAfterKurus) +
          "</p>"),
  );
}
