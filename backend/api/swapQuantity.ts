export function transactionQuantity(value: string | undefined): bigint {
  if (value === undefined) return 0n;
  if (!/^(?:0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/.test(value)) {
    throw new Error("swap provider returned an invalid transaction value");
  }
  return BigInt(value);
}

