import {versionedProductImage} from './product-fields.js?v=117';
import { getProductMedia, imageRenditions, PRODUCT_MEDIA_SOURCE_PATTERN } from './product-media.js?v=117';

const SWIPE_THRESHOLD_PX = 38;
const instances = new WeakMap();

function normalizeIndex(index, total) {
  return ((Math.trunc(Number(index) || 0) % total) + total) % total;
}

function hydrateSlide(slide) {
  const image = slide?.querySelector('img[data-src]');
  const source = image?.getAttribute('data-src') || '';
  if (!image || !PRODUCT_MEDIA_SOURCE_PATTERN.test(source)) return;
  image.src = source;
  image.removeAttribute('data-src');
}

function arrowButton(direction, label) {
  const button = document.createElement('button');
  button.className = `product-gallery__arrow product-gallery__arrow--${direction}`;
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.innerHTML = direction === 'previous'
    ? '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m14.5 5.5-6 6.5 6 6.5" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" /></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m9.5 5.5 6 6.5-6 6.5" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" /></svg>';
  return button;
}

export function installProductGallery(root, product = {}) {
  if (!root) return null;
  instances.get(root)?.destroy();

  const media = getProductMedia(product);
  if (!media.length) {
    root.replaceChildren();
    return null;
  }

  const listeners = [];
  const galleryId = `gallery-${String(product.id || 'product').replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  function listen(target, event, handler, options) {
    target?.addEventListener?.(event, handler, options);
    listeners.push(() => target?.removeEventListener?.(event, handler, options));
  }

  function onImageLoad(event) {
    const image = event.target;
    const thumbnail = image?.closest?.('[data-product-gallery-thumbnail]');
    if (!thumbnail) return;
    image.hidden = false;
    thumbnail.classList.add('is-loaded');
    thumbnail.classList.remove('is-error');
    thumbnail.setAttribute('aria-busy', 'false');
  }

  const retried = new WeakSet();
  function onImageError(event) {
    const image = event.target;
    if (!(image instanceof HTMLImageElement)) return;
    const entry = image.closest('[data-product-gallery-thumbnail], [data-product-gallery-slide]');
    const failedIndex = entry ? Number(entry.dataset.productGalleryThumbnail ?? entry.dataset.productGallerySlide) : -1;
    if (failedIndex < 0 || !shell.contains(entry)) return;
    const failedSource = mediaSources[failedIndex];
    if (!failedSource) return;
    if (image.hasAttribute('srcset')) {
      image.removeAttribute('srcset');
      image.src = failedSource;
      return;
    }
    if (!retried.has(image)) {
      retried.add(image);
      const retry = new URL(failedSource, document.baseURI);
      retry.searchParams.set("retry","1");
      image.src = retry.href;
      return;
    }
    failedSources.add(failedSource);
    if (slides.length === 1) {
      const cover = versionedProductImage(product.image);
      if (cover && !failedSources.has(cover)) {
        mediaSources[0] = cover;
        const main = slides[0].querySelector('img');
        main.alt = (product.name || 'Ürün') + ' kapak görseli';
        main.removeAttribute('data-src');
        main.src = cover;
        original.href = cover;
        return;
      }
      const notice = document.createElement('p');
      notice.className = 'form-hint';
      notice.textContent = 'Bu ürünün görseli şu anda yüklenemiyor.';
      root.replaceChildren(notice);
      return;
    }
    slides.splice(failedIndex, 1)[0].remove();
    thumbnailButtons.splice(failedIndex, 1)[0].remove();
    mediaSources.splice(failedIndex, 1);
    slides.forEach((slide, position) => {
      slide.dataset.productGallerySlide = String(position);
      slide.setAttribute('aria-label', (position + 1) + ' / ' + slides.length);
      thumbnailButtons[position].dataset.productGalleryThumbnail = String(position);
      thumbnailButtons[position].setAttribute('aria-label', (position + 1) + '. görseli göster');
    });
    counter.lastElementChild.textContent = String(slides.length).padStart(2, '0');
    if (slides.length === 1) {
      for (const control of [previous, next, counter, thumbnails]) control.remove();
      slides[0].removeAttribute('role');
      slides[0].removeAttribute('aria-labelledby');
    }
    show(Math.min(index - Number(failedIndex < index), slides.length - 1), { scrollThumbnail: false });
  }

  const shell = document.createElement('div');
  shell.className = 'product-gallery';
  shell.dataset.productGallery = String(product.id || 'product');

  const viewport = document.createElement('div');
  viewport.className = 'product-gallery__viewport';
  viewport.tabIndex = 0;
  viewport.setAttribute('role', 'group');
  viewport.setAttribute('aria-roledescription', 'carousel');
  viewport.setAttribute('aria-label', `${String(product.name || 'Ürün')} görselleri`);

  const track = document.createElement('div');
  track.className = 'product-gallery__track';
  track.setAttribute('aria-live', 'off');

  media.forEach((item, index) => {
    const slide = document.createElement('figure');
    slide.className = `product-gallery__slide product-gallery__slide--${item.kind}${index === 0 ? ' is-active' : ''}`;
    slide.dataset.productGallerySlide = String(index);
    slide.id = `${galleryId}-panel-${index}`;
    if (media.length > 1) {
      slide.setAttribute('role', 'tabpanel');
      slide.setAttribute('aria-labelledby', `${galleryId}-tab-${index}`);
    }
    slide.setAttribute('aria-label', `${index + 1} / ${media.length}`);
    slide.setAttribute('aria-hidden', String(index !== 0));
    slide.toggleAttribute('inert', index !== 0);

    const image = document.createElement('img');
    if (index === 0) image.src = item.src;
    else image.dataset.src = item.src;
    image.alt = item.alt;
    image.loading = index === 0 ? 'eager' : 'lazy';
    image.decoding = 'async';
    image.draggable = false;
    image.width = item.kind === 'logo' ? 640 : 1280;
    image.height = item.kind === 'logo' ? 640 : 720;
    image.fetchPriority = index === 0 ? 'high' : 'low';
    listen(image, 'load', onImageLoad);
    listen(image, 'error', onImageError);
    slide.append(image);
    track.append(slide);
  });

  viewport.append(track);
  const previous = arrowButton('previous', 'Önceki ürün görselini göster');
  const next = arrowButton('next', 'Sonraki ürün görselini göster');
  const counter = document.createElement('span');
  counter.className = 'product-gallery__counter';
  counter.setAttribute('aria-live', 'polite');
  counter.innerHTML = `<strong>01</strong><span aria-hidden="true">/</span><span>${String(media.length).padStart(2, '0')}</span>`;

  shell.append(viewport);
  const tools = document.createElement('div');
  tools.className = 'product-gallery__controls';
  const original = document.createElement('a');
  original.className = 'product-gallery__original';
  original.textContent = 'Tam boy görseli aç';
  original.target = '_blank';
  original.rel = 'noopener noreferrer';
  if (media.length > 1) tools.append(previous, counter, next);
  tools.append(original);
  shell.append(tools);

  const thumbnails = document.createElement('div');
  thumbnails.className = 'product-gallery__thumbnails';
  thumbnails.setAttribute('role', 'tablist');
  thumbnails.setAttribute('aria-label', 'Ürün görseli seç');
  media.forEach((item, index) => {
    const button = document.createElement('button');
    button.className = `product-gallery__thumbnail product-gallery__thumbnail--${item.kind}${index === 0 ? ' is-active' : ''}`;
    button.type = 'button';
    button.dataset.productGalleryThumbnail = String(index);
    button.id = `${galleryId}-tab-${index}`;
    button.tabIndex = index === 0 ? 0 : -1;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', `${galleryId}-panel-${index}`);
    button.setAttribute('aria-selected', String(index === 0));
    button.setAttribute('aria-busy', 'true');
    button.setAttribute('aria-label', `${index + 1}. görseli göster: ${item.alt}`);
    const image = document.createElement('img');
    image.alt = '';
    image.loading = index < 3 ? 'eager' : 'lazy';
    image.decoding = 'async';
    image.draggable = false;
    image.width = item.kind === 'logo' ? 640 : 1280;
    image.height = item.kind === 'logo' ? 640 : 720;
    image.fetchPriority = 'low';
    listen(image, 'load', onImageLoad);
    listen(image, 'error', onImageError);
    const thumbnail = imageRenditions(item.src)?.thumbnail;
    if (thumbnail) image.srcset = thumbnail;
    image.src = item.src;
    button.append(image);
    thumbnails.append(button);
  });
  if (media.length > 1) shell.append(thumbnails);
  root.replaceChildren(shell);

  const failedSources = new Set();
  const mediaSources = media.map(item => item.src);
  const slides = [...track.children];
  const thumbnailButtons = [...thumbnails.children];
  const current = counter.querySelector('strong');
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  let index = 0;
  let pointer = null;

  function show(candidate, { scrollThumbnail = true } = {}) {
    index = normalizeIndex(candidate, slides.length);
    original.href = mediaSources[index];
    hydrateSlide(slides[index]);
    hydrateSlide(slides[normalizeIndex(index - 1, slides.length)]);
    hydrateSlide(slides[normalizeIndex(index + 1, slides.length)]);
    track.style.transform = `translate3d(-${index * 100}%, 0, 0)`;
    slides.forEach((slide, position) => {
      const active = position === index;
      slide.classList.toggle('is-active', active);
      slide.setAttribute('aria-hidden', String(!active));
      slide.toggleAttribute('inert', !active);
    });
    thumbnailButtons.forEach((button, position) => {
      const active = position === index;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
      if (active && scrollThumbnail) thumbnails.scrollTo({ left: Math.max(0, button.offsetLeft - thumbnails.offsetLeft - (thumbnails.clientWidth - button.clientWidth) / 2), behavior: reducedMotion ? 'auto' : 'smooth' });
    });
    if (current) current.textContent = String(index + 1).padStart(2, '0');
  }

  function onPointerDown(event) {
    if (event.target?.closest?.('button')) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointer = { id: event.pointerId, x: Number(event.clientX) || 0, y: Number(event.clientY) || 0 };
  }

  function onPointerUp(event) {
    if (!pointer || (typeof event.pointerId === 'number' && pointer.id !== event.pointerId)) return;
    const horizontal = (Number(event.clientX) || 0) - pointer.x;
    const vertical = (Number(event.clientY) || 0) - pointer.y;
    pointer = null;
    if (Math.abs(horizontal) >= SWIPE_THRESHOLD_PX && Math.abs(horizontal) > Math.abs(vertical) * 1.2) {
      show(index + (horizontal < 0 ? 1 : -1));
    }
  }

  function onKeyDown(event) {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      show(index - 1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      show(index + 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      show(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      show(slides.length - 1);
    }
  }

  listen(previous, 'click', () => show(index - 1));
  listen(next, 'click', () => show(index + 1));
  const releasePointerFocus = (event) => {
    if (event.pointerType !== 'mouse') event.currentTarget?.blur?.();
  };
  listen(previous, 'pointerup', releasePointerFocus, { passive: true });
  listen(next, 'pointerup', releasePointerFocus, { passive: true });
  listen(thumbnails, 'click', (event) => {
    const button = event.target.closest?.('[data-product-gallery-thumbnail]');
    if (button) show(Number(button.dataset.productGalleryThumbnail));
  });
  listen(thumbnails, 'keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    show(event.key === 'Home' ? 0 : event.key === 'End' ? slides.length - 1 : index + (event.key === 'ArrowRight' ? 1 : -1));
    thumbnailButtons[index]?.focus({ preventScroll: true });
  });
  listen(viewport, 'pointerdown', onPointerDown, { passive: true });
  listen(viewport, 'pointerup', onPointerUp, { passive: true });
  listen(viewport, 'pointercancel', () => { pointer = null; }, { passive: true });
  listen(viewport, 'keydown', onKeyDown);
  [...thumbnailButtons].forEach((button) => {
    const image = button.querySelector('img');
    if (!image?.complete) return;
    if (image.naturalWidth > 0) onImageLoad({ target: image });
    else onImageError({ target: image });
  });

  show(0, { scrollThumbnail: false });
  const controls = Object.freeze({
    next: () => show(index + 1),
    previous: () => show(index - 1),
    goTo: (position) => show(position),
    destroy() {
      for (const remove of listeners.splice(0)) remove();
      instances.delete(root);
    }
  });
  instances.set(root, controls);
  return controls;
}
