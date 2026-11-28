"use strict";
const crypto = require("node:crypto");
const C = require("../commerce/common");
const env = require("../config/env");
const { initFirebaseAdmin } = require("../config/firebaseAdmin");
const { recordMutationAudit } = require("./storeMutationAudit");
const {
  accountStates,
  blocksAccess,
} = require("../../public/js/store/account-states.mjs");

function field(value, max) {
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[<>\x00-\x08\x0b-\x1f\x7f]/.test(value)
  )
    C.fail("MEMBER_TEXT_INVALID", 400);
  return value.trim();
}
async function protectTarget(uid, actor) {
  C.uid(uid);
  if (uid === actor.uid || env.adminUids.includes(uid))
    C.fail("ADMIN_OWNER_IMMUTABLE", 403);
  const target = await initFirebaseAdmin().auth.getUser(uid);
  if (env.adminEmails.includes(String(target.email || "").toLowerCase()))
    C.fail("ADMIN_OWNER_IMMUTABLE", 403);
  const staff = await C.db().collection("adminUsers").doc(uid).get();
  if (
    staff.exists &&
    staff.data().active !== false &&
    !env.adminUids.includes(actor.uid)
  )
    C.fail("ADMIN_OWNER_REQUIRED", 403);
}
function audit(tx, db, action, actor, uid, details = {}) {
  recordMutationAudit(tx, db, action, actor, { targetUid: uid, ...details });
}
async function noteView(db, uid) {
  const doc = await db.collection("storeInternalUserNotes").doc(uid).get();
  return doc.data() || null;
}
async function save({
  uid,
  status,
  adminNote = "",
  actor = {},
  expectedRevision,
  securityCode = "",
}) {
  const { db, auth } = initFirebaseAdmin();
  await protectTarget(uid, actor);
  if (!Object.hasOwn(accountStates, status))
    C.fail("STORE_ACCOUNT_STATUS_INVALID", 400);
  const note = field(adminNote, 1000),
    account = await auth.getUser(uid);
  const ref = db.collection("users").doc(uid),
    noteRef = db.collection("storeInternalUserNotes").doc(uid);
  const pendingRef = db.collection("storeMemberModerationIntents").doc(uid);
  const before = (await ref.get()).data() || {};
  const unlocking =
    before.storeAccountStatus === "security_locked" &&
    status !== "security_locked";
  if (unlocking) {
    const proof = await require("./adminTotpService").verifyAdminTotp({
      uid: actor.uid,
      code: securityCode,
    });
    if (!proof.verified || proof.replayed) C.fail("ADMIN_TOTP_REQUIRED", 403);
  }
  const plan = await db.runTransaction(async (tx) => {
    const [snapshot, oldNote] = await Promise.all([
      tx.get(ref),
      tx.get(noteRef),
    ]);
    const row = snapshot.data() || {},
      prior = row.storeAccountStatus || "active";
    if (row.storeDeletionId) C.fail("MEMBER_DELETION_IN_PROGRESS", 409);
    if (row.storeModerationIntent) {
      const intent = (await tx.get(pendingRef)).data();
      if (!intent) C.fail("MEMBER_CHANGE_IN_PROGRESS", 409);
      if (
        intent.status !== status ||
        intent.actor !== actor.uid ||
        intent.note !== note
      )
        C.fail("MEMBER_CHANGE_IN_PROGRESS", 409);
      return intent;
    }
    if (expectedRevision !== undefined)
      C.requireRevision(row.storeModerationRevision || 0, expectedRevision);
    if (prior === "security_locked" && status !== prior && !unlocking)
      C.fail("ADMIN_TOTP_REQUIRED", 403);
    const was = oldNote.data()?.text ?? row.storeAdminNote ?? "";
    if (prior === status && was === note && !row.storeAdminNote) return null;
    const intent = {
      id: crypto.randomUUID(),
      actor: actor.uid,
      status,
      prior,
      note,
      previousNote: was,
      managed:
        row.storeSuspendedAuthDisabled === true ||
        (blocksAccess(status) && !account.disabled),
      sync: blocksAccess(prior) || blocksAccess(status),
      createdAt: Date.now(),
    };
    tx.set(pendingRef, intent);
    tx.set(
      ref,
      {
        storeModerationIntent: { id: intent.id, status: intent.status },
        ...(blocksAccess(status) ? { storeAccountStatus: status } : {}),
      },
      { merge: true },
    );
    return intent;
  });
  if (plan) {
    if (plan.sync) {
      if (blocksAccess(status) || plan.managed)
        await auth.updateUser(uid, { disabled: blocksAccess(status) });
      await auth.revokeRefreshTokens(uid);
      await require("./adminSessionRegistry").revokeAdminSessionsForUser(uid);
      const current = await auth.getUser(uid);
      if (
        (blocksAccess(status) || plan.managed) &&
        current.disabled !== blocksAccess(status)
      )
        C.fail("MEMBER_AUTH_SYNC_PENDING", 503);
    }
    await db.runTransaction(async (tx) => {
      const [snapshot, oldNote] = await Promise.all([
          tx.get(ref),
          tx.get(noteRef),
        ]),
        row = snapshot.data() || {};
      if (row.lastModerationId === plan.id) return;
      if (row.storeModerationIntent?.id !== plan.id || row.storeDeletionId)
        C.fail("MEMBER_CHANGE_IN_PROGRESS", 409);
      const now = Date.now(),
        revision = (row.storeModerationRevision || 0) + 1;
      if (plan.previousNote !== note || row.storeAdminNote) {
        const prior = oldNote.data() || {};
        tx.set(noteRef, {
          uid,
          text: note,
          createdAt: prior.createdAt || now,
          createdBy: prior.createdBy || actor.uid,
          updatedAt: now,
          updatedBy: actor.uid,
        });
        tx.create(noteRef.collection("history").doc(plan.id), {
          before: plan.previousNote,
          after: note,
          actorUid: actor.uid,
          createdAt: now,
        });
      }
      tx.set(
        ref,
        {
          storeAccountStatus: status,
          storeSuspendedAuthDisabled: blocksAccess(status) && plan.managed,
          storeAdminNote: "",
          storeModerationIntent: null,
          lastModerationId: plan.id,
          storeModerationRevision: revision,
          storeModeratedAt: now,
          storeUpdatedAt: now,
          ...(plan.prior !== status
            ? { storeLastStatusChangeId: plan.id }
            : {}),
        },
        { merge: true },
      );
      tx.delete(pendingRef);
      if (plan.prior !== status)
        tx.set(db.collection("storeMemberStatusHistory").doc(plan.id), {
          uid,
          before: plan.prior,
          after: status,
          createdAt: now,
          actorUid: actor.uid,
          revision,
        });
      audit(tx, db, "store.user.update", actor, uid, {
        before: plan.prior,
        after: status,
        internalNoteChanged: plan.previousNote !== note,
        reference: plan.id,
      });
    });
  }
  const admin = require("./adminStoreService");
  admin.invalidateAdminStoreCaches();
  return admin.resolveStoreUser(uid);
}
function deniedAccess(row) {
  return (
    !!row?.storeDeletionId ||
    blocksAccess(row?.storeAccountStatus) ||
    blocksAccess(row?.storeModerationIntent?.status)
  );
}
function permitsRequest(row, req) {
  if (deniedAccess(row)) return false;
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return true;
  const path = String(req.originalUrl || req.path || "").split("?")[0];
  if (path.startsWith("/api/admin/"))
    return !row?.storeAccountStatus || row.storeAccountStatus === "active";
  const status = row?.storeAccountStatus || "active";
  if (status === "active") return true;
  if (
    /^\/api\/(?:auth\/|store\/(?:commerce\/(?:tickets(?:\/|$)|sessions(?:\/|$)|data-requests$)|notifications(?:\/|$)|account\/(?:password|email)))/.test(
      path,
    )
  )
    return true;
  if (status === "restricted") return false;
  if (
    /\/(?:orders|purchase|checkout|quote|reservations|wallet-requests|payments)(?:\/|$)/.test(
      path,
    )
  )
    return false;
  if (
    ["under_review", "verification_pending"].includes(status) &&
    /(?:redeem|promotion|balance-code|gift|wallet)/.test(path)
  )
    return false;
  return true;
}
module.exports = {
  field,
  protectTarget,
  audit,
  noteView,
  save,
  deniedAccess,
  permitsRequest,
};
