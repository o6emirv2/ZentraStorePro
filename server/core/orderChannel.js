'use strict';

function paymentChannel(row = {}) {
  const declared = row.paymentMethod;
  if (['telegram', 'wallet'].includes(declared)) return declared;
  if (declared !== undefined && declared !== null && declared !== '') return 'unknown';
  if (row.walletPaidAt || row.walletRefundedAt || row.walletDebitedKurus) return 'wallet';
  if (row.salesChannel === 'telegram' || /^TELEGRAM_/.test(String(row.fulfillmentStatus || ''))) return 'telegram';
  return 'unknown';
}
function hasPaymentEvidence(row = {}) {
  return !!(row.paidAt || row.approvedAt || row.manualPayment?.verifiedAt
    || ['paid', 'processing', 'delivery_pending', 'delivered', 'refunded'].includes(row.status)
    || ['paid', 'refunded'].includes(row.paymentState));
}
function deliveryPaymentConfirmed(row = {}) {
  const channel=paymentChannel(row);
  if (channel==="unknown" || row.walletRefundedAt || row.manualRefund?.verifiedAt || ["refunded","cancelled","payment_rejected"].includes(row.status)) return false;
  if (row.supplier==="hilehanem" && row.supplierState!=="completed") return false;
  if (["pending","rejected","refunded","not_captured","reserved"].includes(row.paymentState)) return false;
  return Number(row.approvedAt)>0 || Number(row.paidAt)>0 ||
    (channel==="wallet" ? Number(row.walletPaidAt)>0 : Number(row.manualPayment?.verifiedAt)>0);
}
module.exports = { paymentChannel, hasPaymentEvidence, deliveryPaymentConfirmed };
