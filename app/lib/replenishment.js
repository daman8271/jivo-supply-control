/**
 * Calculate a PO-only replenishment recommendation.
 * Confirmed inbound is the only in-transit quantity allowed to offset demand.
 *
 * @param {{
 *   openPoPieces: number;
 *   usableStockPieces: number | null;
 *   confirmedInboundPieces?: number | null;
 *   inboundQualified: boolean;
 *   casePack?: number | null;
 *   stockQualified: boolean;
 * }} input
 */
export function calculatePoReplenishment(input) {
  const openPoPieces = Math.max(0, Number(input.openPoPieces) || 0);
  if (openPoPieces === 0) {
    return {
      rawNeedPieces: 0,
      recommendedPieces: 0,
      status: "no-demand",
      blocker: null,
    };
  }
  if (!input.stockQualified || input.usableStockPieces === null) {
    return {
      rawNeedPieces: null,
      recommendedPieces: null,
      status: "blocked",
      blocker: "Distributor stock is not qualified at SKU level.",
    };
  }
  if (!input.inboundQualified || input.confirmedInboundPieces === null || input.confirmedInboundPieces === undefined) {
    return {
      rawNeedPieces: null,
      recommendedPieces: null,
      status: "blocked",
      blocker: "Confirmed inbound evidence is missing; zero cannot be assumed.",
    };
  }

  const usableStockPieces = Math.max(0, Number(input.usableStockPieces) || 0);
  const confirmedInboundPieces = Math.max(
    0,
    Number(input.confirmedInboundPieces) || 0,
  );
  const rawNeedPieces = Math.max(
    0,
    openPoPieces - usableStockPieces - confirmedInboundPieces,
  );
  if (rawNeedPieces === 0) {
    return {
      rawNeedPieces,
      recommendedPieces: 0,
      status: "covered",
      blocker: null,
    };
  }

  const casePack = Number(input.casePack);
  if (!Number.isFinite(casePack) || casePack <= 0) {
    return {
      rawNeedPieces: null,
      recommendedPieces: null,
      status: "blocked",
      blocker: "Case-pack evidence is missing; no exact quantity is shown.",
    };
  }

  return {
    rawNeedPieces,
    recommendedPieces: Math.ceil(rawNeedPieces / casePack) * casePack,
    status: "replenish",
    blocker: null,
  };
}
