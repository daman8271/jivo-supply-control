import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { calculatePoReplenishment } from "../app/lib/replenishment.js";
import { applyLiveDistributorStock } from "../app/lib/live-replenishment.js";
import {
  attachOwnInventoryMetrics,
  groupReplenishmentRows,
  sortReplenishmentRows,
} from "../app/lib/replenishment-table.js";
import {
  clearDistributorSelection,
  selectAllDistributors,
  toggleDistributorSelection,
} from "../app/lib/distributor-selection.js";

const snapshot = JSON.parse(
  await readFile(new URL("../app/data/distributor-replenishment.json", import.meta.url), "utf8"),
);

test("sorts numeric replenishment columns in both directions with missing values last", () => {
  const rows = [
    { id: "a", skuName: "A", distributorName: "One", openPoPieces: 100 },
    { id: "b", skuName: "B", distributorName: "One", openPoPieces: 300 },
    { id: "c", skuName: "C", distributorName: "One", openPoPieces: null },
    { id: "d", skuName: "D", distributorName: "One", openPoPieces: 100 },
  ];
  assert.deepEqual(
    sortReplenishmentRows(rows, { key: "openPo", direction: "desc" }).map((row) => row.id),
    ["b", "a", "d", "c"],
  );
  assert.deepEqual(
    sortReplenishmentRows(rows, { key: "openPo", direction: "asc" }).map((row) => row.id),
    ["a", "d", "b", "c"],
  );
});

test("supports deterministic sorting for every replenishment header", () => {
  const rows = [
    {
      id: "alpha",
      skuName: "Alpha",
      distributorName: "One",
      requiredInventoryPieces: 10,
      openPoPieces: 20,
      evidencedStockPieces: 5,
      ownOnHandPieces: 100,
      mslPieces: 50,
      recommendedPieces: 1,
      status: "blocked",
    },
    {
      id: "beta",
      skuName: "Beta",
      distributorName: "Two",
      requiredInventoryPieces: 30,
      openPoPieces: 40,
      evidencedStockPieces: 15,
      ownOnHandPieces: 300,
      mslPieces: 250,
      recommendedPieces: 11,
      status: "covered",
    },
  ];
  assert.equal(sortReplenishmentRows(rows, { key: "identity", direction: "asc" })[0].id, "alpha");
  for (const key of ["required", "openPo", "stock", "ownOnHand", "msl", "need"]) {
    assert.equal(sortReplenishmentRows(rows, { key, direction: "desc" })[0].id, "beta", key);
  }
  assert.equal(sortReplenishmentRows(rows, { key: "status", direction: "desc" })[0].id, "alpha");
});

test("joins own on-hand and MSL by canonical SAP code without multiplying grouped values", () => {
  const rows = [
    { id: "a", skuName: "Groundnut 1L", sapCode: "FG1" },
    { id: "b", skuName: "Groundnut 1L", sapCode: "FG1" },
    { id: "c", skuName: "Unmapped", sapCode: null },
  ];
  const decorated = attachOwnInventoryMetrics(
    rows,
    [{ sapCode: "FG1", onHand: 1234 }],
    { FG1: 900 },
  );
  assert.deepEqual(
    decorated.map((row) => [row.ownOnHandPieces, row.mslPieces]),
    [[1234, 900], [1234, 900], [null, null]],
  );

  const grouped = attachOwnInventoryMetrics(
    [{ id: "sap:FG1", skuName: "Groundnut 1L", sapCode: "FG1", rowCount: 2 }],
    [{ sapCode: "FG1", onHand: 1234 }],
    { FG1: 900 },
  );
  assert.equal(grouped[0].ownOnHandPieces, 1234);
  assert.equal(grouped[0].mslPieces, 900);
});

test("groups SKU rows and ranks aggregate platform PO pieces highest to lowest", () => {
  const base = {
    itemHead: "PREMIUM",
    category: "GROUNDNUT",
    requiredInventoryPieces: 0,
    unqualifiedRequirementPieces: 0,
    poNumbers: [],
    platforms: ["SWIGGY"],
    stockQualified: true,
    liveStockApplied: true,
    stockStatus: "live-projected",
    rawNeedPieces: null,
    recommendedPieces: null,
    status: "blocked",
  };
  const groups = groupReplenishmentRows([
    { ...base, id: "a", distributorName: "Chirag", skuName: "GROUNDNUT 1L", sapCode: "FG1", openPoPieces: 100, openPoCount: 1, evidencedStockPieces: 20 },
    { ...base, id: "b", distributorName: "Antize", skuName: "GROUNDNUT 1L", sapCode: "FG1", openPoPieces: 300, openPoCount: 2, evidencedStockPieces: 30 },
    { ...base, id: "c", distributorName: "Baba", skuName: "MUSTARD 1L", sapCode: "FG2", openPoPieces: 250, openPoCount: 4, evidencedStockPieces: 40 },
  ]);
  const ranked = sortReplenishmentRows(groups, { key: "openPo", direction: "desc" });
  assert.equal(ranked[0].sapCode, "FG1");
  assert.equal(ranked[0].openPoPieces, 400);
  assert.equal(ranked[0].openPoCount, 3);
  assert.equal(ranked[0].qualifiedStockPieces, 50);
  assert.deepEqual(ranked[0].distributorNames, ["Chirag", "Antize"]);
  assert.equal(ranked[1].openPoPieces, 250);
});

test("groups exact unresolved labels but does not fuzzy-merge lookalikes", () => {
  const unresolved = {
    distributorName: "Distributor",
    skuName: "MUSTARD 1L",
    sapCode: null,
    itemHead: "UNMAPPED",
    category: "UNMAPPED",
    requiredInventoryPieces: null,
    unqualifiedLastMonthPoPieces: 0,
    openPoPieces: 100,
    openPoCount: 1,
    poNumbers: [],
    platforms: ["ZEPTO"],
    stockQualified: false,
    liveStockApplied: false,
    stockStatus: "identity-blocked",
    evidencedStockPieces: null,
    rawNeedPieces: null,
    recommendedPieces: null,
    status: "identity-blocked",
    blocker: "SAP identity unresolved",
  };
  const groups = groupReplenishmentRows([
    { ...unresolved, id: "unmapped-a" },
    { ...unresolved, id: "unmapped-b" },
    { ...unresolved, id: "lookalike", skuName: "MUSTARD 1 L" },
  ]);
  assert.equal(groups.length, 2);
  const exact = groups.find((group) => group.skuName === "MUSTARD 1L");
  assert.equal(exact.openPoPieces, 200);
  assert.equal(exact.rowCount, 2);
});

test("includes exact-label identity blockers in the matching canonical SKU total", () => {
  const base = {
    distributorName: "Chirag",
    skuName: "GROUNDNUT 1L",
    itemHead: "PREMIUM",
    category: "GROUNDNUT",
    requiredInventoryPieces: 0,
    unqualifiedLastMonthPoPieces: 0,
    openPoCount: 1,
    poNumbers: [],
    platforms: ["SWIGGY"],
    liveStockApplied: false,
    rawNeedPieces: null,
    recommendedPieces: null,
    blocker: "Evidence blocked",
  };
  const [group] = groupReplenishmentRows([
    {
      ...base,
      id: "mapped",
      sapCode: "FG0000142",
      openPoPieces: 300,
      stockQualified: true,
      stockStatus: "live-projected",
      evidencedStockPieces: 20,
      status: "blocked",
    },
    {
      ...base,
      id: "alias",
      sapCode: null,
      openPoPieces: 100,
      stockQualified: false,
      stockStatus: "identity-blocked",
      evidencedStockPieces: null,
      status: "identity-blocked",
    },
  ]);
  assert.equal(group.sapCode, "FG0000142");
  assert.equal(group.openPoPieces, 400);
  assert.equal(group.qualifiedStockPieces, 20);
  assert.equal(group.exactLabelAliasRows, 1);
  assert.deepEqual(
    group.details.map((detail) => detail.identityType),
    ["canonical", "exact-label-alias"],
  );
});

test("full snapshot SKU groups reconcile all mapped and identity-blocked PO demand", () => {
  const groups = groupReplenishmentRows(snapshot.rows);
  assert.equal(
    groups.reduce((sum, group) => sum + group.openPoPieces, 0),
    snapshot.summary.openPoPieces,
  );
  const groundnut = groups.find((group) => group.sapCode === "FG0000142");
  assert.equal(groundnut.openPoPieces, 72096);
  assert.equal(groundnut.exactLabelAliasRows, 4);
  assert.equal(
    groundnut.details.reduce((sum, detail) => sum + detail.openPoPieces, 0),
    groundnut.openPoPieces,
  );
});

test("distributor selection supports independent multi-select, clear and select all", () => {
  const distributors = [{ id: "chirag" }, { id: "antize" }, { id: "evara" }];
  assert.deepEqual(selectAllDistributors(distributors), ["chirag", "antize", "evara"]);
  assert.deepEqual(toggleDistributorSelection(["chirag"], "antize"), ["chirag", "antize"]);
  assert.deepEqual(toggleDistributorSelection(["chirag", "antize"], "chirag"), ["antize"]);
  assert.deepEqual(clearDistributorSelection(), []);
});

test("uses the exact Distributor network live SOH in SKU replenishment", () => {
  const source = snapshot.rows.find(
    (row) => row.distributorId === "chirag" && row.sapCode === "FG0000142",
  );
  assert.ok(source);

  const [liveRow] = applyLiveDistributorStock([source], {
    status: "live-projection",
    observedAt: "2026-07-30T16:55:30.781875+00:00",
    distributors: [
      {
        id: "chirag",
        rows: [
          {
            sapCode: "FG0000142",
            projectedPieces: 3587,
            status: "qualified",
          },
        ],
      },
    ],
  });

  assert.equal(liveRow.evidencedStockPieces, 3587);
  assert.equal(liveRow.trackerBalancePieces, 3587);
  assert.equal(liveRow.stockStatus, "live-projected");
  assert.equal(liveRow.stockAsOf, "2026-07-30T16:55:30.781875+00:00");
  assert.equal(liveRow.liveStockApplied, true);
});

test("uses Jivo Mart billing in transit as qualified inbound with distributor lead time", () => {
  const source = snapshot.rows.find(
    (row) => row.distributorId === "knowtable" && row.sapCode === "FG0000142",
  );
  assert.ok(source);

  const [liveRow] = applyLiveDistributorStock([source], {
    status: "live-projection",
    observedAt: "2026-07-31T06:30:00+00:00",
    distributors: [],
    transit: [
      {
        id: "knowtable",
        leadTimeDays: 8,
        pieces: 72,
        rows: [
          {
            sapCode: "FG0000142",
            inTransitPieces: 72,
            expectedArrivalDate: "2026-08-06",
          },
        ],
      },
    ],
  });

  assert.equal(liveRow.liveStockApplied, false);
  assert.equal(liveRow.inTransitPieces, 72);
  assert.equal(liveRow.inTransitLeadDays, 8);
  assert.equal(liveRow.inTransitExpectedArrivalDate, "2026-08-06");
  assert.equal(liveRow.confirmedInboundPieces, 72);
  assert.equal(liveRow.inboundQualified, true);
});

test("treats an absent SKU as qualified zero only for a complete live distributor", () => {
  const source = snapshot.rows.find(
    (row) => row.distributorId === "antize" && row.sapCode === "FG0000142",
  );
  assert.ok(source);

  const [liveRow] = applyLiveDistributorStock([source], {
    status: "live-projection",
    observedAt: "2026-07-30T16:55:30.781875+00:00",
    distributors: [{ id: "antize", rows: [] }],
  });
  assert.equal(liveRow.evidencedStockPieces, 0);
  assert.equal(liveRow.stockStatus, "live-qualified-zero");
  assert.equal(liveRow.stockQualified, true);
});

test("does not label retained replenishment stock live when the projection is stale", () => {
  const source = snapshot.rows.find(
    (row) => row.distributorId === "chirag" && row.sapCode === "FG0000142",
  );
  const [retained] = applyLiveDistributorStock([source], {
    status: "fallback",
    observedAt: "2026-07-30T16:55:30.781875+00:00",
    distributors: [],
  });
  assert.equal(retained.evidencedStockPieces, source.evidencedStockPieces);
  assert.equal(retained.stockStatus, source.stockStatus);
  assert.equal(retained.liveStockApplied, false);
});

test("calculates PO-only replenishment with stock and case-pack rounding", () => {
  assert.deepEqual(
    calculatePoReplenishment({
      openPoPieces: 101,
      usableStockPieces: 20,
      confirmedInboundPieces: 5,
      inboundQualified: true,
      casePack: 16,
      stockQualified: true,
    }),
    {
      rawNeedPieces: 76,
      recommendedPieces: 80,
      status: "replenish",
      blocker: null,
    },
  );
});

test("never invents a recommendation when SKU stock is unqualified", () => {
  const result = calculatePoReplenishment({
    openPoPieces: 100,
    usableStockPieces: null,
    casePack: 10,
    stockQualified: false,
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.rawNeedPieces, null);
  assert.equal(result.recommendedPieces, null);
});

test("hides exact need and blocks release when case pack is missing", () => {
  const result = calculatePoReplenishment({
    openPoPieces: 100,
    usableStockPieces: 35,
    confirmedInboundPieces: 0,
    inboundQualified: true,
    stockQualified: true,
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.rawNeedPieces, null);
  assert.equal(result.recommendedPieces, null);
});

test("blocks exact need when inbound is unknown instead of assuming zero", () => {
  const result = calculatePoReplenishment({
    openPoPieces: 100,
    usableStockPieces: 35,
    confirmedInboundPieces: null,
    inboundQualified: false,
    casePack: 10,
    stockQualified: true,
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.rawNeedPieces, null);
  assert.equal(result.recommendedPieces, null);
  assert.match(result.blocker, /inbound evidence is missing/i);
});

test("snapshot preserves company and UOM provenance and blocks blank PO UOM", () => {
  const mappedDemand = snapshot.rows.filter(
    (row) => row.sapCode && row.openPoPieces > 0,
  );
  assert.ok(mappedDemand.length > 0);
  assert.ok(
    mappedDemand.every(
      (row) =>
        row.companyCode === "JIVO_MART" &&
        row.sapSchema === "JIVO_MART_HANADB" &&
        row.baseUom &&
        row.perUnit &&
        row.planningUom,
    ),
  );

  const missingUomPieces = snapshot.rows
    .filter((row) => row.blocker?.includes("PO UOM is missing"))
    .reduce((sum, row) => sum + row.openPoPieces, 0);
  assert.equal(missingUomPieces, 13968);

  const martGroundnut = snapshot.rows.filter(
    (row) => row.sapCode === "FG0000393",
  );
  assert.equal(martGroundnut.length, 6);
  assert.ok(martGroundnut.every((row) => row.casePack !== 20));
});

test("snapshot never assumes unknown inbound is zero", () => {
  assert.ok(
    snapshot.rows.every(
      (row) =>
        row.inboundQualified === false &&
        row.confirmedInboundPieces === null &&
        row.confirmedInboundIncludedPieces === null,
    ),
  );
});

test("previous-month requirement reconciles and rounds once per distributor-SKU", () => {
  assert.equal(snapshot.policy.requirementPeriodStart, "2026-06-01");
  assert.equal(snapshot.policy.requirementPeriodEnd, "2026-06-30");
  assert.equal(
    snapshot.summary.lastMonthQualifiedPoPieces +
      snapshot.summary.unqualifiedLastMonthPoPieces,
    466684,
  );
  assert.equal(
    snapshot.rows.reduce((sum, row) => sum + (row.lastMonthPoPieces ?? 0), 0),
    snapshot.summary.lastMonthQualifiedPoPieces,
  );
  assert.equal(
    snapshot.rows.reduce((sum, row) => sum + (row.requiredInventoryPieces ?? 0), 0),
    snapshot.summary.requiredInventoryPieces,
  );

  for (const row of snapshot.rows.filter((item) => item.requirementQualified)) {
    assert.equal(
      row.requiredInventoryPieces,
      Math.ceil((row.lastMonthPoPieces * 80) / 100),
      row.id,
    );
  }
  assert.ok(
    snapshot.rows
      .filter((row) => !row.requirementQualified)
      .every((row) => row.requiredInventoryPieces === null),
  );
});

test("snapshot crosses every canonical SKU with every distributor", () => {
  const canonicalCodes = new Set(
    snapshot.rows.filter((row) => row.sapCode).map((row) => row.sapCode),
  );
  assert.equal(snapshot.distributors.length, 6);
  assert.equal(canonicalCodes.size, snapshot.summary.canonicalSkus);

  for (const code of canonicalCodes) {
    const distributors = new Set(
      snapshot.rows
        .filter((row) => row.sapCode === code)
        .map((row) => row.distributorId),
    );
    assert.equal(distributors.size, 6, `${code} must exist for all distributors`);
  }
});

test("snapshot totals reconcile to its row-level evidence", () => {
  const openPoPieces = snapshot.rows.reduce(
    (sum, row) => sum + row.openPoPieces,
    0,
  );
  const mappedOpenPoPieces = snapshot.rows.reduce(
    (sum, row) => sum + (row.sapCode ? row.openPoPieces : 0),
    0,
  );
  const blockedOpenPoPieces = snapshot.rows.reduce(
    (sum, row) => sum + (row.recommendedPieces === null ? row.openPoPieces : 0),
    0,
  );
  const recommendedPieces = snapshot.rows.reduce(
    (sum, row) => sum + (row.recommendedPieces ?? 0),
    0,
  );

  assert.equal(openPoPieces, snapshot.summary.openPoPieces);
  assert.equal(mappedOpenPoPieces, snapshot.summary.mappedOpenPoPieces);
  assert.equal(blockedOpenPoPieces, snapshot.summary.blockedOpenPoPieces);
  assert.equal(
    snapshot.summary.identityBlockedOpenPoPieces +
      snapshot.summary.mappedEvidenceBlockedOpenPoPieces,
    snapshot.summary.blockedOpenPoPieces,
  );
  assert.equal(recommendedPieces, snapshot.summary.recommendedPieces);
  assert.equal(openPoPieces, 343268);
  assert.ok(
    snapshot.rows.every((row) => row.poNumbers.length === row.openPoCount),
    "every row must preserve its PO references",
  );
  assert.ok(
    snapshot.rows.every((row) => row.planningCutoff === snapshot.planningCutoff),
    "every row must carry the planner cutoff timestamp",
  );
});

test("any qualified recommendations reproduce the canonical formula", () => {
  for (const row of snapshot.rows.filter((item) => item.status === "replenish")) {
    const result = calculatePoReplenishment({
      openPoPieces: row.openPoPieces,
      usableStockPieces: row.usableStockPieces,
      confirmedInboundPieces: row.confirmedInboundIncludedPieces,
      inboundQualified: row.inboundQualified,
      casePack: row.casePack,
      stockQualified: row.stockQualified,
    });
    assert.equal(result.rawNeedPieces, row.rawNeedPieces, row.id);
    assert.equal(result.recommendedPieces, row.recommendedPieces, row.id);
    assert.ok(row.casePackSource, row.id);
  }
});

test("stale Antize physical count stays visible but cannot offset demand", () => {
  const antizePhysical = snapshot.rows
    .filter((row) => row.distributorId === "antize")
    .reduce((sum, row) => sum + (row.evidencedStockPieces ?? 0), 0);
  assert.equal(antizePhysical, 42322);
  assert.ok(
    snapshot.rows
      .filter((row) => row.distributorId === "antize" && row.openPoPieces > 0)
      .every((row) => row.recommendedPieces === null),
  );

  for (const distributorId of ["knowtable", "evara"]) {
    const demanded = snapshot.rows.filter(
      (row) => row.distributorId === distributorId && row.openPoPieces > 0,
    );
    assert.ok(demanded.length > 0);
    assert.ok(
      demanded.every((row) => row.recommendedPieces === null),
      `${distributorId} demand must stay blocked until stock is qualified`,
    );
  }
});

test("stale stock and unavailable source timestamps fail closed", () => {
  assert.equal(snapshot.policy.maxStockAgeDays, 2);
  assert.equal(snapshot.summary.recommendedPieces, 0);
  assert.equal(snapshot.summary.blockedOpenPoPieces, snapshot.summary.openPoPieces);
  assert.ok(
    snapshot.rows
      .filter((row) => row.openPoPieces > 0 && row.stockStatus.startsWith("stale-"))
      .every((row) => row.rawNeedPieces === null && row.recommendedPieces === null),
  );
  assert.ok(snapshot.sources.every((source) => /^[a-f0-9]{64}$/.test(source.sha256)));
  assert.ok(snapshot.sources.some((source) => source.asOf === null));
});

test("consistent exact product mappings can qualify a missing calculator case pack", () => {
  const row = snapshot.rows.find(
    (item) => item.distributorId === "chirag" && item.sapCode === "FG0000230",
  );
  assert.ok(row);
  assert.equal(row.casePack, 4);
  assert.equal(row.casePackSource, "Consistent exact ecom product mappings");
  assert.equal(row.recommendedPieces, null, "stale stock must still block release");
});

test("identity blockers preserve current or historical PO evidence without assigning a fake SKU", () => {
  const blockers = snapshot.rows.filter((row) => row.status === "identity-blocked");
  assert.ok(blockers.length > 0);
  assert.ok(blockers.every((row) => row.sapCode === null));
  assert.ok(
    blockers.every(
      (row) =>
        row.openPoPieces > 0 ||
        ("unqualifiedLastMonthPoPieces" in row && row.unqualifiedLastMonthPoPieces > 0),
    ),
  );
  assert.ok(blockers.every((row) => row.recommendedPieces === null));
  assert.ok(blockers.every((row) => row.blocker.length > 0));
});
