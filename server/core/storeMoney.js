'use strict';

const MAX_STORE_BALANCE_KURUS = 1_000_000_000_000;

function checkedBalance(value = 0) {
  // Older wallet documents may contain a canonical decimal string.
  const amount = typeof value === 'string' && /^\d{1,13}$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_STORE_BALANCE_KURUS) {
    throw Object.assign(new Error('STORE_BALANCE_RECORD_INVALID'), { code: 'STORE_BALANCE_RECORD_INVALID', statusCode: 409 });
  }
  return amount;
}

function readStoredBalance(profile = {}) {
  return checkedBalance(profile.storeBalanceKurus ?? profile.storeWallet?.balanceKurus ?? 0);
}

function readAvailableBalance(profile={}) {
 const balance=readStoredBalance(profile),held=checkedBalance(profile.storeBalanceHeldKurus||0);
 if(held>balance)throw Object.assign(new Error('STORE_BALANCE_RECORD_INVALID'),{code:'STORE_BALANCE_RECORD_INVALID',statusCode:409});
 return balance-held;
}
module.exports = { checkedBalance, readStoredBalance, readAvailableBalance, MAX_STORE_BALANCE_KURUS };
