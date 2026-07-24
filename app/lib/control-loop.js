const HEALTHY = { status: "Ready", tone: "healthy" };

/**
 * Derive operator-facing control-loop states only from the qualified snapshot.
 * This function intentionally contains no formatting or UI concerns so that
 * state transitions can be tested independently of the rendered dashboard.
 *
 * @param {{
 *   demandPieces: number;
 *   targetsStatus?: string | null;
 *   openPoPieces: number;
 *   blockedPoPieces: number;
 *   networkProjectedUnits: number;
 *   missingDistributorOpenings: number;
 *   criticalInventorySkus: number;
 *   productionPieces: number;
 *   productionStatus?: string | null;
 *   materialBlockerCount: number;
 *   productionOrderCount: number;
 *   approvalConfigured: boolean;
 *   approvalState?: string | null;
 * }} input
 */
export function deriveControlStageStates(input) {
  const targetsStatus = String(input.targetsStatus ?? "").toLowerCase();
  const normalizedProductionStatus = String(
    input.productionStatus ?? "Draft",
  ).toLowerCase();
  const approvalState = String(input.approvalState ?? "pending").toLowerCase();

  const demand =
    input.demandPieces <= 0
      ? { status: "Blocked", tone: "blocked" }
      : targetsStatus !== "qualified"
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
      : approvalState === "released" && input.productionOrderCount > 0
        ? { status: "In execution", tone: "draft" }
        : approvalState === "approved" || approvalState === "released"
          ? { status: "Approved", tone: "healthy" }
          : !input.approvalConfigured
            ? { status: "Manual gate", tone: "blocked" }
            : { status: "Awaiting approval", tone: "watch" };

  return {
    demand,
    platformPos,
    networkStock,
    production,
    materials,
    approvalAndDispatch,
  };
}

/**
 * Return only unresolved, planner-owned actions for the current snapshot.
 *
 * @param {{
 *   blockedPoPieces: number;
 *   materialBlockerCount: number;
 *   missingDistributorOpenings: number;
 *   criticalInventorySkus: number;
 *   targetsStatus?: string | null;
 * }} input
 */
export function deriveActiveControlActions(input) {
  const actions = [];
  if (input.blockedPoPieces > 0) actions.push("unblock-pos");
  if (input.materialBlockerCount > 0) actions.push("resolve-materials");
  if (input.missingDistributorOpenings > 0) actions.push("confirm-openings");
  if (input.criticalInventorySkus > 0) actions.push("critical-inventory");
  if (String(input.targetsStatus ?? "").toLowerCase() !== "qualified") {
    actions.push("upload-targets");
  }
  return actions;
}
