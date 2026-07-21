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

function rounded(value: number, precision = 4): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
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
