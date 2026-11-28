import {accountRecord} from './account-records.js?v=117';
import { accountRoute } from './account-routes.mjs?v=115';
import { storeApi, friendlyStoreError } from './api.js?v=117';
import { getStoreAuthSnapshot, subscribeStoreAuth, refreshStoreAccount, refreshStoreVerification, verifyStoreEmailCode, resendStoreEmailCode, sendStoreVerificationEmail, reauthenticateStoreSession, logoutStore, deviceMarker } from './auth.js?v=117';
import { createAccountRecovery } from '../app/account-recovery.mjs?v=117';
import { verificationMarkup, mountVerificationClock } from '../app/verification.mjs?v=117';
import { escape as e, date, money, modal, field } from '../app/ui.js?v=117';

const BASE = '/api/store/commerce';
const preferenceRows = [
  ['Yeni stok', 'stockNotifications', 'emailStockNotifications'],
  ['Ürün indirimi', 'priceNotifications', 'emailPriceNotifications'],
  ['Kupon', 'couponNotifications', 'emailCouponNotifications'],
  ['Promosyon', 'promoNotifications', 'emailPromoNotifications'],
  ['Sipariş güncellemesi', 'orderNotifications', 'emailOrderNotifications'],
  ['Lisans hatırlatması', 'licenseReminders', 'emailLicenseReminders'],
  ['Bakiye işlemleri', 'walletNotifications', 'emailWalletNotifications'],
  ['Destek yanıtı', 'supportNotifications', 'emailSupportNotifications'],
  ['Ürün yorumu daveti', null, 'emailReviewInvitations'],
  ['Kampanya', 'campaignNotifications', 'emailCampaignNotifications'],
];
const empty = (title, text = '') => `<section class="hub-empty"><i class="fa-solid fa-circle-info" aria-hidden="true"></i><h3>${e(title)}</h3><p>${e(text)}</p></section>`;
const action = (kind, label, extra = '') => `<button class="screen-button" type="button" data-hub-action="${kind}" ${extra}>${e(label)}</button>`;
const card = (title, body) => `<section class="hub-card"><h3>${e(title)}</h3>${body}</section>`;

const uid = () => getStoreAuthSnapshot().user?.uid || '';
const inboxChanged = () => window.dispatchEvent(new Event('zentra:inbox-change'));

function mountAccountSheet({ dialog, route, doc, view, recovery, open, close, navigate, requireLogin }) {
  const content = dialog.querySelector('.account-hub__content');
  const status = dialog.querySelector('.account-hub__status');
  const lifetime = new AbortController();
  const listener = { signal: lifetime.signal };
  const notificationLimit = 20;
  let generation = 0, busy = false, profile, tickets, notifications = [], nextCursor = '', filter = 'all', clock = () => {};
  const currentOwner = () => !lifetime.signal.aborted;
  const call = async (path, options) => {
    const account = uid();
    const response = await storeApi(BASE + path, {...options, signal: lifetime.signal});
    if (account !== uid() || !currentOwner()) throw new Error('Bu pencerenin oturumu sona erdi.');
    return response.result;
  };
  function announce(message, error = false) {
    if (!currentOwner()) return;
    status.textContent = message; status.dataset.error = String(error);
  }
  function preferenceMarkup() {
    const p = profile.preferences;
    return `<form id="hubPreferences"><p>E-posta ve site içi bildirimleri ayrı ayrı yönetebilirsiniz.</p><div class="hub-table-wrap"><table><thead><tr><th>Bildirim türü</th><th>Site içi</th><th>E-posta</th></tr></thead><tbody>${preferenceRows.map(([label, site, mail]) => `<tr><th scope="row">${e(label)}</th>${[site, mail].map((key, index) => !key ? '<td aria-label="Uygulanmaz">—</td>' : `<td><input type="checkbox" name="${key}" aria-label="${e(label)} ${index ? 'e-posta' : 'site içi'}" ${p[key] === true ? 'checked' : ''}></td>`).join('')}</tr>`).join('')}</tbody></table></div><p class="hub-note">Mağaza bilgilendirmeleri doğrulanmış hesaplara iletilir. Ürün yorumu davetlerini buradan kapatabilirsiniz.</p><button class="screen-button screen-button--primary" type="submit">Tercihleri Kaydet</button></form>`;
  }
  function notificationsMarkup() {
    const rows = notifications.filter(x => filter === 'all' || x.category === filter || x.type === filter);
    const categories = [...new Set(notifications.map(x => x.category || x.type).filter(Boolean))];
    return `<div class="hub-toolbar"><label>Bildirim türü<select data-hub-filter><option value="all">Tümü</option>${categories.map(x => `<option value="${e(x)}" ${filter === x ? 'selected' : ''}>${e(({security:'Hesap Güvenliği',order:'Siparişler',wallet:'Bakiye İşlemleri',stock:'Stok',coupon:'Kupon',promo:'Promosyon',price:'İndirim',support:'Destek',campaign:'Sistem Duyuruları'})[x] || x)}</option>`).join('')}</select></label>${action('read-all', 'Tümünü Okundu İşaretle')}${action('delete-read', 'Tüm Okunan Bildirimleri Sil')}</div><div class="hub-list">${rows.length ? rows.map(x => `<article class="hub-card hub-notification" data-read="${!!x.readAt}"><div><small>${date(x.createdAt)}</small><h3>${e(x.title)}</h3><p>${e(x.message)}</p></div><div class="hub-toolbar">${!x.readAt ? action('read', 'Okundu İşaretle', `data-id="${e(x.id)}"`) : '<span class="hub-note">Okundu</span>'}<a class="screen-button" data-hub-link href="${e(safeTarget(x.href))}">${e(x.actionLabel || 'İlgili Kaydı Aç')}</a></div></article>`).join('') : empty('Bildirim bulunamadı', 'Bu kategoriye ait bildirimler burada gösterilir.')}</div>${nextCursor ? action('more-notifications', 'Daha Fazla Yükle') : ''}`;
  }
  function safeTarget(value) {
    try { const target = new URL(value, location.origin); if (target.origin !== location.origin || !accountRoute(target.href)) return '/hesabim'; return target.pathname + target.search + target.hash; } catch { return '/hesabim'; }
  }
  async function render() {
    if (!currentOwner()) return;
    const version = ++generation, account = uid();
    clock(); announce(''); content.setAttribute('aria-busy', 'true');
    content.innerHTML = '<div class="hub-loading" role="status"><span class="hub-spinner"></span>Bilgiler yükleniyor…</div>';
    const current = () => currentOwner() && version === generation && account === uid() && dialog.open;
    try {
      const snapshot = getStoreAuthSnapshot();
      if (route.view === 'reset') {
        content.innerHTML = recovery.markup(route.token || '');
        await recovery.mount(content, route.token || ''); return;
      }
      if (route.view === 'verification') {
        if (snapshot.user?.emailVerified && !snapshot.verification) content.innerHTML = empty('E-posta adresiniz doğrulandı', 'Hesabınızı güvenle kullanabilirsiniz.');
        else if (snapshot.verification) { content.innerHTML = verificationMarkup(snapshot.verification); clock = mountVerificationClock(content, snapshot.verification); }
        else content.innerHTML = empty('E-posta doğrulama', 'Doğrulama işlemi için hesabınıza giriş yapın.') + action('login', 'Giriş Yap');
        return;
      }
      if (!account) {
        content.innerHTML = snapshot.ready ? empty('Hesabınıza giriş yapın', 'Bu bölüm yalnızca kendi hesabınıza ait bilgileri gösterir.') + action('login', 'Giriş Yap') : '<p role="status">Güvenli oturum kontrol ediliyor…</p>';
        return;
      }
      if (route.view === 'notifications') {
        const result = await storeApi('/api/store/notifications?inbox=1&limit=' + notificationLimit, {signal:lifetime.signal});
        if (!current()) return;
        notifications = result.notifications || []; nextCursor=result.nextCursor || "";
        content.innerHTML = notificationsMarkup();

      } else if (route.view === 'preferences') {
        const result = await call('/profile'); if (!current()) return; profile = result;
        content.innerHTML = preferenceMarkup();
      } else if (route.view === 'devices') {
        const result = await call('/sessions'); if (!current()) return;
        content.innerHTML = `<p class="hub-note">Konum bilgisi doğrulanmadığında gösterilmez. Oturum sonlandırma sunucuda uygulanır.</p><div class="hub-toolbar">${action('revoke-others', 'Diğer Cihazlardan Çıkış')}${action('revoke-all', 'Bütün Cihazlardan Çıkış')}</div>${result.length ? result.map(x => card(x.label || 'Bilinmeyen cihaz', `<p>Son etkinlik: ${date(x.lastSeenAt)}</p><p>${x.current ? 'Bu cihaz · ' : ''}${x.revokedAt ? 'Sonlandırıldı' : 'Geçerli oturum'}</p>${!x.revokedAt ? action('revoke-device', 'Oturumu Sonlandır', `data-id="${e(x.id)}"`) : ''}`)).join('') : empty('Cihaz kaydı bulunamadı')}`;
      } else if (route.view === 'security' || route.view === 'order') {
        if (route.orderId || route.gifts || route.transactionId || route.requestId) {
          const html=await accountRecord(route,call);
          if (current()) content.innerHTML=html;
          return;
        }
        if(route.wallet){
          const [requests,ledger]=await Promise.all([call('/wallet-requests'),call('/wallet')]);if(!current())return;
          content.innerHTML=card('Bakiye Yükleme Talebi',`<p>Talep oluşturmak bakiyeyi artırmaz. Ödemeniz finans ekibince doğrulandıktan sonra bakiye hesabınıza işlenir.</p><form id="hubWalletRequest">${field('amount','Tutar (TL)','number','','required min="0.01" max="1000000" step="0.01"')}${field('reference','Ödeme Açıklaması / Referansı','text','','required maxlength="160"')}<button class="screen-button screen-button--primary" type="submit">Talep Oluştur</button></form>`)+card('Yükleme Taleplerim',requests.items.length?requests.items.map(x=>`<p>${money(x.amountKurus)} · ${e(x.status)} · ${date(x.createdAt)}</p>`).join(''):empty('Henüz talebiniz yok'))+card('Bakiye Hareketlerim',ledger.items.length?ledger.items.map(x=>`<p>${money(x.amountKurus)} · ${e(x.reason || x.type)} · ${date(x.createdAt)}</p>`).join(''):empty('Henüz bakiye hareketiniz yok'));return;
        }

        const accountData = snapshot.account || {};
        content.innerHTML = card('Hesap Bilgileri', `<dl class="hub-details"><div><dt>Kullanıcı adı</dt><dd>${e(accountData.username || '—')}</dd></div><div><dt>E-posta</dt><dd>${e(snapshot.user?.email || '—')}</dd></div><div><dt>E-posta durumu</dt><dd>${snapshot.user?.emailVerified ? 'Doğrulandı' : 'Doğrulama bekliyor'}</dd></div><div><dt>Bakiye</dt><dd>${snapshot.account && !snapshot.accountStale ? money(accountData.availableBalanceKurus ?? accountData.balanceKurus) : 'Güncel bakiye doğrulanamadı'}</dd></div></dl><div class="hub-toolbar">${action('wallet', 'Bakiye Yükle ve Geçmiş')}${action('edit-profile', 'Bilgilerimi Düzenle')}${action('edit-password', 'Şifremi Değiştir')}</div>`) + card('Güvenlik ve Gizlilik', `<div class="hub-toolbar">${action('devices', 'Cihazlarım')}${action('preferences', 'Bildirim Tercihleri')}${action('export', 'Verilerimi İndir')}${action('delete-request', 'Hesap Silme Talebi')}</div><p class="hub-note">Kritik işlemlerde mevcut şifrenizle yeniden doğrulama istenir. Gerekli finans ve denetim kayıtları saklama politikasına göre korunur.</p>`);
      } else if (route.view === 'promotions') {
        content.innerHTML = card('Bakiye kodunu kullan', `<p>Kodun ödülü ve kullanım hakkı sunucuda doğrulanır.</p><form id="hubPromotion">${field('code', 'Promosyon Kodu', 'text', '', 'required maxlength="32" autocomplete="off" autocapitalize="characters"')}<button type="submit" class="screen-button screen-button--primary">Kodu Kullan</button></form><p class="hub-note">Sepet indirim kuponları Kuponlarım bölümünden kullanılır.</p>${action('coupons', 'Kuponlarıma Git')}`);
      } else if (route.view === 'support') {
        if (route.ticket) { const ticket = await call('/tickets/' + encodeURIComponent(route.ticket)); if (!current()) return; tickets = ticket; const attachments = await call('/tickets/' + encodeURIComponent(route.ticket) + '/attachments'); if (!current()) return; content.innerHTML = ticketMarkup(ticket, attachments); }
        else { const result = await call('/tickets'); if (!current()) return; content.innerHTML = action('new-ticket', 'Yeni Destek Talebi') + (result.items?.length ? result.items.map(x => card(x.subject, `<p>${e(x.orderNumber || 'Genel destek')} · ${e(x.category || 'Genel')} · ${e(x.status)} · ${date(x.updatedAt)}</p>${action('ticket', 'Görüşmeyi Aç', `data-id="${e(x.id)}"`)}`)).join('') : empty('Henüz destek talebiniz yok', 'Yeni talep oluşturarak destek ekibine ulaşabilirsiniz.')); }
      }
    } catch (error) { if (current()) { content.innerHTML = empty('Bilgiler yüklenemedi', friendlyStoreError(error)) + action('reload', 'Yeniden Dene'); announce('İşlem tamamlanamadı.', true); } }
    finally { if (current()) content.setAttribute('aria-busy', 'false'); }
  }
  function ticketMarkup(ticket, attachments = []) {
    return action('support-list', 'Taleplerime Dön') + card(ticket.subject, `<p>Takip numarası <code>${e(ticket.id)}</code></p><p>${e(ticket.category || 'Genel')} · ${e(ticket.status)}</p><div class="hub-messages">${(ticket.messages || []).map(x => `<article data-role="${e(x.role)}"><strong>${x.role === 'staff' ? 'Destek Ekibi' : 'Siz'}</strong><small>${date(x.createdAt)}</small><p>${e(x.message)}</p></article>`).join('')}</div><section class="hub-attachments"><h4>Dosya Ekleri</h4>${attachments.map(x => action('download-attachment', x.name + ' (' + Math.ceil(x.size/1024) + ' KB)', `data-id="${e(x.id)}"`)).join('')}<form id="hubAttachment"><label class="field"><span>PNG, JPEG veya PDF · En fazla 2 MB</span><input type="file" name="file" accept="image/png,image/jpeg,application/pdf" required></label><button class="screen-button" type="submit">Dosya Ekle</button></form></section><form id="hubTicketReply"><label class="field"><span>Mesajınız</span><textarea name="message" rows="3" required maxlength="4000"></textarea></label><button class="screen-button screen-button--primary" type="submit">Mesaj Gönder</button></form><div class="hub-toolbar">${action(ticket.status === 'resolved' ? 'ticket-reopen' : 'ticket-close', ticket.status === 'resolved' ? 'Talebi Yeniden Aç' : 'Talebi Kapat')}</div>`);
  }
  async function reauthenticate() {
    return new Promise(resolve => {
      const handle = modal({ title: 'Hesabınızı Doğrulayın', body: field('password', 'Güncel Şifreniz', 'password', '', 'required autocomplete="current-password"'), submit: 'Doğrula', onSubmit: async data => { await reauthenticateStoreSession(String(data.get('password') || '')); resolve(true); } });
      handle.element.addEventListener('close', () => resolve(false), { once: true });
    });
  }
  async function run(kind, button) {
    if (!currentOwner() || busy || view.ZENTRA_MAINTENANCE?.active) return;
    if (kind === 'login') return requireLogin(route);
    if (['devices', 'preferences', 'support-list'].includes(kind)) return open(kind === 'support-list' ? 'support' : kind);
    if (kind === 'edit-profile' || kind === 'edit-password' || kind === 'coupons') { close({navigateAway:true}); navigate(kind === 'coupons' ? 'coupons' : kind === 'edit-password' ? 'password' : 'profile'); return; }
    if (kind === 'order-record') return open('security', {orderId:button.dataset.id});
    if (kind === 'wallet') return open('security', {wallet:true});
    if (kind === 'ticket') return open('support', { ticket: button.dataset.id });
    if (kind === 'new-ticket') {
      let requestKey=crypto.randomUUID(),signature='';
      modal({ title: 'Yeni Destek Talebi', body: `<label class="field"><span>Kategori</span><select name="category"><option value="general">Genel</option><option value="order">Sipariş</option><option value="payment">Ödeme ve Bakiye</option><option value="technical">Teknik Destek</option></select></label>${field('orderId', 'Sipariş Kimliği (isteğe bağlı)', 'text', route.orderId || '', 'maxlength="100"')}${field('subject', 'Konu', 'text', '', 'required maxlength="120"')}<label class="field"><span>Açıklama</span><textarea name="message" required maxlength="4000" rows="5"></textarea></label>`, submit: 'Talep Oluştur', onSubmit: async data => { const next=JSON.stringify(Object.fromEntries(data));if(signature&&signature!==next)requestKey=crypto.randomUUID();signature=next;const ticket=await call('/tickets', { body: { ...Object.fromEntries(data), idempotencyKey: requestKey } }); route.ticket=ticket.id; await render(); announce('Destek talebiniz kaydedildi. Takip numarası '+ticket.id); } }); return;
    }
    if (kind === 'show-delivery') {
      button.disabled=true;
      const order=route.orderId, user=uid(), version=generation;
      try {
        const result=await storeApi('/api/store/orders/'+encodeURIComponent(order)+'/delivery',{auth:'bearer'});
        if (user!==uid() || version!==generation || !dialog.open) return;
        const region=doc.createElement('div');
        region.className = 'hub-delivery';
        for (const item of result.delivery?.items || []) {
          const value = item.copyValue || item.key;
          if (!value) continue;
          const line = doc.createElement('p'), code = doc.createElement('code'), copy = doc.createElement('button');
          line.textContent = [item.productName, item.planLabel].filter(Boolean).join(' · ');
          code.textContent = value;
          copy.type = 'button'; copy.className = 'screen-button'; copy.textContent = 'Kopyala';
          copy.addEventListener('click', async () => {
            if (!currentOwner() || user !== uid() || !region.isConnected) return;
            try { await view.navigator.clipboard.writeText(code.textContent); announce('Teslimat bilgisi kopyalandı.'); }
            catch { announce('Panoya erişilemedi. Tekrar deneyin.', true); }
          });
          region.append(line, code, copy);
        }
        if (!region.childElementCount) throw Error('STORE_DELIVERY_NOT_READY');
        button.after(region);
        const remove = () => {
          view.clearTimeout(timer); doc.removeEventListener('visibilitychange', hidden);
          region.replaceChildren(); region.remove(); button.disabled = false;
        };
        const hidden = () => { if (doc.hidden) remove(); };
        const timer = view.setTimeout(remove,30000);
        doc.addEventListener('visibilitychange',hidden); clock = remove;
      } catch (error) { if (user===uid() && version===generation) { announce(friendlyStoreError(error),true);button.disabled=false; } }
      return;
    }
    busy = true; button.disabled = true; announce('İşlem doğrulanıyor…');
    const account = uid();
    try {
      if (kind === 'reload') await render();
      else if (kind === 'more-notifications') { const result=await storeApi('/api/store/notifications?inbox=1&limit='+notificationLimit+'&cursor='+encodeURIComponent(nextCursor)); if(!currentOwner() || account!==uid())return; notifications.push(...(result.notifications || [])); nextCursor=result.nextCursor || ''; content.innerHTML=notificationsMarkup(); }
      else if (['read', 'read-all', 'delete-read'].includes(kind)) {
        if (kind === 'read') {
          await storeApi('/api/store/notifications/' + encodeURIComponent(button.dataset.id) + '/read', {method:'PATCH', body:{}});
        } else {
          let cursor = '', snapshot = '', changed = 0;
          if(kind==='delete-read'){
            const preview=await storeApi('/api/store/notifications/delete-preview',{signal:lifetime.signal});
            if(!currentOwner() || account!==uid())return;
            if(!preview.count){announce('Silinecek okunmuş bildirim yok.');return;}
            const confirmed=await new Promise(resolve=>{
              let approved=false;
              const prompt=modal({title:'Okunan bildirimler silinsin mi?',body:'<p>'+Number(preview.count)+' okunmuş bildirim gelen kutunuzdan silinecek.</p>',submit:'Bildirimleri Sil',danger:true,onSubmit:()=>{approved=true;}});
              prompt.element.addEventListener('close',()=>resolve(approved),{once:true});
            });
            if(!confirmed || !currentOwner() || account!==uid()){announce('');return;}
            snapshot=preview.snapshot;
          }
          do {
            const result = await storeApi('/api/store/notifications/' + kind, {body:{cursor,snapshot}, signal:lifetime.signal});
            if (!currentOwner() || account !== uid()) return;
            if (!result.complete && (!result.nextCursor || cursor === result.nextCursor)) throw new Error('Bildirim işlemi tamamlanamadı.');
            changed+=Number(result.changed)||0; cursor = result.nextCursor || '';
          } while (cursor);
          if(kind==='delete-read'){
            inboxChanged();await render();announce(changed+' okunmuş bildirim silindi.');return;
          }
        }
        if (!currentOwner() || account !== uid()) return;
        inboxChanged();
        await render();
        announce('Okunma durumu kaydedildi.');
      } else if (kind.startsWith('revoke-')) {
        if (!(await reauthenticate()) || account !== uid()) return;
        const mode = kind === 'revoke-all' ? 'all' : kind === 'revoke-others' ? 'others' : 'selected';
        const result = await call('/sessions/revoke', { body: { mode, ...(mode === 'selected' ? { sessionId: button.dataset.id } : {}), ...deviceMarker() } });
        if (result.signInRequired) { await logoutStore(); busy = false; close({navigateAway:true}); navigate('login'); } else await render();
      } else if (kind === 'download-attachment') {
        const result = await storeApi(BASE + '/attachments/' + encodeURIComponent(button.dataset.id), {binary:true});
        if (!currentOwner() || account !== uid()) return;
        const url=URL.createObjectURL(result.blob),a=doc.createElement('a');a.href=url;a.download=result.name || 'destek-eki';a.click();view.setTimeout(()=>URL.revokeObjectURL(url),1000);
      } else if (kind === 'export') {
        if (!(await reauthenticate()) || account !== uid()) return;
        const result = await call('/export'); const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
        const a = doc.createElement('a'); a.href = url; a.download = 'zentra-hesap-verilerim.json'; a.click(); view.setTimeout(() => URL.revokeObjectURL(url), 1000); announce('Verileriniz hazırlandı.');
      } else if (kind === 'delete-request') {
        if (!(await reauthenticate()) || account !== uid()) return;
        await call('/data-requests', { body: { kind: 'deletion', message: 'Hesabımın silinmesini talep ediyorum.', idempotencyKey: crypto.randomUUID() } }); announce('Hesap silme talebiniz alındı. Sonuç destek ekibi tarafından bildirilecektir.');
      } else if (kind === 'ticket-close' || kind === 'ticket-reopen') {
        await call('/tickets/' + encodeURIComponent(tickets.id) + '/state', { body: { expectedRevision: tickets.revision, status: kind === 'ticket-close' ? 'resolved' : 'open' } }); await render();
      } else if (kind.startsWith('verification-')) {
        if (kind === 'verification-resend') await resendStoreEmailCode();
        else if (kind === 'verification-complete') await refreshStoreVerification({ complete: true });
        else if (kind === 'verification-switch') { await logoutStore(); busy = false; close({navigateAway:true}); navigate('login'); return; }
        else await refreshStoreVerification();
        await render();
      }
    } catch (error) { if (account === uid()) announce(friendlyStoreError(error), true); }
    finally { busy = false; if (button.isConnected) button.disabled = false; }
  }
  async function submit(event) {
    const form = event.target;
    if (!['hubPreferences', 'hubPromotion', 'hubTicketReply', 'hubAttachment', 'hubWalletRequest', 'verification-form'].includes(form.id)) return;
    event.preventDefault();
    if (busy || view.ZENTRA_MAINTENANCE?.active || !form.reportValidity()) return;
    busy = true; const account = uid(), button = form.querySelector('[type=submit]'), data = new FormData(form); button.disabled = true; announce('İşlem doğrulanıyor…');
    try {
      if (form.id === 'hubPreferences') {
        const preferences = Object.fromEntries(preferenceRows.flatMap(([, a, b]) => [a,b].filter(Boolean).map(key=>[key,data.has(key)])));
        profile = await call('/profile', { method: 'PATCH', body: { expectedRevision: profile.revision, preferences } }); announce('Bildirim tercihleriniz kaydedildi.'); inboxChanged();
      } else if (form.id === 'hubPromotion') {
        const response = await storeApi('/api/store/balance-codes/redeem', { body: { code: data.get('code') } });
        if (!currentOwner() || account !== uid()) return; await refreshStoreAccount({ force: true }); announce(response.result?.idempotentReplay || response.idempotentReplay ? 'Bu kod hesabınızda daha önce kullanılmıştır.' : 'Promosyon sonucu doğrulandı. Bakiyeniz güncellendi.'); form.reset();
      } else if (form.id === 'hubWalletRequest') {
        const raw=String(data.get('amount') || '').trim().replace(',','.');if(!/^\d+(?:\.\d{1,2})?$/.test(raw)) throw new Error('Geçerli bir tutar yazın.');
        const [whole,fraction='']=raw.split('.'),amountKurus=Number(whole)*100+Number(fraction.padEnd(2,'0'));
        await call('/wallet-requests',{body:{amountKurus,reference:data.get('reference'),idempotencyKey:form.dataset.requestKey || (form.dataset.requestKey=crypto.randomUUID())}});await render();announce('Bakiye yükleme talebiniz alındı.');
      } else if (form.id === 'hubAttachment') {
        const file=data.get('file'); if (!file?.size || file.size>2*1024*1024) throw new Error('Dosya en fazla 2 MB olmalıdır.');
        const bytes=new Uint8Array(await file.arrayBuffer()); let binary=''; for (const chunk of bytes) binary+=String.fromCharCode(chunk);
        await call('/tickets/' + encodeURIComponent(tickets.id) + '/attachments', {body:{name:file.name, contentType:file.type, data:btoa(binary), idempotencyKey:form.dataset.requestKey || (form.dataset.requestKey=crypto.randomUUID())}}); await render(); announce('Dosyanız kaydedildi.');
      } else if (form.id === 'hubTicketReply') {
        await call('/tickets/' + encodeURIComponent(tickets.id) + '/reply', { body: { expectedRevision: tickets.revision, message: data.get('message') } }); await render(); announce('Mesajınız kaydedildi.');
      } else { await verifyStoreEmailCode(data.get('code')); await render(); announce('E-posta doğrulama sonucu güncellendi.'); }
    } catch (error) { if (account === uid()) announce(friendlyStoreError(error), true); }
    finally { busy = false; if (button.isConnected) button.disabled = false; }
  }
  dialog.addEventListener('submit', submit, listener);
  dialog.addEventListener('change', event => {
    if (event.target.matches('[data-hub-filter]')) { filter = event.target.value; content.innerHTML = notificationsMarkup(); content.querySelector('select')?.focus({preventScroll:true}); }
  }, listener);
  dialog.addEventListener('click', event => {
    const button = event.target.closest('[data-hub-action],[data-action^="verification-"]');
    if (button) void run(button.dataset.hubAction || button.dataset.action, button);
  }, listener);
  dialog.addEventListener('cancel', event => {event.preventDefault(); close();}, listener);
  return {
    dialog, route, render,
    get busy() { return busy || recovery.busy; },
    dispose() {
      lifetime.abort(); generation++; clock(); recovery.dispose(); dialog.close();
      content.replaceChildren(); status.textContent = ''; content.scrollTop = 0;
    }
  };
}

export function installAccountHub({ navigate, doc = document, view = window } = {}) {
  let active, opener, pendingLogin, ready = false, authKey, owner = uid();
  let closing = 0;
  const recovery = createAccountRecovery({ api: async (path, options) => {
    try { return await storeApi(path, options); }
    catch (err) { throw Object.assign(new Error(friendlyStoreError(err)), {code:err.code}); }
  }});
  const sheets = new Map([...doc.querySelectorAll('[data-account-sheet]')].map(d => [d.dataset.accountSheet, d]));
  function dismiss() {
    clearTimeout(closing); closing = 0;
    if (!active) return;
    active.dialog.classList.remove('sheet-closing');
    active.dispose(); active = null;
  }
  function close({ history: changeHistory = true, navigateAway = false } = {}) {
    if (!active || closing || active.busy) return;
    const finish = () => {
      dismiss();
      if (changeHistory) {
        const entry = view.history.state;
        if (entry?.zentraHub && !navigateAway) view.history.back();
        else view.history.replaceState(entry?.beforeState || null, '', entry?.beforeUrl || '/');
      }
      if (opener?.isConnected && !opener.closest('[inert],[hidden]')) opener.focus({preventScroll:true});
    };
    if (navigateAway || !changeHistory || view.matchMedia('(prefers-reduced-motion: reduce)').matches) finish();
    else { active.dialog.classList.add('sheet-closing'); closing = view.setTimeout(finish, 145); }
  }
  function requireLogin(route) {
    pendingLogin = {...route}; close({navigateAway:true}); navigate('login');
  }
  async function open(which, options = {}) {
    const selected = which === 'security' && options.orderId ? 'order' : which;
    const dialog = sheets.get(selected);
    if (!dialog || active?.busy || view.ZENTRA_MAINTENANCE?.active) return;
    const trigger = options.trigger || doc.activeElement;
    if (!active || !active.dialog.contains(trigger)) opener = trigger;
    if(active && options.history!==false && view.history.state?.zentraHub){
      const at=active.dialog.querySelector('.account-hub__content');
      view.history.replaceState({...view.history.state,hubScroll:at.scrollTop,hubFocus:trigger?.dataset?.hubAction || ''},'',view.location.href);
    }
    dismiss();
    const route = {...options, view:selected};
    if (options.history !== false && which !== 'reset') {
      const prior = view.history.state;
      const target = {wallet:!!options.wallet, gifts:!!options.gifts, orderId:options.orderId || '', ticket:options.ticket || '', transactionId:options.transactionId || '', requestId:options.requestId || ''};
      const state = {zentraHub:true, options:target, beforeState:prior?.zentraHub ? prior.beforeState : prior, beforeUrl:prior?.beforeUrl || view.location.href};
      view.history.pushState(state, '', '#merkez/' + (selected === 'order' ? 'security' : which));
    }
    active = mountAccountSheet({dialog, route, doc, view, recovery, open, close, navigate, requireLogin});
    dialog.showModal();
    dialog.querySelector('[data-hub-close]').focus({preventScroll:true});
    const sheet=active;
    await sheet.render();
    if (active===sheet && options.history===false && view.history.state?.zentraHub) {
      const content=dialog.querySelector('.account-hub__content');
      content.scrollTop=view.history.state.hubScroll || 0;
      const control=[...content.querySelectorAll('[data-hub-action]')].find(el=>el.dataset.hubAction===view.history.state.hubFocus);
      control?.focus({preventScroll:true});
    }
  }
  function restoreRoute() {
    ready = true;
    if (view.ZENTRA_MAINTENANCE?.active || view.history.state?.zentraDialog) return;
    const target = accountRoute(location.href);
    if (!target) { dismiss(); return; }
    if (target.native === 'orders' && target.orderId) return void open('order',{...target,history:false});
    if (target.native) { dismiss(); navigate(target.native, target); }
    else void open(target.view,{...target,...(view.history.state?.zentraHub ? view.history.state.options : {}),history:false});
  }
  doc.addEventListener('click', event => {
    const trigger = event.target.closest?.('[data-hub-open],[data-hub-close],[data-hub-link],#forgotPasswordButton,#forgotUsernameButton');
    if (!trigger) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (trigger.matches('#forgotPasswordButton,#forgotUsernameButton')) {
      const username = trigger.id === 'forgotUsernameButton', identifier = doc.getElementById('loginIdentifier')?.value.trim() || '';
      trigger.focus({preventScroll:true});
      return recovery.request(username ? 'username' : 'password', !username || identifier.includes('@') ? identifier : '');
    }
    if (trigger.hasAttribute('data-hub-close')) return close();
    if (trigger.hasAttribute('data-hub-open')) return void open(trigger.dataset.hubOpen,{trigger,orderId:trigger.dataset.hubOrder});
    const next = accountRoute(trigger.href);
    if (!next) return;
    if (next.native === 'orders' && next.orderId) void open('order', next);
    else if (next.native) { close({navigateAway:true}); navigate(next.native,next); }
    else void open(next.view,next);
  }, true);
  view.addEventListener('popstate', () => { if (ready && !doc.querySelector('dialog.app-dialog[open]')) restoreRoute(); });
  view.addEventListener('zentra:maintenance-change', event => { if (!event.detail.active && ready) restoreRoute(); });
  subscribeStoreAuth(snapshot => {
    const key = JSON.stringify([uid(),snapshot.ready,snapshot.verification?.challengeId,snapshot.verification?.state,snapshot.user?.emailVerified]);
    if (key === authKey) return;
    authKey = key;
    if (owner && owner !== uid()) {
      dismiss(); pendingLogin = null;
      doc.querySelectorAll('dialog.app-dialog[open]').forEach(d => { d.close(); d.remove(); });
    }
    owner = uid();
    if (pendingLogin && owner) {const target = pendingLogin; pendingLogin = null; void open(target.view,target);}
    else if (active && !active.busy && active.route.view !== 'reset') void active.render();
  });
  return {open, close, restoreRoute};
}
