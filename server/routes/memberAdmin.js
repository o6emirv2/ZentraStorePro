"use strict";
const C = require("../commerce/common");
const { initFirebaseAdmin } = require("../config/firebaseAdmin");
const { requireStorePermission, strictLimiter } = require("../core/security");
const notices = require("../email/memberNotices");
const removal = require("../core/memberRemoval");
const { facts, channel } = require("../core/memberFinance");
const base = "/admin/store/members";
function cursorValue(value) {
  if (!value) return null;
  try {
    const [at, id] = JSON.parse(Buffer.from(value, "base64url").toString());
    if (Number.isSafeInteger(at) && /^[\w.-]{1,180}$/.test(id)) return [at, id];
  } catch {}
  C.fail("STORE_PAGE_CURSOR_INVALID", 400);
}
async function activity(uid, cursor) {
  const { db, admin } = initFirebaseAdmin(),
    after = cursorValue(cursor);
  const sources = [
    ["audit", "details.targetUid", "at"],
    ["audit", "details.uid", "at"],
    ["adminAudit", "details.targetUid", "createdAt"],
    ["storeAudit", "uid", "createdAt"],
    ["storeWalletLedger", "uid", "createdAt"],
    ["storeEmailOutbox", "uid", "createdAt"],
    ["storeDeliveryAccessAudit", "uid", "createdAt"],
  ];
  const pages = await Promise.all(
    sources.map(async ([name, field, stamp]) => {
      let q = db
        .collection(name)
        .where(field, "==", uid)
        .orderBy(stamp, "desc")
        .orderBy(admin.firestore.FieldPath.documentId(), "desc");
      if (after) q = q.startAfter(...after);
      const snap = await q.limit(31).get();
      return snap.docs.map((d) => {
        const r = d.data();
        return {
          name,
          id: d.id,
          at: r[stamp],
          action: r.action || r.type || name,
          actor: r.actor?.uid || r.adminUid || "",
          state: r.state || r.status || "",
          reference:
            r.details?.reference ||
            r.transactionId ||
            r.requestId ||
            r.orderId ||
            d.id,
        };
      });
    }),
  );
  const all = [
    ...new Map(pages.flat().map((r) => [r.name + "/" + r.id, r])).values(),
  ].sort(
    (a, b) =>
      b.at - a.at || Buffer.compare(Buffer.from(b.id), Buffer.from(a.id)),
  );
  const rows = all.slice(0, 30),
    tail = rows.at(-1);
  if (tail)
    rows.push(
      ...all.slice(30).filter((r) => r.at === tail.at && r.id === tail.id),
    );
  return {
    items: rows,
    nextCursor:
      all.length > rows.length
        ? Buffer.from(JSON.stringify([tail.at, tail.id])).toString("base64url")
        : "",
  };
}
module.exports = function register(
  router,
  { adminChain, sensitiveAdminChain, noStore },
) {
  const read = (permission) => [
    ...adminChain,
    requireStorePermission(permission),
  ];
  const send = (fn) => async (req, res) => {
    noStore(res);
    res.json({ ok: true, result: await fn(req) });
  };
  const tools = require("../core/operationsTools");
  router.get(
    "/admin/store/tools",
    ...adminChain,
    send((req) => tools.list(req.adminPolicy)),
  );
  for (const [id, [, , permission]] of Object.entries(tools.catalog)) {
    router.post(
      "/admin/store/tools/" + id + "/run",
      ...sensitiveAdminChain(permission),
      send((req) => tools.run(id, req.user)),
    );
  }
  const uid = (req) => C.uid(req.params.uid);
  router.get(
    base + "/templates",
    ...read("store.users.write"),
    send(() => notices.list()),
  );
  router.post(
    base + "/:uid/notice/preview",
    ...read("store.users.write"),
    strictLimiter,
    send((req) => notices.preview(uid(req), req.body, req.user)),
  );
  router.post(
    base + "/:uid/notice/send",
    ...sensitiveAdminChain("store.users.write"),
    send((req) => notices.send(uid(req), C.id(req.body?.id), req.user)),
  );
  router.get(
    base + "/:uid/notices",
    ...read("store.users.write"),
    send(async (req) => {
      const page = await require("../core/firestorePagination").createdAtPage({
        db: C.db(),
        collection: "storeEmailOutbox",
        filters: [
          ["uid", uid(req)],
          ["type", "member_notice"],
        ],
        limit: 25,
        cursor: req.query.cursor,
      });
      return {
        items: page.docs.map((d) => {
          const v = d.data();
          return {
            id: d.id,
            reference: v.data.reference,
            template: v.data.template,
            state: v.state,
            at: v.updatedAt,
            error: v.failureCode,
            providerId: v.providerId,
          };
        }),
        nextCursor: page.nextCursor,
      };
    }),
  );
  router.get(
    base + "/:uid/orders",
    ...read("store.orders.read"),
    send(async (req) => {
      const { db, admin } = initFirebaseAdmin(),
        user = uid(req),
        after = cursorValue(req.query.cursor);
      const sources = [
        ["storeOrders", "uid", "createdAt"],
        ["storeOrderArchives", "order.uid", "order.createdAt"],
      ];
      const pages = await Promise.all(
        sources.map(async ([name, field, stamp]) => {
          let q = db
            .collection(name)
            .where(field, "==", user)
            .orderBy(stamp, "desc")
            .orderBy(admin.firestore.FieldPath.documentId(), "desc");
          if (after) q = q.startAfter(...after);
          const snap = await q.limit(26).get();
          return snap.docs.map((d) => {
            const archived = name === "storeOrderArchives",
              o = archived ? d.data().order : d.data(),
              f = facts(o);
            return {
              id: d.id,
              archived,
              number: o.orderNumber || d.id,
              method: channel(o),
              status: o.status || "",
              payment: o.paymentState || "",
              delivery: o.delivery?.status || "",
              refund: f.refunded ? "refunded" : o.refundStatus || "",
              amount: f.amount,
              createdAt: o.createdAt,
              deliveredAt: f.deliveredAt,
              paidAt:
                o.paidAt ||
                o.walletPaidAt ||
                o.manualPayment?.verifiedAt ||
                null,
            };
          });
        }),
      );
      const combined = [
        ...new Map([...pages[1], ...pages[0]].map((r) => [r.id, r])).values(),
      ].sort(
        (a, b) =>
          b.createdAt - a.createdAt ||
          Buffer.compare(Buffer.from(b.id), Buffer.from(a.id)),
      );
      const items = combined.slice(0, 25),
        last = items.at(-1);
      return {
        items,
        nextCursor:
          combined.length > 25
            ? Buffer.from(JSON.stringify([last.createdAt, last.id])).toString(
                "base64url",
              )
            : "",
      };
    }),
  );
  router.get(
    base + "/:uid/activity",
    ...read("store.audit.read"),
    send((req) => activity(uid(req), req.query.cursor)),
  );
  router.post(
    base + "/:uid/removal/preview",
    ...read("store.users.delete"),
    strictLimiter,
    send((req) =>
      removal.preview(
        uid(req),
        req.body.mode,
        req.user,
        req.adminAccess.gateSession,
      ),
    ),
  );
  router.post(
    base + "/:uid/removal/confirm",
    ...sensitiveAdminChain("store.users.delete"),
    send((req) =>
      removal.start(uid(req), req.body, req.user, req.adminAccess.gateSession),
    ),
  );
  router.post(
    base + "/:uid/removal/resume",
    ...sensitiveAdminChain("store.users.delete"),
    send((req) => removal.resume(uid(req), req.user)),
  );
  router.get(
    base + "/:uid/removal",
    ...read("store.users.delete"),
    send(async (req) =>
      removal.publicJob(
        (
          await C.db().collection("storeAccountRemovalJobs").doc(uid(req)).get()
        ).data(),
      ),
    ),
  );
  router.get(
    base + "/blocks/list",
    ...read("store.registration.unblock"),
    send(async (req) => {
      const page = await require("../core/firestorePagination").createdAtPage({
        db: C.db(),
        collection: "storeRegistrationBlocks",
        limit: 30,
        cursor: req.query.cursor,
      });
      return {
        items: page.docs.map((d) => ({ id: d.id, ...d.data() })),
        nextCursor: page.nextCursor,
      };
    }),
  );
  router.get(
    base + "/removals/list",
    ...read("store.users.delete"),
    send(async (req) => {
      const page = await require("../core/firestorePagination").createdAtPage({
        db: C.db(),
        collection: "storeAccountRemovalJobs",
        limit: 25,
        cursor: req.query.cursor,
      });
      return {
        items: page.docs.map((d) => ({
          uid: d.id,
          ...removal.publicJob(d.data()),
        })),
        nextCursor: page.nextCursor,
      };
    }),
  );
  router.post(
    base + "/blocks/:id/release",
    ...sensitiveAdminChain("store.registration.unblock"),
    send((req) => removal.unblock(req.params.id, req.body.totp, req.user)),
  );
};
