import {confirmManualPayment} from './admin-dialogs.js?v=116';
import {escapeHtml as e} from './admin-core.js?v=116';
export function createWalletRequestsController({request,reauthenticate,allowed,notify}){
  let host,version=0;
  async function load(container){
    host=container;const current=++version;
    try{
      const {result}=await request('/api/admin/store/commerce/wallet-requests');if(current!==version)return;
      host.innerHTML='<h3>Bakiye Yükleme Talepleri</h3><p>Onaydan önce ödeme kaydını finans kaynağından doğrulayın. Aynı ödeme referansı ikinci kez kullanılamaz.</p>'+(result.items.length?result.items.map(row=>`<article class="admin-card"><strong>${e(row.uid)} · ${(row.amountKurus/100).toLocaleString('tr-TR',{style:'currency',currency:'TRY'})}</strong><p>${e(row.reference)} · ${e(row.status)}</p>${row.status==='pending'&&allowed()?`<button class="primary-action" type="button" data-wallet-request="${e(row.id)}" data-revision="${row.revision}" data-decision="approved">Ödemeyi Doğruladım, Onayla</button><button class="secondary-action" type="button" data-wallet-request="${e(row.id)}" data-revision="${row.revision}" data-decision="rejected">Reddet</button>`:''}</article>`).join(''):'<p>Henüz bakiye yükleme talebi yok.</p>');
      host.onclick=async event=>{
        const b=event.target.closest('[data-wallet-request]');if(!b||!allowed()||b.disabled)return;
        const confirmation=b.dataset.decision==='approved'?await confirmManualPayment():null;
        const paymentReference=confirmation?.confirmed ? confirmation.reference : '';
        if(b.dataset.decision==='approved'&&!paymentReference?.trim())return;
        b.disabled=true;
        try{if(!(await reauthenticate()))return;await request('/api/admin/store/commerce/wallet-requests/'+encodeURIComponent(b.dataset.walletRequest)+'/decision',{method:'POST',body:{expectedRevision:Number(b.dataset.revision),decision:b.dataset.decision,paymentReference:paymentReference || ''}});notify('success','Talep güncellendi','Sonuç sunucuda kaydedildi.');await load(host);}catch(error){notify('error','Talep güncellenemedi',error.message);}finally{if(b.isConnected)b.disabled=false;}
      };
    }catch(error){if(current===version)host.textContent='Bakiye talepleri yüklenemedi. '+error.message;}
  }
  return{load};
}
