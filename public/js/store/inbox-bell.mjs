// Only the foreground window polls. A completed inbox mutation always requests a new server count.
export function installInboxBell(button, { readUid, api, view = window, doc = document }) {
  const badge = button.querySelector('.header-bell__count');
  let owner = '', sequence = 0, count = null, timer, pending, lastRead = 0, paused = false;
  const interval = 60000;
  let channel;
  try { channel = new BroadcastChannel('zentra-inbox'); } catch {}
  function paint(value) {
    const next = Number.isSafeInteger(value) && value >= 0 ? value : null;
    const label = next === null ? 'Bildirimlerim · Sayı doğrulanıyor' :
      next === 0 ? 'Bildirimlerim · Okunmamış bildirim yok' : 'Bildirimlerim · ' + next + ' okunmamış bildirim';
    badge.hidden = !next;
    badge.textContent = next ? String(next) : '';
    badge.classList.toggle('is-wide', badge.textContent.length > 3);
    button.setAttribute('aria-label', label);
    button.classList.toggle('has-unread', next > 0);
    if (next > 0 && (count === null || next > count)) {
      const icon = button.querySelector('i');
      if (!view.matchMedia('(prefers-reduced-motion: reduce)').matches)
        icon.animate?.([{transform:'rotate(0)'},{transform:'rotate(-16deg)'},{transform:'rotate(13deg)'},{transform:'rotate(-7deg)'},{transform:'rotate(0)'}],{duration:520});
    } else if (!next) button.querySelector('i').getAnimations?.().forEach(a => a.cancel());
    count = next;
  }
  function stop() { clearTimeout(timer); sequence++; pending?.abort(); pending = null; }
  function schedule(delay = interval) {
    clearTimeout(timer);
    if (owner && !doc.hidden && !paused) timer = view.setTimeout(refresh, delay);
  }
  async function refresh(force = false) {
    if (!owner || doc.hidden || paused || owner !== readUid()) return;
    if (pending && !force) return;
    stop();
    const turn = sequence, controller = new AbortController();
    pending = controller;
    try {
      const result = await api('/api/store/notifications/summary', { signal:controller.signal });
      if (turn !== sequence || owner !== readUid()) return;
      if (!Number.isSafeInteger(result.unread) || result.unread < 0) throw Error('INVALID_COUNT');
      paint(result.unread); lastRead = Date.now();
    } catch {
      if (turn === sequence) button.setAttribute('aria-label','Bildirimlerim · Güncel sayı alınamadı');
    } finally {
      if (turn === sequence) { pending = null; schedule(); }
    }
  }
  function resume() {
    if (doc.hidden || paused) { stop(); return; }
    const wait = interval - (Date.now() - lastRead);
    if (wait > 0) schedule(wait); else void refresh();
  }
  view.addEventListener('zentra:inbox-change', () => {
    lastRead = 0; channel?.postMessage({uid:owner}); void refresh(true);
  });
  channel?.addEventListener('message', e => {
    if (owner && e.data?.uid === owner) { lastRead = 0; void refresh(true); }
  });
  view.addEventListener('focus', resume);
  doc.addEventListener('visibilitychange', resume);
  view.addEventListener('pagehide', () => { paused = true; stop(); });
  view.addEventListener('pageshow', () => { paused = false; resume(); });
  return next => {
    if (next === owner) return;
    stop(); owner = next; lastRead = 0; paint(null); void refresh();
  };
}
