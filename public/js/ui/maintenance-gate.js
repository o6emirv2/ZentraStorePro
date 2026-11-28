const DEFAULT_MESSAGE = 'Daha iyi bir alışveriş deneyimi için mağazamızda bakım yapıyoruz. Lütfen kısa bir süre sonra yeniden deneyin.';

export function installMaintenanceGate({ api, doc = document, view = window, interval = 5000 } = {}) {
  const gate = doc.getElementById('maintenanceGate');
  if (!gate) throw new Error('MAINTENANCE_GATE_MISSING');
  const button = gate.querySelector('[data-maintenance-refresh]');
  const title = gate.querySelector('[data-maintenance-title]');
  const copy = gate.querySelector('[data-maintenance-message]');
  const prior = new Map();
  let active = false, disposed = false, pending = null, timer, previousFocus;

  function lock() {
    for (const node of doc.body.children) {
      if (node === gate || node.tagName === 'SCRIPT' || node.tagName === 'LINK') continue;
      if (!prior.has(node)) prior.set(node, node.inert);
      node.inert = true;
    }
    doc.documentElement.classList.add('maintenance-locked');
    if (!gate.open) gate.showModal();
  }
  function unlock() {
    if (gate.open) gate.close();
    for (const [node, value] of prior) if (node.isConnected) node.inert = value;
    prior.clear();
    doc.documentElement.classList.remove('maintenance-locked');
    if (previousFocus?.isConnected && !previousFocus.closest('[inert]')) previousFocus.focus({ preventScroll: true });
    previousFocus = null;
  }
  function display(value) {
    const wasActive = active;
    active = value.maintenance === true;
    if (active) {
      title.textContent = 'Kısa bir bakım arasındayız';
      copy.textContent = value.message || DEFAULT_MESSAGE;
      gate.dataset.state = 'maintenance';
      if (!wasActive) previousFocus = doc.activeElement;
      lock();
    } else if (wasActive) unlock();
    if (active !== wasActive) view.dispatchEvent(new CustomEvent('zentra:maintenance-change', { detail: { active } }));
  }
  async function refresh() {
    if (disposed) return;
    if (pending) return pending;
    pending = (async () => {
      try {
        const result = await api('/api/store/status', { auth: false, timeoutMs: 9000, cache: 'no-store' });
        if (disposed) return;
        if (typeof result.maintenance !== 'boolean') throw new Error('STATUS_INVALID');
        display(result);
      } catch (_) {
        // Only a confirmed status changes the visibility of the gate.
      } finally {
        pending = null;
        if (!disposed && !doc.hidden) { clearTimeout(timer); timer = view.setTimeout(refresh, interval); }
      }
    })();
    return pending;
  }
  function cancel(event) { event.preventDefault(); }
  function constrain(event) {
    if (!active) return;
    if (event.type === 'keydown' && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); }
    if (event.type === 'click' && !gate.contains(event.target)) { event.preventDefault(); event.stopImmediatePropagation(); }
  }
  function visible() { clearTimeout(timer); if (!doc.hidden) void refresh(); }
  function reload() { view.location.reload(); }
  gate.addEventListener('cancel', cancel);
  button.addEventListener('click', reload);
  doc.addEventListener('click', constrain, true);
  doc.addEventListener('keydown', constrain, true);
  doc.addEventListener('visibilitychange', visible);
  view.addEventListener('pageshow', refresh);
  view.addEventListener('online', refresh);
  const observer = new MutationObserver(() => { if (active) lock(); });
  observer.observe(doc.body, { childList: true });
  const ready = refresh();
  const controller = {
    ready, refresh,
    get active() { return active; },
    destroy() {
      disposed = true; clearTimeout(timer); observer.disconnect(); unlock();
      gate.removeEventListener('cancel', cancel); button.removeEventListener('click', reload);
      doc.removeEventListener('click', constrain, true); doc.removeEventListener('keydown', constrain, true);
      doc.removeEventListener('visibilitychange', visible); view.removeEventListener('pageshow', refresh); view.removeEventListener('online', refresh);
    },
  };
  view.ZENTRA_MAINTENANCE = controller;
  return controller;
}
