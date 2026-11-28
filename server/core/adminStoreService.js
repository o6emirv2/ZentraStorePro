"use strict";
const { readStoredBalance, checkedBalance } = require("./storeMoney");

const crypto = require("crypto");
const { resolveIdentity } = require("./walletRecipientService");
const env = require("../config/env");
const { initFirebaseAdmin } = require("../config/firebaseAdmin");
const {
  inventorySummary,
  inventoryReadiness,
} = require("./storeInventoryService");
const { getEffectiveCatalog } = require("./storeCatalogService");
const { createdAtPage } = require("./firestorePagination");
const { recordMutationAudit } = require("./storeMutationAudit");
const { overviewCan, projectAdminOverview } = require("./adminOverviewPolicy");

const ACCOUNT_STATUSES = Object.freeze(Object.keys(require("../../public/js/store/account-states.mjs").accountStates));
const STAFF_ROLES = Object.freeze([
  "owner",
  "admin",
  "finance",
  "inventory",
  "orders",
  "support",
  "viewer",
]);
const ROLE_PERMISSIONS = Object.freeze({
  owner: Object.freeze(["*"]),
  admin: Object.freeze(["*"]),
  finance: Object.freeze([
    "store.overview.read",
    "store.orders.read",
    "store.users.read",
    "store.wallet.read",
    "store.wallet.write",
    "store.audit.read",
    "store.security.read",
    "store.analytics.read",
  ]),
  inventory: Object.freeze([
    "store.overview.read",
    "store.catalog.read",
    "store.catalog.write",
    "store.inventory.read",
    "store.inventory.write",
    "store.audit.read",
    "store.security.read",
    "store.analytics.read",
  ]),
  orders: Object.freeze([
    "store.overview.read",
    "store.catalog.read",
    "store.orders.read",
    "store.orders.write",
    "store.inventory.read",
    "store.users.read",
    "store.support.read",
    "store.support.write",
    "store.audit.read",
    "store.security.read",
    "store.analytics.read",
  ]),
  support: Object.freeze([
    "store.overview.read",
    "store.orders.read",
    "store.users.read",
    "store.wallet.read",
    "store.content.read",
    "store.support.read",
    "store.support.write",
    "store.audit.read",
    "store.security.read",
    "store.analytics.read",
  ]),
  viewer: Object.freeze([
    "store.overview.read",
    "store.catalog.read",
    "store.content.read",
  ]),
});

function staffRole(row = {}) {
  const role =
    STAFF_ROLES.includes(row.role) && row.role !== "owner"
      ? row.role
      : "viewer";
  // Legacy unknown roles must not silently become newly privileged accounts.
  if (
    role === "admin" &&
    (!Number.isSafeInteger(row.policyVersion) || row.policyVersion < 1)
  )
    return "viewer";
  return role;
}

const USER_SUMMARY_TTL_MS = 45_000;
const WALLET_SUMMARY_TTL_MS = 45_000;
const PROFILE_SUMMARY_TTL_MS = 45_000;
const PROFILE_SUMMARY_LIMIT = 1000;
const OVERVIEW_ORDER_LIMIT = 500;
const WALLET_SUMMARY_LEDGER_LIMIT = 500;
let userSummaryCache = null;
let walletSummaryCache = null;
let profileSummaryCache = null;
let profileSummaryLoad = null;

function serviceError(code, statusCode = 400, details = {}) {
  return Object.assign(new Error(code), { code, statusCode, ...details });
}

function safeText(value = "", max = 200) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f<>]/g, "")
    .trim()
    .slice(0, max);
}

function maskEmail(value = "") {
  const email = safeText(value, 254).toLowerCase();
  const separator = email.lastIndexOf("@");
  if (separator < 1) return "";
  const local = email.slice(0, separator);
  const domain = email.slice(separator + 1);
  return `${local.slice(0, Math.min(2, local.length))}${"•".repeat(Math.max(3, Math.min(7, local.length - 1)))}@${domain}`;
}

function firebaseStore() {
  const firebase = initFirebaseAdmin();
  if (!firebase.db || !firebase.auth)
    throw serviceError("STORE_STORAGE_UNAVAILABLE", 503);
  return firebase;
}

function balance(profile = {}) {
  return readStoredBalance(profile);
}

function parseDate(value = "") {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function maxTimestamp(...values) {
  return Math.max(
    0,
    ...values.map((value) => Math.max(0, Number(value || 0) || 0)),
  );
}

function turkeyDateKey(timestamp = Date.now()) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Istanbul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(timestamp));
    const map = Object.fromEntries(
      parts
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
    return `${map.year}-${map.month}-${map.day}`;
  } catch (_) {
    return new Date(timestamp).toISOString().slice(0, 10);
  }
}

function publicAdminUser(authUser = {}, profile = {}, commerce = {}) {
  const username = safeText(profile.username || authUser.displayName || "", 40);
  const status = ACCOUNT_STATUSES.includes(profile.storeAccountStatus)
    ? profile.storeAccountStatus
    : "active";
  const authCreatedAt = parseDate(authUser.metadata?.creationTime);
  const authLastSignInAt = parseDate(authUser.metadata?.lastSignInTime);
  return {
    uid: safeText(authUser.uid || profile.uid, 160),
    email: typeof authUser.email === "string" ? authUser.email : "",
    emailVerified: typeof authUser.emailVerified==="boolean" ? authUser.emailVerified : null,
    revision: profile.storeModerationRevision || 0,
    changePending: !!profile.storeModerationIntent,
    username,
    firstName: safeText(profile.firstName, 50),
    lastName: safeText(profile.lastName, 50),
    disabled: authUser.disabled === true,
    accountStatus: status,
    balanceKurus: (profile.storeBalanceKurus!=null || profile.storeWallet?.balanceKurus!=null) ? require("./storeMoney").readAvailableBalance(profile) : null,
    walletDebtKurus: checkedBalance(profile.storeWalletDebtKurus || 0),
    createdAt: authCreatedAt || Number(profile.createdAt || profile.storeCreatedAt) || null,
    lastActiveAt: maxTimestamp(
      profile.storeUpdatedAt,
      profile.updatedAt,
      authLastSignInAt,
      commerce.lastOrderAt,
    ),
    lastSignInAt: authLastSignInAt,
    orderCount: Math.max(
      0,
      Math.trunc(
        Number(commerce.totalOrders ?? profile.storeOrderCount ?? 0) || 0,
      ),
    ),
    totalSpendKurus: commerce.totalSpendKurus ?? null,
    refundedKurus: commerce.refundedKurus ?? null,
    lastDeliveryAt: commerce.lastDeliveryAt || null,
    lastOrderAt: commerce.lastOrderAt || null,
    
  };
}

async function profileForUid(db, uid) {
  const snapshot = await db.collection("users").doc(uid).get();
  return snapshot.exists ? snapshot.data() || {} : {};
}

const commerceAggregate = require("./memberFinance").aggregate;

async function commerceStatsForUids(db, uids = []) {
  const unique = [
    ...new Set(uids.map((uid) => safeText(uid, 160)).filter(Boolean)),
  ];
  const map = new Map(
    unique.map((uid) => [
      uid,
      { totalOrders: 0, totalSpendKurus: 0, refundedKurus: 0, lastOrderAt: 0 },
    ]),
  );
  for (let offset = 0; offset < unique.length; offset += 10) {
    const chunk = unique.slice(offset, offset + 10);
    if (!chunk.length) continue;
    const [live,archive]=await Promise.all([
      db.collection("storeOrders").where("uid","in",chunk).get(),
      db.collection("storeOrderArchives").where("order.uid","in",chunk).get(),
    ]);
    const documents=new Map(archive.docs.map(doc=>[doc.id,doc.data().order]));
    for(const doc of live.docs)documents.set(doc.id,doc.data());
    const groups=new Map(chunk.map(uid=>[uid,[]]));
    for(const row of documents.values())if(groups.has(row?.uid))groups.get(row.uid).push(row);
    for (const [uid, rows] of groups) map.set(uid, commerceAggregate(rows));
  }
  return map;
}

async function resolveStoreUser(value = "") {
  const { db } = firebaseStore();
  const authUser = await resolveIdentity(value, { allowDisabled: true });
  const [profile, commerce, internalNote] = await Promise.all([
    profileForUid(db, authUser.uid),
    commerceStatsForUids(db, [authUser.uid]),
    require("./memberControl").noteView(db,authUser.uid),
  ]);
  return {...publicAdminUser(authUser,profile,commerce.get(authUser.uid)),adminNote:internalNote?.text ?? profile.storeAdminNote ?? "", noteUpdatedAt:internalNote?.updatedAt || null, noteUpdatedBy:internalNote?.updatedBy || ""};
}

function matchesFilters(row,{status,verified,balance:funds,orders}={}) {
  return (!status || row.accountStatus===status) && (!verified || row.emailVerified===(verified==="yes")) &&
    (!funds || (row.balanceKurus!==null && (row.balanceKurus>0)===(funds==="yes"))) &&
    (!orders || (row.orderCount>0)===(orders==="yes"));
}
async function listStoreUsers({ query = "", limit = 50, pageToken = "", filters = {}, compact = false } = {}) {
  const safeQuery = typeof query === "string" ? query.trim() : "";
  if (safeQuery) {const user=await resolveStoreUser(safeQuery);return {users:[user].filter(row=>matchesFilters(row,filters)),nextPageToken:""};}
  const { db, auth } = firebaseStore();
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(Number(limit) || 50)));
  const result = await auth.listUsers(
    safeLimit,
    safeText(pageToken, 1024) || undefined,
  );
  const [profiles, commerce] = await Promise.all([
    result.users.length
      ? db
          .getAll(
            ...result.users.map((user) => db.collection("users").doc(user.uid)),
          )
          .then((docs) =>
            docs.map((doc) => (doc.exists ? doc.data() || {} : {})),
          )
      : [],
    compact && !filters.orders ? new Map() : commerceStatsForUids(
      db,
      result.users.map((user) => user.uid),
    ),
  ]);
  return {
    users: result.users.map((user, index) =>
      publicAdminUser(user, profiles[index], commerce.get(user.uid)),
    ).filter(row=>matchesFilters(row,filters)).map(row=>compact?{uid:row.uid,username:row.username,email:row.email,emailVerified:row.emailVerified,accountStatus:row.accountStatus}:row),
    nextPageToken: safeText(result.pageToken, 1024),
  };
}

const updateStoreUser = input => require("./memberControl").save(input);

async function listWalletLedger(uid = "", limit = 100, cursor = "") {
  const safeUid = safeText(uid, 160);
  if (!safeUid) throw serviceError("STORE_TARGET_UID_REQUIRED", 400);
  const { db } = firebaseStore();
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 100));
  const page = await createdAtPage({
    db,
    collection: "storeWalletLedger",
    filters: [["uid", safeUid]],
    limit: safeLimit,
    cursor,
  });
  const ledger = page.docs
    .map((doc) => {
      const row = doc.data() || {};
      return {
        id: doc.id,
        type: safeText(row.type, 30),
        amountKurus: Number.isSafeInteger(row.amountKurus) ? row.amountKurus : null,
        source: safeText(row.source || row.actor?.source,60),
        balanceBeforeKurus: Number.isSafeInteger(row.balanceBeforeKurus) ? row.balanceBeforeKurus : null,
        balanceAfterKurus: Number.isSafeInteger(row.balanceAfterKurus) ? row.balanceAfterKurus : null,
        reason: safeText(row.reason, 200),
        orderId: safeText(row.orderId, 160),
        transactionId: safeText(
          row.transactionId || row.requestId || doc.id,
          180,
        ),
        actor: {
          uid: safeText(row.actor?.uid, 160),
          email: safeText(row.actor?.email, 254).toLowerCase(),
          source: safeText(row.actor?.source, 40),
        },
        createdAt: Math.max(0, Number(row.createdAt || 0) || 0),
      };
    })
    .sort((left, right) => right.createdAt - left.createdAt);
  return { ledger, nextCursor: page.nextCursor, hasMore: page.hasMore };
}

async function collectFirebaseUsers(auth, maxPages = 1) {
  const users = [];
  let pageToken;
  let pages = 0;
  do {
    const result = await auth.listUsers(1000, pageToken);
    users.push(...result.users);
    pageToken = result.pageToken || undefined;
    pages += 1;
  } while (pageToken && pages < maxPages);
  return { users, complete: !pageToken };
}

async function getProfileSummarySnapshot(db, { fresh = false } = {}) {
  const now = Date.now();
  if (
    !fresh &&
    profileSummaryCache &&
    now - profileSummaryCache.at < PROFILE_SUMMARY_TTL_MS
  ) {
    return profileSummaryCache.snapshot;
  }
  if (!profileSummaryLoad) {
    const generation = adminCacheGeneration;
    const pending = db
      .collection("users")
      .select(
        "storeBalanceKurus",
        "storeWallet.balanceKurus",
        "storeAccountStatus",
      )
      .limit(PROFILE_SUMMARY_LIMIT + 1)
      .get()
      .then((result) => {
        const snapshot = {
          docs: result.docs.slice(0, PROFILE_SUMMARY_LIMIT),
          size: Math.min(result.size, PROFILE_SUMMARY_LIMIT),
          complete: result.size <= PROFILE_SUMMARY_LIMIT,
        };
        if (generation === adminCacheGeneration)
          profileSummaryCache = { at: Date.now(), snapshot };
        return snapshot;
      });
    const tracked = pending.finally(() => {
      if (profileSummaryLoad === tracked) profileSummaryLoad = null;
    });
    profileSummaryLoad = tracked;
  }
  return profileSummaryLoad;
}

async function computeUserDirectorySummary({ fresh = false } = {}) {
  const now = Date.now();
  if (
    !fresh &&
    userSummaryCache &&
    now - userSummaryCache.at < USER_SUMMARY_TTL_MS
  )
    return userSummaryCache.value;
  const generation = adminCacheGeneration;
  const { db, auth } = firebaseStore();
  const [{ users, complete }, profilesSnapshot] = await Promise.all([
    collectFirebaseUsers(auth),
    getProfileSummarySnapshot(db, { fresh }),
  ]);
  const profiles = new Map(
    profilesSnapshot.docs.map((doc) => [doc.id, doc.data() || {}]),
  );
  const summary = {
    authUsers: users.length,
    countComplete: complete,
    disabled: users.filter((user) => user.disabled === true).length,
    active: 0,
    purchaseBlocked: 0,
    suspended: 0,
    profileDocuments: profilesSnapshot.size,
    profileComplete: profilesSnapshot.complete,
    unclassified: 0,
    walletLiabilityKurus: 0,
    fundedAccounts: 0,
    generatedAt: now,
  };
  for (const user of users) {
    if (!profiles.has(user.uid) && !profilesSnapshot.complete) {
      summary.unclassified++;
      continue;
    }
    const profile = profiles.get(user.uid) || {};
    const status = ACCOUNT_STATUSES.includes(profile.storeAccountStatus)
      ? profile.storeAccountStatus
      : "active";
    if (user.disabled !== true && status === "active") summary.active += 1;
    else if (user.disabled !== true && status === "purchase_blocked")
      summary.purchaseBlocked += 1;
    else if (user.disabled !== true && status === "suspended")
      summary.suspended += 1;
    const amount = balance(profile);
    summary.walletLiabilityKurus += amount;
    if (amount > 0) summary.fundedAccounts += 1;
  }
  if (generation === adminCacheGeneration)
    userSummaryCache = { at: now, value: summary };
  return summary;
}

async function collectLedgerRows(db, maxPages = 1) {
  const rows = [];
  let cursor = null;
  let pages = 0;
  do {
    let query = db
      .collection("storeWalletLedger")
      .orderBy("createdAt", "desc")
      .limit(WALLET_SUMMARY_LEDGER_LIMIT);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    if (snapshot.empty) return { rows, complete: true };
    rows.push(
      ...snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) })),
    );
    cursor = snapshot.docs[snapshot.docs.length - 1];
    pages += 1;
    if (snapshot.size < WALLET_SUMMARY_LEDGER_LIMIT)
      return { rows, complete: true };
  } while (pages < maxPages);
  return { rows, complete: false };
}

async function computeWalletSummary({ fresh = false } = {}) {
  const generation = adminCacheGeneration;
  const now = Date.now();
  if (
    !fresh &&
    walletSummaryCache &&
    now - walletSummaryCache.at < WALLET_SUMMARY_TTL_MS
  )
    return walletSummaryCache.value;
  const { db } = firebaseStore();
  const [profilesSnapshot, ledgerResult, adjustmentsCount] = await Promise.all([
    getProfileSummarySnapshot(db, { fresh }),
    collectLedgerRows(db).catch(async () => {
      const snapshot = await db
        .collection("storeWalletLedger")
        .limit(WALLET_SUMMARY_LEDGER_LIMIT)
        .get();
      return {
        rows: snapshot.docs.map((doc) => ({
          id: doc.id,
          ...(doc.data() || {}),
        })),
        complete: snapshot.size < WALLET_SUMMARY_LEDGER_LIMIT,
      };
    }),
    db
      .collection("storeWalletAdjustments")
      .count()
      .get()
      .catch(() => null),
  ]);
  let liabilityKurus = 0;
  let fundedAccounts = 0;
  let highestBalanceKurus = 0;
  for (const doc of profilesSnapshot.docs) {
    const amount = balance(doc.data() || {});
    liabilityKurus += amount;
    if (amount > 0) fundedAccounts += 1;
    highestBalanceKurus = Math.max(highestBalanceKurus, amount);
  }
  const totals = { CREDIT: 0, DEBIT: 0, REFUND: 0, CORRECTION: 0 };
  const counts = { CREDIT: 0, DEBIT: 0, REFUND: 0, CORRECTION: 0 };
  let todayCreditKurus = 0;
  let todayRefundKurus = 0;
  const today = turkeyDateKey(now);
  const normalized = ledgerResult.rows
    .map((row) => {
      const type = safeText(row.type, 30).toUpperCase();
      const amountKurus = Math.trunc(Number(row.amountKurus) || 0);
      const createdAt = Math.max(0, Number(row.createdAt || 0) || 0);
      if (Object.prototype.hasOwnProperty.call(totals, type)) {
        totals[type] += amountKurus;
        counts[type] += 1;
        if (turkeyDateKey(createdAt) === today) {
          if (type === "CREDIT") todayCreditKurus += Math.max(0, amountKurus);
          if (type === "REFUND") todayRefundKurus += Math.max(0, amountKurus);
        }
      }
      return {
        id: safeText(row.id, 180),
        transactionId: safeText(
          row.transactionId || row.requestId || row.id,
          180,
        ),
        uid: safeText(row.uid, 160),
        username: safeText(row.username, 80),
        type,
        amountKurus,
        balanceBeforeKurus: Number.isSafeInteger(row.balanceBeforeKurus) ? row.balanceBeforeKurus : null,
        balanceAfterKurus: Number.isSafeInteger(row.balanceAfterKurus) ? row.balanceAfterKurus : null,
        reason: safeText(row.reason, 200),
        actorSource: safeText(row.actor?.source || "", 30),
        actor: {
          uid: safeText(row.actor?.uid, 160),
          email: safeText(row.actor?.email, 254).toLowerCase(),
        },
        createdAt,
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
  const value = {
    liabilityKurus,
    fundedAccounts,
    averageBalanceKurus: profilesSnapshot.size
      ? Math.round(liabilityKurus / profilesSnapshot.size)
      : 0,
    highestBalanceKurus,
    profileDocuments: profilesSnapshot.size,
    profileComplete: profilesSnapshot.complete,
    adjustmentCount: adjustmentsCount
      ? Math.max(0, Number(adjustmentsCount.data()?.count || 0))
      : null,
    totalCreditKurus: Math.max(0, totals.CREDIT),
    totalDebitKurus: Math.abs(Math.min(0, totals.DEBIT)),
    totalRefundKurus: Math.max(0, totals.REFUND),
    totalCorrectionKurus: totals.CORRECTION,
    todayCreditKurus,
    todayRefundKurus,
    counts,
    ledgerAnalyzed: ledgerResult.rows.length,
    ledgerComplete: ledgerResult.complete === true,
    recent: normalized.slice(0, 50),
    generatedAt: now,
  };
  if (generation === adminCacheGeneration)
    walletSummaryCache = { at: now, value };
  return value;
}

async function getAdminOverview(policy = null) {
  const { db, auth, enabled } = firebaseStore();
  const can = (permission) => overviewCan(policy, permission);
  const needsOrders = can("store.orders.read") || can("store.wallet.read");
  const [
    ordersSnapshot,
    ordersCount,
    stock,
    usersSummary,
    catalog,
    walletSummary,
  ] = await Promise.all([
    needsOrders
      ? db
          .collection("storeOrders")
          .orderBy("createdAt", "desc")
          .limit(OVERVIEW_ORDER_LIMIT)
          .get()
      : Promise.resolve({ docs: [] }),
    needsOrders
      ? db
          .collection("storeOrders")
          .count()
          .get()
          .catch(() => null)
      : Promise.resolve(null),
    can("store.inventory.read")
      ? inventorySummary({ fresh: false })
      : Promise.resolve([]),
    can("store.users.read")
      ? getUserDirectorySummary({ fresh: false })
      : Promise.resolve({}),
    getEffectiveCatalog({ includeInactive: true, fresh: false }),
    can("store.wallet.read")
      ? getWalletSummary({ fresh: false })
      : Promise.resolve({}),
  ]);
  const orders = ordersSnapshot.docs.map((doc) => doc.data() || {});
  const totalOrders = Math.max(
    orders.length,
    Number(ordersCount?.data()?.count || 0),
  );
  const today = turkeyDateKey();
  const purchases = orders;
  const confirmed = purchases.filter(
    (order) =>
      Number(order.approvedAt || 0) > 0 ||
      [
        "paid",
        "processing",
        "delivery_pending",
        "delivered",
        "refunded",
      ].includes(order.status),
  );
  const delivered = purchases.filter((order) => order.status === "delivered");
  const awaiting = orders.filter((order) =>
    ["awaiting_payment", "payment_review"].includes(order.status),
  ).length;
  const processing = orders.filter((order) =>
    ["paid", "processing", "delivery_pending"].includes(order.status),
  ).length;
  const refunded = purchases.filter(
    (order) =>
      order.status === "refunded" || Number(order.walletRefundedAt || 0) > 0,
  );
  const cancelled = orders.filter(
    (order) => order.status === "cancelled",
  ).length;
  const paymentRejected = orders.filter(
    (order) => order.status === "payment_rejected",
  ).length;
  const deliveryFailures = orders.filter(
    (order) => order.delivery?.status === "failed",
  ).length;
  const grossRevenueKurus = confirmed.reduce(
    (sum, order) => sum + Math.max(0, Number(order.totalKurus) || 0),
    0,
  );
  const deliveredRevenueKurus = delivered.reduce(
    (sum, order) => sum + Math.max(0, Number(order.totalKurus) || 0),
    0,
  );
  const refundedKurus = refunded.reduce(
    (sum, order) =>
      sum +
      Math.max(
        0,
        Number(
          order.walletRefundedKurus ||
            (order.status === "refunded" ? order.totalKurus : 0),
        ) || 0,
      ),
    0,
  );
  const telegramOrders = orders.filter(
    (order) =>
      order.salesChannel === "telegram" || order.paymentMethod === "telegram",
  ).length;
  const automaticOrders = purchases.filter(
    (order) =>
      !(
        order.salesChannel === "telegram" || order.paymentMethod === "telegram"
      ),
  ).length;
  const configuration = env.configurationReport();
  const inventory = inventoryReadiness();
  const activeProducts = catalog.products.filter(
    (product) => product.active !== false && product.archived !== true,
  );
  const inactiveProducts = catalog.products.filter(
    (product) => product.active === false && product.archived !== true,
  );
  const archivedProducts = catalog.products.filter(
    (product) => product.archived === true,
  );
  const todayOrders = orders.filter(
    (order) => turkeyDateKey(Number(order.createdAt || 0)) === today,
  ).length;
  const availableStock = stock.reduce(
    (sum, row) => sum + Math.max(0, Number(row.available || 0)),
    0,
  );
  const lowStockSkus = stock.filter(
    (row) => row.productActive && row.planActive && row.available <= 3,
  ).length;
  return projectAdminOverview(
    {
      metrics: {
        orders: totalOrders,
        ordersAnalyzed: orders.length,
        ordersComplete:
          orders.length >= totalOrders &&
          (orders.length < OVERVIEW_ORDER_LIMIT || !!ordersCount),
        todayOrders,
        awaitingPayment: awaiting,
        processing,
        delivered: delivered.length,
        cancelled,
        refunded: refunded.length,
        paymentRejected,
        confirmedRevenueKurus: grossRevenueKurus,
        grossRevenueKurus,
        netRevenueKurus: Math.max(0, grossRevenueKurus - refundedKurus),
        deliveredRevenueKurus,
        refundedKurus,
        walletLiabilityKurus: walletSummary.liabilityKurus,
        walletProfilesComplete: walletSummary.profileComplete,
        users: usersSummary.authUsers,
        activeUsers: usersSummary.active,
        purchaseBlockedUsers: usersSummary.purchaseBlocked,
        suspendedUsers: usersSummary.suspended,
        disabledUsers: usersSummary.disabled,
        availableStock,
        lowStockSkus,
        deliveryFailures,
        telegramOrders,
        automaticOrders,
        activeProducts: activeProducts.length,
        inactiveProducts: inactiveProducts.length,
        archivedProducts: archivedProducts.length,
        totalProducts: catalog.products.length,
        activePlans: activeProducts.reduce(
          (sum, product) =>
            sum +
            (product.plans || []).filter((plan) => plan.active !== false)
              .length,
          0,
        ),
        fundedAccounts: walletSummary.fundedAccounts,
      },
      users: usersSummary,
      system: {
        firebaseAdmin: enabled === true,
        firebaseAuth: !!auth,
        firestore: !!db,
        render: configuration.ready === true,
        keyVault: configuration.keyVaultReady === true,
        inventory: inventory.ready === true,
        automaticDelivery:
          catalog.storefront?.services?.automaticDelivery !== false &&
          inventory.ready === true,
        telegram: catalog.storefront?.services?.telegramSupport !== false,
        appCheckMode: configuration.appCheckMode,
        appCheckConfigured: configuration.appCheckConfigured === true,
        configurationReady: configuration.ready,
        missingConfigurationCount: Array.isArray(configuration.missing)
          ? configuration.missing.length
          : 0,
        catalogProducts: catalog.products.length,
      },
      stock: stock
        .sort(
          (left, right) =>
            left.available - right.available ||
            left.productName.localeCompare(right.productName, "tr"),
        )
        .slice(0, 30),
      generatedAt: Date.now(),
    },
    policy,
  );
}

function normalizeAudit(doc, source) {
  const row = doc.data() || {};
  const details =
    row.details && typeof row.details === "object" ? row.details : {};
  return {
    id: doc.id,
    eventId: safeText(row.eventId || doc.id, 180),
    source,
    action: safeText(row.action || row.type, 160),
    actor: {
      uid: safeText(
        row.actor?.uid || (source === "admin" ? row.uid : "system"),
        160,
      ),
      email: safeText(row.actor?.email, 254).toLowerCase(),
      role: safeText(row.actor?.role, 40),
    },
    targetUid: safeText(details.targetUid || row.uid, 160),
    orderId: safeText(details.orderId || row.orderId, 160),
    summary: safeText(
      details.reason || row.reason || row.orderNumber || details.summary || "",
      200,
    ),
    requestId: safeText(row.requestId || details.requestId, 180),
    ipHash: safeText(row.ipHash || details.ipHash, 96),
    userAgent: safeText(row.userAgent || details.userAgent, 180),
    before:
      details.before ??
      (row.previousStatus ? { status: row.previousStatus } : null),
    after: details.after ?? (row.status ? { status: row.status } : null),
    result: /fail|denied|reject|uncertain/i.test(row.action || row.type || "")
      ? "Başarısız / doğrulama gerekli"
      : "Kaydedildi",
    deletable: require("./orderMaintenanceService").auditPolicy(row).eligible,
    createdAt: Math.max(0, Number(row.createdAt || row.at || 0) || 0),
  };
}

async function listAuditLogs(limit = 100, targetUid = "") {
  const { db } = firebaseStore();
  const safeLimit = Math.max(
    1,
    Math.min(200, Math.trunc(Number(limit) || 100)),
  );
  const [adminSnapshot, storeSnapshot] = await Promise.all([
    db
      .collection("adminAudit")
      .orderBy("createdAt", "desc")
      .limit(safeLimit)
      .get()
      .catch(() => db.collection("adminAudit").limit(safeLimit).get()),
    db
      .collection("audit")
      .orderBy("at", "desc")
      .limit(safeLimit)
      .get()
      .catch(() => db.collection("audit").limit(safeLimit).get()),
  ]);
  const safeTargetUid = safeText(targetUid, 160);
  return [
    ...adminSnapshot.docs.map((doc) => normalizeAudit(doc, "admin")),
    ...require("./adminTransientStore")
      .recentAudits()
      .map((row) => normalizeAudit({ id: row.id, data: () => row }, "admin")),
    ...storeSnapshot.docs.map((doc) => normalizeAudit(doc, "store")),
  ]
    .filter(
      (row) =>
        !safeTargetUid ||
        row.targetUid === safeTargetUid ||
        row.actor?.uid === safeTargetUid,
    )
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, safeLimit);
}

async function listStaff() {
  const { db } = firebaseStore();
  const snapshot = await db.collection("adminUsers").limit(100).get();
  const rows = snapshot.docs.map((doc) => {
    const row = doc.data() || {};
    const role = staffRole(row);
    return {
      uid: safeText(row.uid || doc.id, 160),
      email: safeText(row.email, 254).toLowerCase(),
      role,
      permissions: ROLE_PERMISSIONS[role],
      active:
        row.active !== false && row.disabled !== true && row.revoked !== true,
      updatedAt: Math.max(0, Number(row.updatedAt || 0) || 0),
    };
  });
  if (env.adminUids[0])
    rows.unshift({
      uid: env.adminUids[0],
      email: env.adminEmails[0] || "",
      role: "owner",
      permissions: ["*"],
      active: true,
      systemOwner: true,
      updatedAt: 0,
    });
  return rows;
}

async function resolveStaffPolicy(uid = "", email = "") {
  const safeUid = safeText(uid, 160);
  const safeEmail = safeText(email, 254).toLowerCase();
  if (!safeUid || !safeEmail) return null;
  if (
    env.adminUids.length === 1 &&
    env.adminEmails.length === 1 &&
    env.adminUids[0] === safeUid &&
    env.adminEmails[0] === safeEmail
  ) {
    return {
      uid: safeUid,
      email: safeEmail,
      role: "owner",
      permissions: ROLE_PERMISSIONS.owner,
      active: true,
      systemOwner: true,
      policyVersion: 0,
    };
  }
  const { db } = firebaseStore();
  const snapshot = await db.collection("adminUsers").doc(safeUid).get();
  if (!snapshot.exists) return null;
  const row = snapshot.data() || {};
  const role = staffRole(row);
  const rowEmail = safeText(row.email, 254).toLowerCase();
  if (
    rowEmail !== safeEmail ||
    row.active === false ||
    row.disabled === true ||
    row.revoked === true
  )
    return null;
  return {
    uid: safeUid,
    email: safeEmail,
    role,
    permissions: ROLE_PERMISSIONS[role],
    active: true,
    systemOwner: false,
    policyVersion: Math.max(0, Number(row.policyVersion || 0)),
  };
}

function staffHasPermission(policy = null, permission = "") {
  const permissions = Array.isArray(policy?.permissions)
    ? policy.permissions
    : [];
  return (
    permissions.includes("*") || permissions.includes(safeText(permission, 100))
  );
}

async function upsertStaff({
  uid = "",
  email = "",
  role = "viewer",
  active = true,
  actor = {},
} = {}) {
  const safeUid = safeText(uid, 160),
    safeEmail = safeText(email, 254).toLowerCase();
  const safeRole = safeText(role, 30).toLowerCase();
  const actorUid = safeText(actor.uid, 160),
    actorEmail = safeText(actor.email, 254).toLowerCase();
  if (
    !/^[^/\\<>\s]{1,128}$/.test(safeUid) ||
    [".", ".."].includes(safeUid) ||
    !/^\S+@\S+\.\S+$/.test(safeEmail)
  )
    throw serviceError("ADMIN_STAFF_IDENTITY_INVALID", 400);
  if (env.adminUids.includes(safeUid) || env.adminEmails.includes(safeEmail))
    throw serviceError("ADMIN_OWNER_IMMUTABLE", 409);
  if (safeUid === actorUid)
    throw serviceError("ADMIN_STAFF_SELF_CHANGE_FORBIDDEN", 403);
  if (
    !STAFF_ROLES.includes(safeRole) ||
    safeRole === "owner" ||
    typeof active !== "boolean"
  )
    throw serviceError("ADMIN_STAFF_ROLE_INVALID", 400);
  const { db, auth } = firebaseStore();
  let user;
  try {
    user = await auth.getUser(safeUid);
  } catch (_) {
    throw serviceError("STORE_ACCOUNT_NOT_FOUND", 404);
  }
  if (String(user.email || "").toLowerCase() !== safeEmail)
    throw serviceError("ADMIN_STAFF_IDENTITY_MISMATCH", 409);
  if (active && (user.disabled === true || user.emailVerified !== true))
    throw serviceError("ADMIN_STAFF_ACCOUNT_NOT_READY", 409);
  const ownerActor =
    env.adminUids.length === 1 &&
    env.adminEmails.length === 1 &&
    actorUid === env.adminUids[0] &&
    actorEmail === env.adminEmails[0];
  const ref = db.collection("adminUsers").doc(safeUid);
  return db.runTransaction(async (transaction) => {
    // A concurrent actor revocation conflicts with this read before a new grant commits.
    const actorSnapshot = ownerActor
      ? null
      : await transaction.get(
          db.collection("adminUsers").doc(actorUid || "_invalid"),
        );
    const actorPolicy = actorSnapshot?.exists ? actorSnapshot.data() : null;
    if (
      !ownerActor &&
      (!actorPolicy ||
        staffRole(actorPolicy) !== "admin" ||
        actorPolicy.email !== actorEmail ||
        actorPolicy.active === false ||
        actorPolicy.disabled === true ||
        actorPolicy.revoked === true)
    )
      throw serviceError("ADMIN_PERMISSION_REQUIRED", 403);
    const previous = await transaction.get(ref),
      before = previous.exists ? previous.data() : {};
    const row = {
      uid: safeUid,
      email: safeEmail,
      role: safeRole,
      permissions: ROLE_PERMISSIONS[safeRole],
      active,
      disabled: !active,
      revoked: !active,
      policyVersion: Math.max(0, Number(before.policyVersion || 0)) + 1,
      updatedAt: Date.now(),
      updatedBy: { uid: actorUid, email: actorEmail },
    };
    transaction.set(ref, row, { merge: true });
    recordMutationAudit(transaction, db, "store.staff.update", actor, {
      uid: safeUid,
      before: {
        role: before.role || "none",
        active:
          previous.exists &&
          before.active !== false &&
          before.disabled !== true &&
          before.revoked !== true,
        policyVersion: before.policyVersion || 0,
      },
      after: { role: safeRole, active, policyVersion: row.policyVersion },
    });
    return row;
  });
}

function walletLedgerId(scope = "wallet") {
  return `${scope}_${Date.now()}_${crypto.randomBytes(7).toString("hex")}`;
}

let userSummaryLoad = null;
let walletSummaryLoad = null;
let adminCacheGeneration = 0;

async function getUserDirectorySummary(options = {}) {
  if (!userSummaryLoad) {
    const pending = computeUserDirectorySummary(options);
    const tracked = pending.finally(() => {
      if (userSummaryLoad === tracked) userSummaryLoad = null;
    });
    userSummaryLoad = tracked;
  }
  return userSummaryLoad;
}

async function getWalletSummary(options = {}) {
  if (!walletSummaryLoad) {
    const pending = computeWalletSummary(options);
    const tracked = pending.finally(() => {
      if (walletSummaryLoad === tracked) walletSummaryLoad = null;
    });
    walletSummaryLoad = tracked;
  }
  return walletSummaryLoad;
}

function invalidateAdminStoreCaches() {
  adminCacheGeneration += 1;
  userSummaryCache = null;
  walletSummaryCache = null;
  profileSummaryCache = null;
  profileSummaryLoad = null;
  userSummaryLoad = null;
  walletSummaryLoad = null;
}

module.exports = {
  ACCOUNT_STATUSES,
  STAFF_ROLES,
  ROLE_PERMISSIONS,
  resolveStoreUser,
  listStoreUsers,
  updateStoreUser,
  listWalletLedger,
  getUserDirectorySummary,
  getWalletSummary,
  getAdminOverview,
  listAuditLogs,
  listStaff,
  upsertStaff,
  resolveStaffPolicy,
  staffHasPermission,
  walletLedgerId,
  invalidateAdminStoreCaches,
  serviceError,
};
