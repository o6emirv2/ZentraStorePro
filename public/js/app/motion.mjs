const states = new WeakMap();
const active = new WeakMap();

export async function presentScreen(
  element,
  markup,
  { isCurrent = () => true, animate = true } = {},
) {
  const doc = element.ownerDocument;
  const view = doc.defaultView;
  const state = states.get(element) || { version: 0 };
  states.set(element, state);
  const version = ++state.version;
  const current = () =>
    state.version === version && isCurrent() && element.isConnected !== false;
  const reduced =
    view?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  let committed = false;
  const update = () => {
    if (!current()) return;
    element.classList?.remove("view-enter");
    element.innerHTML = markup;
    committed = true;
  };
  active.get(doc)?.skipTransition?.();
  if (
    animate &&
    !reduced &&
    doc.visibilityState !== "hidden" &&
    typeof doc.startViewTransition === "function"
  ) {
    try {
      const transition = doc.startViewTransition(update);
      active.set(doc, transition);
      Promise.resolve(transition.finished)
        .catch(() => {})
        .finally(() => {
          if (active.get(doc) === transition) active.delete(doc);
        });
      await transition.updateCallbackDone;
    } catch {
      if (!committed) update();
    }
  } else {
    update();
    if (committed && animate && !reduced)
      view?.requestAnimationFrame?.(() => {
        if (current()) element.classList?.add("view-enter");
      });
  }
  return committed;
}
