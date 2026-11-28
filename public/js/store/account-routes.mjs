import {recoveryToken} from '../app/recovery-link.mjs?v=113';
export const HUB_VIEWS = Object.freeze({
  notifications: 'Bildirimlerim', preferences: 'Bildirim Tercihleri', devices: 'Cihazlarım',
  security: 'Hesap Merkezi', support: 'Destek', promotions: 'Bakiye Promosyon Kodu Kullan',
  verification: 'E-posta Doğrulama', reset: 'Şifre Yenileme',
});
const sections = { sessions: 'devices', preferences: 'preferences', privacy: 'security', security: 'security', support: 'support' };
export function accountRoute(href) {
  try {
    const u = new URL(href), entry = u.searchParams.getAll('devam');
    if (entry.length > 1) return null;
    if (entry.length) {
      if (!entry[0].startsWith('/') || entry[0].startsWith('//') || /[\\\x00-\x20\x7f]/.test(entry[0])) return null;
      const target = new URL(entry[0], u.origin);
      if (target.origin !== u.origin) return null;
      return accountRoute(target.href);
    }

    const token = recoveryToken(u.href);
    if (token || u.pathname === '/sifre-yenile.html') return { view: 'reset', token };
    if (u.searchParams.get('mode') === 'resetPassword') return { view: 'reset', firebaseCode: u.searchParams.get('oobCode') || '' };
    if (u.searchParams.get('mode') === 'verifyEmail') return { view: 'verification', firebaseCode: u.searchParams.get('oobCode') || '' };
    if (u.hash.startsWith('#merkez/')) {
      const view = u.hash.slice(8);
      return Object.hasOwn(HUB_VIEWS, view) ? { view } : null;
    }
    const p = u.pathname.replace(/\/$/, '') || '/';
    if (['/bildirimler', '/bildirimlerim.html'].includes(p)) return { view: 'notifications' };
    if (['/bildirim-tercihleri', '/bildirim-tercihleri.html'].includes(p)) return { view: 'preferences' };
    if (['/cihazlarim', '/cihazlarim.html'].includes(p)) return { view: 'devices' };
    if (['/hesap-merkezi', '/hesap-merkezi.html'].includes(p)) return { view: 'security' };
    if (['/destek', '/destek.html'].includes(p)) return { view: 'support', ticket: u.searchParams.get('ticket') || '', orderId: u.searchParams.get('order') || '' };
    if (['/promosyonlar', '/promosyon.html'].includes(p)) return { view: 'promotions' };
    if (['/eposta-dogrula', '/eposta-dogrula.html'].includes(p)) return { view: 'verification' };
    if (p === '/hesabim') {
      const action = u.searchParams.get('islem');
      if (action === 'dogrula') return { view: 'verification' };
      if (action === 'sifre-yenile') return { view: 'reset', token };
      if (action === 'giris' || action === 'kayit') return { native: action === 'kayit' ? 'register' : 'login' };
      const section = u.searchParams.get('bolum');
      if (section === 'wallet') return {view:'security', wallet:true, requestId:u.searchParams.get('talep') || '', transactionId:u.searchParams.get('hareket') || ''};
      if (section === 'gifts') return {view:'security', gifts:true, orderId:u.searchParams.get('hediye') || ''};
      return section ? {view:sections[section] || 'security'} : {native:'profile'};
    }
    if (p === '/siparisler') return { native: 'orders', orderId: u.searchParams.get('order') || '' };
    if (p === '/sepet') return { native: 'cart' };
    if (p === '/kuponlar') return { native: 'coupons' };
    if (p.startsWith('/urun/')) return { native: 'product', id: decodeURIComponent(p.slice(6)), planKey: u.searchParams.get('paket') || '', ...(u.searchParams.get('bolum')==='yorumlar' ? {reviews:true}:{}) };
    if (p.startsWith('/kategori/')) return {native:'category',id:decodeURIComponent(p.slice(10))};
    if (p === '/magaza') return { native: 'catalog' };
    return null;
  } catch { return null; }
}
