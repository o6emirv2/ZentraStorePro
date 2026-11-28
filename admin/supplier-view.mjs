import { escape as e, icon } from "../public/js/app/ui.js?v=117";

const requirements = {
  api_base_url: "Gerçek HTTPS API adresi ve sürümü",
  authentication: "Anahtarın gönderileceği başlık ve yetkilendirme biçimi",
  account_balance: "Bayi bakiyesi ve para birimi yanıtı",
  product_catalog: "Benzersiz ürün ve paket kimlikleri",
  package_stock_price: "Paketin güncel stok ve alış fiyatı",
  purchase: "Satın alma isteği ve kesin ret durumları",
  idempotency: "Aynı isteğin ikinci satın almaya dönüşmesini önleyen yöntem",
  order_lookup: "Yanıt kaybında aynı işlemi yeniden sorgulama",
  license_response: "Benzersiz sipariş referansı ve lisans yanıtı",
};

export function supplierView(connection = {}) {
  const fields = [...(connection.missing || []), ...(connection.invalid || [])];
  const titles={configuration_required:"API yapılandırması eksik",contract_required:"API bilgileri kayıtlı · bağlantı tanımı bekleniyor",verification_required:"Bağlantı kontrolü bekleniyor",connection_failed:"Sağlayıcı yanıtı doğrulanamadı",connected:"Bayi hesabına bağlantı doğrulandı",stock_unverified:"Bakiye doğrulandı · stok kontrolü eksik"};
  const verified=connection.active===true && Number.isSafeInteger(connection.balanceMinor) && /^[A-Z]{3}$/.test(connection.currency);
  const balance=verified ? new Intl.NumberFormat('tr-TR',{style:'currency',currency:connection.currency}).format(connection.balanceMinor/10**(connection.minorDigits ?? 2)) : 'Doğrulanmadı';
  const update=connection.lastSuccessAt ? new Date(connection.lastSuccessAt).toLocaleString('tr-TR',{timeZone:'Europe/Istanbul'}) : '';
  return `<header class="admin-view-header supplier-header"><div><span class="eyebrow">BAYİ API YÖNETİMİ</span><h1>Hilehanem<span class="accent-dot">.</span></h1><p>Bayi API bağlantısı, alış bakiyesi ve tedarik hazırlığı.</p></div><button type="button" class="button secondary small" data-admin-action="supplier-check">${icon("refresh")}<span>Yapılandırmayı kontrol et</span></button></header>
  <div class="notice" role="status"><b>${e(titles[connection.state] || titles.verification_required)}</b><p>${verified ? 'Son doğrulama · '+e(update) : 'Bağlantı kontrolü, sağlayıcıdan güncel hesap ve paket bilgilerini okur.'}</p></div>
  <div class="stat-grid supplier-metrics"><article class="stat-card"><header><span>Hilehanem alış bakiyesi</span>${icon("wallet")}</header><div class="stat-number">${e(balance)}</div></article><article class="stat-card"><header><span>Paket stokları</span>${icon("box")}</header><div>${connection.stockSynchronization ? e(String(connection.mappingCount))+' paket doğrulandı' : 'Doğrulama bekleniyor'}</div></article><article class="stat-card"><header><span>Otomatik satın alma</span>${icon("shield")}</header><div>${connection.automaticPurchasing ? 'Etkin' : 'Kapalı'}</div></article></div>
  ${fields.length ? `<section class="panel supplier-settings"><h2>Render bağlantı alanları</h2><p>Gizli anahtar yalnızca backend ortamında tutulur. Aşağıdaki eksik veya geçersiz alanları kontrol et.</p><ul>${fields.map((name) => `<li><code>${e(name)}</code></li>`).join("")}</ul></section>` : ""}
  ${connection.contractConfigured ? "" : `<section class="panel supplier-settings"><h2>Bağlantıyı tamamlamak için gerekenler</h2><p>Hilehanem'in bayi API belgesi veya gizli değerleri çıkarılmış örnek istek ve yanıtları gereklidir.</p><ul>${(connection.requirements || Object.keys(requirements)).map((key) => `<li>${e(requirements[key] || key)}</li>`).join("")}</ul><p class="fine-print">Bu kontrol sağlayıcıdan ürün satın almaz. Önceki bağlantıdan kalmış bakiye bilgileri burada güncel bakiye olarak kullanılmaz.</p></section>`}`;
}
