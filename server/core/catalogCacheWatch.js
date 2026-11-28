"use strict";
// Public catalog data is shared by requests on one instance. Watch the existing source
// documents so another instance's committed writes also invalidate that local copy.
const watches = new Map();
const maxSubscriptions = 128,
  idleMs = 60000;
function release(key, watch) {
  if (watches.get(key) !== watch) return;
  watches.delete(key);
  clearTimeout(watch.timer);
  watch.unsubscribe?.();
  watch.invalidate();
}
function observe(key, ref, invalidate) {
  if (typeof ref?.onSnapshot !== "function") return true;
  let watch = watches.get(key);
  if (watch && watch.db !== ref.firestore) {
    release(key, watch);
    watch = null;
  }
  if (!watch) {
    if (watches.size >= maxSubscriptions) {
      const [old, entry] = watches.entries().next().value;
      release(old, entry);
    }
    watch = { db: ref.firestore, invalidate, ready: false, timer: null, unsubscribe: null };
    watches.set(key, watch);
    try {
      watch.unsubscribe = ref.onSnapshot(
        () => {
          if (watches.get(key) !== watch) return;
          invalidate();
          watch.ready = true;
        },
        () => release(key, watch),
      );
    } catch {
      release(key, watch);
      return false;
    }
  }
  clearTimeout(watch.timer);
  watch.timer = setTimeout(() => release(key, watch), idleMs);
  watch.timer.unref?.();
  return watch.ready;
}
function observeIds(prefix, collection, documentId, ids, invalidate) {
  let ready = true;
  for (let start = 0; start < ids.length; start += 30) {
    const group = ids.slice(start, start + 30);
    const query = collection.where(documentId, "in", group);
    if (!observe(prefix + JSON.stringify(group), query, invalidate)) ready = false;
  }
  return ready;
}
function stop() {
  for (const [key, watch] of watches) release(key, watch);
}
module.exports = { observe, observeIds, stop };
