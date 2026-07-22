const UINT256_MAX = (1n << 256n) - 1n;

export function parseWithdrawalRequest(value: string): "all" | bigint {
  if (value === "all") return "all";
  if (!/^[1-9][0-9]{0,77}$/.test(value)) {
    throw new Error("Withdrawal amount must be a positive base-unit integer or all");
  }
  const amount = BigInt(value);
  if (amount > UINT256_MAX) throw new Error("Withdrawal amount exceeds uint256");
  return amount;
}

export function bufferedGasLimit(estimatedGas: bigint): bigint {
  if (estimatedGas <= 0n) throw new Error("Gas estimate must be positive");
  return (estimatedGas * 12n + 9n) / 10n;
}

export function tokenWithdrawalAmount(requested: "all" | bigint, balance: bigint): bigint {
  const amount = requested === "all" ? balance : requested;
  if (amount <= 0n) throw new Error("The agent wallet has no balance to withdraw");
  if (amount > balance) throw new Error("Withdrawal amount exceeds the agent wallet balance");
  return amount;
}

export function nativeWithdrawalAmount(
  requested: "all" | bigint,
  balance: bigint,
  maximumFee: bigint,
): bigint {
  if (maximumFee < 0n) throw new Error("Maximum transaction fee cannot be negative");
  if (requested === "all") {
    if (balance <= maximumFee) throw new Error("The native balance cannot cover withdrawal gas");
    return balance - maximumFee;
  }
  if (requested + maximumFee > balance) {
    throw new Error("Withdrawal amount plus gas exceeds the native balance");
  }
  return requested;
}

