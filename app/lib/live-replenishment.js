import { calculatePoReplenishment } from "./replenishment.js";

/**
 * Replace dated replenishment stock evidence with the same canonical live
 * distributor positions used by the Distributor network module.
 *
 * Distributors absent from the live projection keep their existing evidence.
 * A SKU absent from a complete tracked distributor report is an explicit zero.
 */
export function applyLiveDistributorStock(rows, liveProjection) {
  if (liveProjection?.status !== "live-projection") {
    return rows.map((row) => ({ ...row, liveStockApplied: false }));
  }

  const tracked = new Map(
    (liveProjection.distributors ?? []).map((distributor) => [
      distributor.id,
      new Map((distributor.rows ?? []).map((row) => [row.sapCode, row])),
    ]),
  );
  const transit = new Map(
    (liveProjection.transit ?? []).map((distributor) => [
      distributor.id,
      {
        leadTimeDays: Number(distributor.leadTimeDays),
        rows: new Map((distributor.rows ?? []).map((row) => [row.sapCode, row])),
      },
    ]),
  );

  return rows.map((row) => {
    const positions = tracked.get(row.distributorId);
    const transitDistributor = transit.get(row.distributorId);
    const transitPosition = row.sapCode
      ? transitDistributor?.rows.get(row.sapCode) ?? null
      : null;
    const inTransitPieces = row.sapCode && transitDistributor
      ? Number(transitPosition?.inTransitPieces ?? 0)
      : null;
    const inboundQualified = row.sapCode ? Boolean(transitDistributor) : false;

    if (!positions || !row.sapCode) {
      const calculation = calculatePoReplenishment({
        openPoPieces: row.openPoPieces,
        usableStockPieces: row.usableStockPieces,
        confirmedInboundPieces: inTransitPieces,
        inboundQualified,
        casePack: row.casePack,
        stockQualified: row.stockQualified,
      });
      return {
        ...row,
        liveStockApplied: false,
        inTransitPieces,
        inTransitLeadDays: transitDistributor?.leadTimeDays ?? null,
        inTransitExpectedArrivalDate: transitPosition?.expectedArrivalDate ?? null,
        confirmedInboundPieces: inTransitPieces,
        confirmedInboundIncludedPieces: inTransitPieces,
        inboundQualified,
        rawNeedPieces: calculation.rawNeedPieces,
        recommendedPieces: calculation.recommendedPieces,
        status: row.sapCode ? calculation.status : row.status,
        blocker: row.sapCode ? calculation.blocker : row.blocker,
      };
    }

    const position = positions.get(row.sapCode) ?? null;
    const projectedPieces = Number(position?.projectedPieces ?? 0);
    const usableStockPieces = Math.max(0, projectedPieces);
    const stockQualified = !position || position.status !== "exception";
    const calculation = calculatePoReplenishment({
      openPoPieces: row.openPoPieces,
      usableStockPieces,
      confirmedInboundPieces: inTransitPieces,
      inboundQualified,
      casePack: row.casePack,
      stockQualified,
    });

    return {
      ...row,
      evidencedStockPieces: usableStockPieces,
      trackerBalancePieces: projectedPieces,
      stockAsOf: liveProjection.observedAt,
      stockStatus: !stockQualified
        ? "live-projected-exception"
        : position
          ? "live-projected"
          : "live-qualified-zero",
      stockQualified,
      liveStockApplied: true,
      inTransitPieces,
      inTransitLeadDays: transitDistributor?.leadTimeDays ?? null,
      inTransitExpectedArrivalDate: transitPosition?.expectedArrivalDate ?? null,
      confirmedInboundPieces: inTransitPieces,
      confirmedInboundIncludedPieces: inTransitPieces,
      inboundQualified,
      rawNeedPieces: calculation.rawNeedPieces,
      recommendedPieces: calculation.recommendedPieces,
      status: calculation.status,
      blocker: calculation.blocker,
    };
  });
}
