const installed = new WeakMap();
const editable =
  "input, textarea, [contenteditable]:not([contenteditable='false']), [role='textbox']";
const interactive =
  "a, button, label, select, summary, input, textarea, [role='button'], [contenteditable]";

function element(target) {
  return typeof target?.closest === "function" ? target : target?.parentElement;
}

export function installDevicePolicy(doc, view) {
  if (!doc?.addEventListener || !view) return () => {};
  if (installed.has(doc)) return installed.get(doc);
  let touched = false,
    lastTap = null,
    multiTouch = false;
  const listeners = [];
  const touchInput = () =>
    touched || view.matchMedia?.("(pointer: coarse)")?.matches === true;
  const editing = (event) => Boolean(element(event.target)?.closest(editable));
  const prevent = (event) => {
    if (event.cancelable) event.preventDefault();
  };
  const on = (name, handler, options) => {
    doc.addEventListener(name, handler, options);
    listeners.push([name, handler, options]);
  };
  const markTouch = () => {
    touched = true;
    if (doc.documentElement) doc.documentElement.dataset.touchInput = "true";
  };
  on(
    "pointerdown",
    (event) => {
      if (event.pointerType === "touch") markTouch();
      else if (event.pointerType === "mouse") {
        touched = false;
        if (doc.documentElement) delete doc.documentElement.dataset.touchInput;
      }
    },
    { passive: true },
  );
  on(
    "touchstart",
    (event) => {
      markTouch();
      if (event.touches?.length > 1) {
        multiTouch = true;
        lastTap = null;
        prevent(event);
      }
    },
    { passive: false, capture: true },
  );
  on(
    "touchmove",
    (event) => {
      if (event.touches?.length > 1) {
        multiTouch = true;
        prevent(event);
      }
    },
    { passive: false, capture: true },
  );
  on(
    "touchend",
    (event) => {
      if (multiTouch) {
        if (!event.touches?.length) multiTouch = false;
        lastTap = null;
        return;
      }
      const point = event.changedTouches?.[0];
      const target = element(event.target);
      if (!point || !target || target.closest(interactive)) {
        lastTap = null;
        return;
      }
      const time = Number(event.timeStamp) || Date.now();
      if (
        lastTap &&
        time - lastTap.time > 0 &&
        time - lastTap.time < 300 &&
        lastTap.target === target &&
        Math.abs(point.clientX - lastTap.x) < 24 &&
        Math.abs(point.clientY - lastTap.y) < 24
      )
        prevent(event);
      lastTap = { time, target, x: point.clientX, y: point.clientY };
    },
    { passive: false },
  );
  for (const name of ["gesturestart", "gesturechange", "gestureend"])
    on(
      name,
      (event) => {
        if (touchInput()) prevent(event);
      },
      { passive: false, capture: true },
    );
  for (const name of ["contextmenu", "selectstart", "dblclick", "dragstart"])
    on(
      name,
      (event) => {
        if (touchInput() && !editing(event)) prevent(event);
      },
      { passive: false },
    );
  const remove = () => {
    for (const [name, handler, options] of listeners)
      doc.removeEventListener(name, handler, options);
    if (doc.documentElement) delete doc.documentElement.dataset.touchInput;
    installed.delete(doc);
  };
  installed.set(doc, remove);
  return remove;
}
