export interface NativeReserveProjection {
  balance: bigint;
  transactionValue: bigint;
  bufferedGasCost: bigint;
  nativeCredit?: bigint;
  minimumReserve: bigint;
}

export function reserveRequiredBeforeNativeCredit(
  minimumReserve: bigint,
  receivesNative: boolean,
): bigint {
  return receivesNative ? 0n : minimumReserve;
}

export function assertNativeReserveAfterTransaction({
  balance,
  transactionValue,
  bufferedGasCost,
  nativeCredit = 0n,
  minimumReserve,
}: NativeReserveProjection): bigint {
  const upfrontCost = transactionValue + bufferedGasCost;
  if (balance < upfrontCost) {
    throw new Error("native ETH balance cannot cover the transaction value and estimated gas");
  }

  const projectedBalance = balance - upfrontCost + nativeCredit;
  if (projectedBalance < minimumReserve) {
    throw new Error("transaction would leave less than the required native ETH reserve after estimated gas");
  }
  return projectedBalance;
}

