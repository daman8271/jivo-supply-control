import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { calculatePoReplenishment } from "../app/lib/replenishment.js";

const snapshot = JSON.parse(
  await readFile(new URL("../app/data/distributor-replenishment.json", import.meta.url), "utf8"),
);

test("calculates PO-only replenishment with stock and case-pack rounding", () => {
  assert.deepEqual(
    calculatePoReplenishment({
      openPoPieces: 101,
      usableStockPieces: 20,
      confirmedInboundPieces: 5,
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
    stockQualified: true,
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.rawNeedPieces, null);
  assert.equal(result.recommendedPieces, null);
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
  const row = snapshot.rows.find((item) => item.id === "chirag:FG0000230");
  assert.ok(row);
  assert.equal(row.casePack, 4);
  assert.equal(row.casePackSource, "Consistent exact ecom product mappings");
  assert.equal(row.recommendedPieces, null, "stale stock must still block release");
});

test("identity blockers preserve PO demand without assigning a fake SKU", () => {
  const blockers = snapshot.rows.filter((row) => row.status === "identity-blocked");
  assert.ok(blockers.length > 0);
  assert.ok(blockers.every((row) => row.sapCode === null));
  assert.ok(blockers.every((row) => row.openPoPieces > 0));
  assert.ok(blockers.every((row) => row.recommendedPieces === null));
});
