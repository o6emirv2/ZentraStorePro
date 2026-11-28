import { installMaintenanceGate } from '/public/js/ui/maintenance-gate.js?v=113';
import { installAccountHub } from '/public/js/store/account-hub.js?v=117';
import { loadStoreRuntimeConfig, storeApi } from '/public/js/store/api.js?v=117';
import { installErrorReporter } from './public/js/ui/error-reporter.js?v=113';
import { bootStorefront, navigateStorefront } from '/public/js/store/storefront.js?v=117';
import { installInteractionGuard } from '/public/js/ui/interaction-guard.js?v=113';

window.__ZENTRA_RUNTIME__ = window.__ZENTRA_RUNTIME__ || { apiBase: '' };
installInteractionGuard();

function showStorefrontFailure() {
  document.documentElement.dataset.storefrontStatus = 'error';
  const loading = document.getElementById('catalogLoading');
  if (!loading) return;
  loading.hidden = false;
  loading.innerHTML = '<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><strong>Mağaza şu anda yüklenemedi</strong><span>Bağlantınızı kontrol edip sayfayı yenileyerek tekrar deneyin.</span>';
}

installMaintenanceGate({ api: async (path, options) => { await loadStoreRuntimeConfig(); return storeApi(path, options); } });
const accountHub = installAccountHub({ navigate: navigateStorefront });
window.addEventListener('zentra:open-verification', () => void accountHub.open('verification'));
bootStorefront().then(() => accountHub.restoreRoute()).catch(showStorefrontFailure);

installErrorReporter();

// Update the public-asset cache; account/API responses are never cached.
if('serviceWorker' in navigator && location.protocol==='https:') window.addEventListener('load',()=>{
  navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'}).then(async registration=>{
    const activate=()=>registration.waiting?.postMessage({type:'APPLY_UPDATE'});
    activate();registration.addEventListener('updatefound',()=>registration.installing?.addEventListener('statechange',activate));
    await registration.update();activate();
  }).catch(()=>{});
});
