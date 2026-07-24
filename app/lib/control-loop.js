const HEALTHY = { status: "Ready", tone: "healthy" };

/**
 * Derive operator-facing control-loop states only from the qualified snapshot.
 * This function intentionally contains no formatting or UI concerns so that
 * state transitions can be tested independently of the rendered dashboard.
 *
 * @param {{
 *   demandPieces: number;
 *   targetsStatus: string;
 *   openPoPieces: number;
 *   blockedPoPieces: number;
 *   networkProjectedUnits: number;
 *   missingDistributorOpenings: number;
 *   criticalInventorySkus: number;
 *   productionPieces: number;
 *   productionStatus: string;
 *   materialBlockerCount: number;
 *   productionOrderCount: number;
 *   approvalConfigured: boolean;
 * }} input
 */
export function deriveControlStageStates(input) {
  const demand =
    input.demandPieces <= 0
      ? { status: "Blocked", tone: "blocked" }
      : input.targetsStatus.toLowerCase() !== "qualified"
        ? { status: "Input needed", tone: "watch" }
        : HEALTHY;

  const platformPos =
    input.openPoPieces <= 0
      ? { status: "Clear", tone: "healthy" }
      : input.blockedPoPieces > 0
        ? { status: "Blocked", tone: "blocked" }
        : HEALTHY;

  const networkStock =
    input.networkProjectedUnits < 0
      ? { status: "Blocked", tone: "blocked" }
      : input.missingDistributorOpenings > 0 || input.criticalInventorySkus > 0
        ? { status: "Watch", tone: "watch" }
        : HEALTHY;

  const normalizedProductionStatus = input.productionStatus.toLowerCase();
  const production =
    input.productionPieces <= 0
      ? { status: "Covered", tone: "healthy" }
      : normalizedProductionStatus.includes("block")
        ? { status: "Blocked", tone: "blocked" }
        : {
            status: input.productionStatus || "Draft",
            tone: "draft",
          };

  const materials =
    input.materialBlockerCount > 0
      ? { status: "Blocked", tone: "blocked" }
      : HEALTHY;

  const approvalAndDispatch =
    input.productionPieces <= 0
      ? { status: "Not required", tone: "healthy" }
      : !input.approvalConfigured
        ? { status: "Manual gate", tone: "blocked" }
        : input.productionOrderCount > 0
          ? { status: "In execution", tone: "draft" }
          : { status: "Approved", tone: "watch" };

  return {
    demand,
    platformPos,
    networkStock,
    production,
    materials,
    approvalAndDispatch,
  };
}
