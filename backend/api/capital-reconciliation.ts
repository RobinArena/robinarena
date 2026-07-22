export interface CapitalLedger {
  cashBalance: number;
  equity: number;
  initialBalance: number;
}

export interface EqualCapitalReconciliation {
  adjustmentPerAgent: number;
  currentCapital: number;
  difference: number;
}

export interface CapitalFlowSnapshot {
  currentBrokerEquity: number;
  previousBrokerEquity?: number;
  currentLedgerEquity: number;
  previousLedgerEquity?: number;
}

function rounded(value: number, precision = 4): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

export function externalCapitalFlow(
  snapshot: CapitalFlowSnapshot,
  tolerance = 1,
): number {
  if (
    snapshot.previousBrokerEquity === undefined
    || snapshot.previousLedgerEquity === undefined
  ) return 0;
  const brokerChange = snapshot.currentBrokerEquity - snapshot.previousBrokerEquity;
  const ledgerChange = snapshot.currentLedgerEquity - snapshot.previousLedgerEquity;
  const flow = rounded(brokerChange - ledgerChange);
  return Math.abs(flow) <= tolerance ? 0 : flow;
}

export function equalCapitalReconciliation(
  deployableCapital: number,
  agents: CapitalLedger[],
): EqualCapitalReconciliation {
  if (agents.length === 0) throw new Error("capital reconciliation requires at least one agent");

  const currentCapital = rounded(
    agents.reduce((total, agent) => total + agent.equity, 0),
  );
  const difference = rounded(deployableCapital - currentCapital);
  const adjustmentPerAgent = rounded(difference / agents.length);

  if (adjustmentPerAgent < 0) {
    const insufficient = agents.some((agent) => (
      rounded(agent.cashBalance + adjustmentPerAgent) < 0
      || rounded(agent.initialBalance + adjustmentPerAgent) <= 0
    ));
    if (insufficient) {
      throw new Error("the capital reduction exceeds at least one agent's available cash");
    }
  }

  return {
    adjustmentPerAgent,
    currentCapital,
    difference: rounded(adjustmentPerAgent * agents.length),
  };
}
