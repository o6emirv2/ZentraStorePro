"use strict";
const crypto = require("node:crypto");
const { fromEnvironment } = require("./hilehanem-config");
const K = require("./hilehanem-contract");
const REQUIREMENTS = [
  "api_base_url",
  "authentication",
  "account_balance",
  "product_catalog",
  "package_stock_price",
  "purchase",
  "idempotency",
  "order_lookup",
  "license_response",
];
function status({ config = fromEnvironment() } = {}) {
  let contractConfigured = false,
    contractError = "";
  try {
    contractConfigured = Boolean(K.readContract());
  } catch {
    contractError = "HILEHANEM_CONTRACT_INVALID";
  }
  return {
    mode: config.mode,
    configured: config.configured,
    missing: config.missing,
    invalid: config.invalid,
    active: false,
    state: config.configured
      ? contractConfigured
        ? "verification_required"
        : "contract_required"
      : "configuration_required",
    contractConfigured,
    contractVerified: false,
    contractError,
    balanceMinor: null,
    balanceUsdCents: null,
    currency: null,
    lastSuccessAt: 0,
    automaticPurchasing: false,
    stockSynchronization: false,
    requirements: REQUIREMENTS,
  };
}
function fingerprint(config, contract, bindings) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        config.baseUrl,
        config.apiKey,
        contract,
        bindings,
        process.env.HILEHANEM_PURCHASING_ENABLED === "true",
      ]),
    )
    .digest("hex");
}
async function readStatus({ config = fromEnvironment(), db } = {}) {
  const base = status({ config });
  if (!base.configured || !base.contractConfigured) return base;
  const database =
    db || require("../config/firebaseAdmin").initFirebaseAdmin().db;
  if (!database) return base;
  const row = (
    await database.collection("storeSupplierApiState").doc("hilehanem").get()
  ).data();
  if (
    !row ||
    row.fingerprint !== fingerprint(config, K.readContract(), K.mappings()) ||
    Date.now() - row.checkedAt > 150000
  )
    return base;
  const { fingerprint: unused, ...result } = row;
  return { ...base, ...result };
}
async function check(actor, { config = fromEnvironment(), db, provider } = {}) {
  const database =
    db || require("../config/firebaseAdmin").initFirebaseAdmin().db;
  if (!database)
    throw Object.assign(new Error("STORE_STORAGE_UNAVAILABLE"), {
      code: "STORE_STORAGE_UNAVAILABLE",
      statusCode: 503,
    });
  let connection = status({ config }),
    code = config.configured
      ? "HILEHANEM_API_CONTRACT_REQUIRED"
      : "HILEHANEM_CONFIGURATION_REQUIRED";
  const checkedAt = Date.now();
  if (connection.configured && connection.contractConfigured) {
    let identity;
    try {
      const contract = K.readContract(),
        bindings = K.mappings();
      identity = fingerprint(config, contract, bindings);
      provider ||= K.adapter({ config, contract });
      const account = await provider.balance();
      connection = {
        ...connection,
        active: true,
        state: "connected",
        balanceMinor: account.balanceMinor,
        currency: account.currency,
        minorDigits: account.minorDigits ?? 2,
        balanceUsdCents:
          account.currency === "USD" && (account.minorDigits ?? 2) === 2
            ? account.balanceMinor
            : null,
        lastSuccessAt: checkedAt,
        mappingCount: bindings.length,
      };
      const quotes = [];
      for (let offset = 0; offset < bindings.length; offset += 5)
        quotes.push(
          ...(await Promise.allSettled(
            bindings
              .slice(offset, offset + 5)
              .map((b) =>
                require("./hilehanem-purchase").synchronizeStock(b, {
                  db: database,
                  provider,
                }),
              ),
          )),
        );
      connection.stockSynchronization =
        bindings.length > 0 &&
        quotes.every((result) => result.status === "fulfilled");
      connection.automaticPurchasing =
        connection.stockSynchronization &&
        process.env.HILEHANEM_PURCHASING_ENABLED === "true" &&
        bindings.every(
          (b, i) =>
            b.currency === account.currency &&
            quotes[i].value.unitCostMinor <= b.maximumUnitCostMinor,
        );
      code = "HILEHANEM_READ_VERIFIED";
      if (bindings.length && !connection.stockSynchronization)
        connection.state = "stock_unverified";
    } catch {
      connection = { ...status({ config }), state: "connection_failed" };
      code = "HILEHANEM_CONNECTION_FAILED";
    }
    if (identity)
      await database.runTransaction(async (tx) => {
        const ref = database
          .collection("storeSupplierApiState")
          .doc("hilehanem");
        if (((await tx.get(ref)).data()?.checkedAt || 0) <= checkedAt)
          tx.set(ref, { ...connection, fingerprint: identity, checkedAt });
      });
  }
  await database
    .collection("audit")
    .doc()
    .set({
      type: "supplier-configuration-check",
      action: "supplier.hilehanem.configuration",
      uid: String(actor?.uid || ""),
      result: connection.active ? "verified" : "blocked",
      code,
      at: checkedAt,
    });
  return connection;
}
module.exports = { status, readStatus, check };
