import { repositoryImages } from '../public/data/repository-images.mjs?v=117';
import { defaultShowcaseRows } from '../public/js/store/product-media.js?v=117';
import { versionedProductImage } from '../public/js/store/product-fields.js?v=117';
import { rememberForms } from '../public/js/ui/app-ui.js?v=113';
import { escapeHtml as escape } from './admin-core.js?v=116';

export function createShowcaseEditor({ form, request, authorize, canWrite }) {
  const fieldset = form.querySelector('fieldset');
  const list = form.querySelector('#showcaseRows');
  const picker = form.querySelector('#showcaseSource');
  const status = form.querySelector('#showcaseStatus');
  const reload = form.querySelector('[data-slide-reload]');
  let rows = [], products = [], revision = 0, dirty = false, saving = false, ready = false;
  let sources = new Map();

  function updateCount() {
    form.querySelector('#showcaseCount').textContent = `${rows.filter(row => row.enabled).length} yayında · ${rows.length} görsel`;
  }

  function render() {
    const included = new Set(rows.map(row => row.image));
    const available = [...sources].filter(([image]) => !included.has(image));
    picker.replaceChildren(new Option('Bir görsel seçin', ''), ...available.map(([image, item]) => new Option(item.label, image)));
    form.querySelector('[data-slide-add]').disabled = !available.length || rows.length >= 200;
    const productOptions = products.map(product => [product.id, [product.name, product.category].filter(Boolean).join(' · ')]);
    list.innerHTML = rows.map((row, index) => {
      const fallback = row.image.split('/').pop().split('?')[0];
      const label = row.title || fallback;
      return `<li data-slide-index="${index}">
        <img src="${escape(versionedProductImage(row.image))}" alt="" width="60" height="48" loading="lazy">
        <div class="showcase-row-main"><strong>${index + 1}. ${escape(label)}</strong><small title="${escape(row.image)}">${escape(fallback)}</small>
          <label class="slide-visible"><input type="checkbox" data-slide-field="enabled" ${row.enabled ? 'checked' : ''}> Yayında</label>
        </div>
        <div class="showcase-row-controls"><button type="button" data-slide-move="-1" aria-label="${index + 1}. slaytı yukarı taşı" ${index === 0 ? 'disabled' : ''}>↑</button><button type="button" data-slide-move="1" aria-label="${index + 1}. slaytı aşağı taşı" ${index === rows.length - 1 ? 'disabled' : ''}>↓</button><button type="button" data-slide-remove aria-label="${index + 1}. slaytı kaldır">×</button></div>
        <details><summary>Slayt ayarları</summary><label>Başlık<input data-slide-field="title" maxlength="80" value="${escape(row.title)}"></label>
        <label>Ürün bağlantısı<select data-slide-field="productId"><option value="">Görselle eşleşen ürün</option>${productOptions.map(([id, name]) => `<option value="${escape(id)}" ${id === row.productId ? 'selected' : ''}>${escape(name)}</option>`).join('')}</select></label>
        <label>Listedeki sıra<input data-slide-position type="number" min="1" max="${rows.length}" value="${index + 1}"></label></details>
      </li>`;
    }).join('');
    updateCount();
    fieldset.disabled = !ready || saving || !canWrite();
  }

  function load(settings, options, { force = false } = {}) {
    if (dirty && !force) return;
    products = Array.isArray(options) ? options : [];
    sources = new Map(Object.keys(repositoryImages).map(image => [image, { label: image.replace(/^\/public\/assets\//, ''), productId: '' }]));
    for (const product of products) {
      for (const image of [product.image, ...product.galleryPaths || []]) {
        if (!image || !versionedProductImage(image)) continue;
        const label = `${product.name} · ${image.split('/').pop().split('?')[0]}`;
        if (!sources.get(image)?.productId) sources.set(image, { label, productId: product.id });
      }
    }
    rows = (settings.showcaseSlides ?? defaultShowcaseRows()).map(row => ({ ...row }));
    revision = settings.showcaseRevision || 0;
    dirty = false;
    ready = true;
    reload.hidden = true;
    status.textContent = '';
    render();
    rememberForms(form);
  }

  function changed() {
    dirty = true;
    status.textContent = 'Yayımlanmamış değişiklikler var.';
  }

  function move(from, to) {
    if (!Number.isInteger(to) || to < 0 || to >= rows.length || from === to) return;
    rows.splice(to, 0, rows.splice(from, 1)[0]);
    changed();
    render();
    list.children[to]?.querySelector('summary')?.focus();
  }

  form.addEventListener('input', event => {
    const field = event.target.dataset.slideField;
    if (!field || !canWrite()) return;
    const entry = event.target.closest('[data-slide-index]');
    const index = Number(entry.dataset.slideIndex);
    rows[index][field] = field === 'enabled' ? event.target.checked : event.target.value;
    if (field === 'title') entry.querySelector('strong').textContent = (index + 1) + '. ' + (event.target.value || 'Görsel');
    changed();
    updateCount();
  });
  form.addEventListener('change', event => {
    if (event.target.hasAttribute('data-slide-position') && canWrite()) {
      const index = Number(event.target.closest('li').dataset.slideIndex);
      if (event.target.checkValidity()) move(index, Number(event.target.value) - 1);
    }
  });
  form.addEventListener('click', async event => {
    const button = event.target.closest('button[type=button]');
    if (!button || saving) return;
    if (button === reload) {
      reload.disabled = true;
      try {
        const response = await request('/api/admin/store/content');
        load(response.storefront, response.showcaseProducts, { force: true });
      } catch (error) { status.textContent = error.message; }
      finally { reload.disabled = false; }
      return;
    }
    if (!canWrite() || !ready) return;
    if (button.hasAttribute('data-slide-add')) {
      const image = picker.value;
      if (!image || rows.some(row => row.image === image)) { picker.focus(); return; }
      const productId = sources.get(image)?.productId || '';
      rows.push({ image, title: products.find(product => product.id === productId)?.name || '', productId, enabled: true });
      changed(); render(); list.lastElementChild?.querySelector('summary')?.focus();
    } else if (button.hasAttribute('data-slide-hide')) {
      rows.forEach(row => { row.enabled = false; });
      changed(); render();
    } else {
      const item = button.closest('[data-slide-index]');
      if (!item) return;
      const index = Number(item.dataset.slideIndex);
      if (button.hasAttribute('data-slide-move')) move(index, index + Number(button.dataset.slideMove));
      if (button.hasAttribute('data-slide-remove')) {
        rows.splice(index, 1); changed(); render();
        (list.children[Math.min(index, rows.length - 1)]?.querySelector('summary') || picker).focus();
      }
    }
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving || !ready || !canWrite()) return;
    saving = true;
    fieldset.disabled = true;
    try {
      if (!await authorize()) return;
      const response = await request('/api/admin/store/content', {
        method: 'PATCH', body: { expectedShowcaseRevision: revision, showcaseSlides: rows }, timeoutMs: 30000
      });
      if (!response.ok || !Array.isArray(response.storefront?.showcaseSlides)) throw Error('Yayın sonucu doğrulanamadı.');
      load(response.storefront, products, { force: true });
      status.textContent = rows.some(row => row.enabled) ? 'Slayt sırası ve görünürlük kaydedildi.' : 'Ana sayfa slaytları yayından kaldırıldı.';
    } catch (error) {
      status.textContent = error.message;
      reload.hidden = error.code !== 'STORE_SHOWCASE_CONFLICT';
    } finally {
      saving = false;
      fieldset.disabled = !canWrite();
    }
  });
  return { load };
}
