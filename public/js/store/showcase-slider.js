import { SHOWCASE_MEDIA, imageRenditions } from './product-media.js?v=117';

const instances = new WeakMap();
const interval = 5000;

export function installShowcaseSlider(root, { media = SHOWCASE_MEDIA, resolveProduct = () => null, openProduct } = {}) {
  if (!root || !media.length) return null;
  if (instances.has(root)) return instances.get(root);

  const track = root.querySelector('[data-showcase-track]');
  const toggle = root.querySelector('[data-showcase-toggle]');
  const viewport = root.querySelector('[data-showcase-viewport]');
  const toolbar = root.querySelector('[data-showcase-controls]');
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const failed = new Set();
  let paused = motion.matches, focusPaused = false, visible = true;
  let current = 0, sequence = 0, timer, pointer, swiped = false;

  const slides = media.map((entry, index) => {
    const panel = document.createElement('figure');
    panel.className = 'showcase-slide';
    panel.dataset.showcaseSlide = index;
    panel.setAttribute('aria-hidden', 'true');
    panel.inert = true;
    const img = new Image();
    img.alt = entry.alt || entry.groupLabel || 'Vitrin görseli';
    img.draggable = false;
    img.decoding = 'async';
    if (!index) img.fetchPriority = 'high';
    const product = resolveProduct(entry);
    if (product) {
      const link = document.createElement('a');
      link.href = '/urun/' + encodeURIComponent(product.id);
      link.setAttribute('aria-label', product.name + ' ürününü incele');
      link.append(img);
      link.addEventListener('click', event => {
        if (swiped && event.detail) { event.preventDefault(); return; }
        if (!openProduct || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        openProduct(product.id, link);
      }, options);
      panel.append(link);
    } else panel.append(img);
    return panel;
  });
  track.replaceChildren(...slides);
  toolbar.hidden = slides.length < 2;

  function loadImage(index) {
    const image = slides[index].querySelector('img');
    if (!image.hasAttribute('src')) {
      const source = media[index].src;
      const variant = imageRenditions(source);
      if (variant?.medium) {
        image.sizes = '100vw';
        image.srcset = variant.medium + ' 720w, ' + encodeURI(source).replaceAll(',', '%2C') + ' ' + variant.width + 'w';
      }
      image.src = source;
    }
    return image;
  }

  async function decodeImage(index) {
    const image = loadImage(index);
    try { await image.decode(); } catch (error) {
      if (!image.hasAttribute('srcset')) throw error;
      image.removeAttribute('srcset');
      image.src = media[index].src;
      await image.decode();
    }
  }

  function schedule() {
    clearTimeout(timer);
    if (paused || focusPaused || pointer || document.hidden || !visible || slides.length - failed.size < 2) return;
    timer = setTimeout(() => show(current + 1), interval);
  }
  function setPaused(value) {
    paused = value;
    toggle.setAttribute('aria-pressed', String(paused));
    toggle.setAttribute('aria-label', paused ? 'Otomatik geçişi başlat' : 'Otomatik geçişi durdur');
    toggle.firstElementChild.className = paused ? 'fa-solid fa-play' : 'fa-solid fa-pause';
    root.dataset.showcasePlaying = String(!paused);
    schedule();
  }
  function activate(index) {
    const oldSlide = slides[current];
    const keepFocus = oldSlide.contains(document.activeElement);
    oldSlide.inert = true;
    oldSlide.classList.remove('is-active');
    oldSlide.setAttribute('aria-hidden', 'true');
    current = index;
    slides[index].inert = false;
    slides[index].classList.add('is-active');
    slides[index].setAttribute('aria-hidden', 'false');
    root.dataset.showcaseIndex = String(index);
    toolbar.hidden = slides.length - failed.size < 2;
    if (keepFocus) viewport.focus({ preventScroll: true });
  }
  async function show(candidate, direction = 1) {
    clearTimeout(timer);
    const token = ++sequence, length = slides.length;
    for (let attempt = 0; attempt < length; attempt++) {
      const index = ((candidate + attempt * direction) % length + length) % length;
      if (failed.has(index)) continue;
      try { await decodeImage(index); } catch {
        if (token !== sequence) return;
        failed.add(index);
        continue;
      }
      if (token !== sequence || controller.signal.aborted) return;
      activate(index);
      if (!document.hidden && visible && length > 1) loadImage((index + 1) % length);
      schedule();
      return;
    }
    if (token === sequence) root.hidden = true;
  }
  function step(direction) {
    setPaused(true);
    void show(current + direction, direction);
  }
  toggle.addEventListener('click', () => {
    // Pressing play is an explicit request even when the control retains keyboard focus.
    focusPaused = false;
    setPaused(!paused);
  }, options);
  root.querySelector('[data-showcase-previous]').addEventListener('click', () => step(-1), options);
  root.querySelector('[data-showcase-next]').addEventListener('click', () => step(1), options);
  viewport.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      step(event.key === 'ArrowLeft' ? -1 : 1);
    }
  }, options);
  viewport.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    swiped = false;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    clearTimeout(timer);
  }, options);
  window.addEventListener('pointerup', event => {
    if (pointer?.id !== event.pointerId) return;
    const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y;
    pointer = null;
    swiped = Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.25;
    if (swiped) step(dx < 0 ? 1 : -1);
    else schedule();
  }, options);
  window.addEventListener('pointercancel', () => { pointer = null; schedule(); }, options);
  motion.addEventListener('change', () => setPaused(motion.matches), options);
  root.addEventListener('focusin', () => { focusPaused = true; clearTimeout(timer); }, options);
  root.addEventListener('focusout', () => queueMicrotask(() => {
    if (!root.contains(document.activeElement)) { focusPaused = false; schedule(); }
  }), options);
  document.addEventListener('visibilitychange', schedule, options);
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    schedule();
  }) : null;
  observer?.observe(root);
  setPaused(paused);
  void show(0);
  const api = {
    destroy() {
      sequence++;
      clearTimeout(timer);
      controller.abort();
      observer?.disconnect();
      instances.delete(root);
    },
  };
  instances.set(root, api);
  return api;
}
