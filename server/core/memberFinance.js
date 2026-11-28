"use strict";
const { deliveryPaymentConfirmed, paymentChannel } = require("./orderChannel");
const money = (value) => {
  const n =
    typeof value === "string" && /^\d{1,13}$/.test(value)
      ? Number(value)
      : value;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};
function channel(row) {
  if (
    [
      row.paymentMethod,
      row.salesChannel,
      row.paymentProvider,
      row.provider,
    ].some((x) => String(x || "").toLowerCase() === "shopier")
  )
    return "shopier";
  return paymentChannel(row);
}
function facts(row) {
  const source = channel(row);
  const manualRefund = row.manualRefund?.verifiedAt > 0;
  const paidEvidence =
    source === "shopier"
      ? row.shopierPayment?.verifiedAt > 0 ||
        row.providerPayment?.verifiedAt > 0
      : source === "wallet"
        ? row.walletPaidAt > 0 || row.paidAt > 0 || row.walletDebitedKurus > 0
        : source === "telegram"
          ? row.manualPayment?.verifiedAt > 0 || row.approvedAt > 0
          : false;
  const rejected = [
    "pending",
    "payment_pending",
    "rejected",
    "failed",
    "not_captured",
    "reserved",
  ].includes(row.paymentState);
  const captured =
    !rejected &&
    ![
      "pending",
      "payment_pending",
      "payment_rejected",
      "failed",
      "awaiting_payment",
    ].includes(row.status) &&
    (deliveryPaymentConfirmed(row) || paidEvidence);
  const refunded = !!(
    row.walletRefundedAt > 0 ||
    manualRefund ||
    row.shopierRefund?.verifiedAt > 0
  );
  const refund = refunded
    ? money(
        row.walletRefundedKurus ??
          row.manualRefund?.amountKurus ??
          row.shopierRefund?.amountKurus ??
          (manualRefund && row.status === "refunded"
            ? row.totalKurus
            : undefined),
      )
    : 0;
  const deliveredAt =
    (row.delivery?.status === "delivered" ||
      row.status === "delivered" ||
      row.status === "refunded") &&
    (row.delivery?.deliveredAt || row.deliveredAt);
  return {
    source,
    captured,
    amount: money(row.totalKurus),
    refund,
    refunded,
    deliveredAt:
      Number.isSafeInteger(deliveredAt) && deliveredAt > 0 ? deliveredAt : null,
  };
}
function aggregate(rows) {
  let gross = 0,
    refund = 0,
    lastDeliveryAt = 0,
    lastOrderAt = 0;
  for (const row of rows) {
    const v = facts(row);
    if (v.captured)
      gross = gross === null || v.amount === null ? null : gross + v.amount;
    refund = refund === null || v.refund === null ? null : refund + v.refund;
    lastOrderAt = Math.max(lastOrderAt, Number(row.createdAt) || 0);
    lastDeliveryAt = Math.max(lastDeliveryAt, v.deliveredAt || 0);
  }
  return {
    totalOrders: rows.length,
    totalSpendKurus: gross,
    refundedKurus: refund,
    lastOrderAt,
    lastDeliveryAt,
  };
}
module.exports = { channel, facts, aggregate };
