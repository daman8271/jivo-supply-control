import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html", host: "localhost" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the end-to-end supply control loop by default", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Jivo Supply Control<\/title>/i);
  assert.match(html, /Control loop/);
  assert.match(html, /Demand/);
  assert.match(html, /Platform POs/);
  assert.match(html, /Network stock/);
  assert.match(html, /Production/);
  assert.match(html, /Materials/);
  assert.match(html, /Approval &amp; dispatch/);
  assert.match(html, /Prioritized action queue/);
  assert.match(html, /Unblock 67,807 PO pieces/);
  assert.match(html, /Resolve 6 material blockers/);
  assert.match(html, /Confirm 2 missing distributor openings/);
  assert.match(html, /Address 3 critical JM SKUs/);
  assert.match(html, /Upload August targets/);
  assert.match(html, /Source systems remain read-only/);
  assert.match(html, /24 July 2026/);
  assert.match(html, /recommended actions stay inside the planner until approved/i);
  assert.match(html, /Overview/);
  assert.match(html, /SKU replenishment/);
  assert.match(html, /Production planning/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|taking shape/i);
});

test("seed data preserves reconciled inventory totals", async () => {
  const seed = JSON.parse(
    await readFile(new URL("../app/data/seed.json", import.meta.url), "utf8"),
  );

  assert.equal(seed.jmTotals.skus, 23);
  assert.equal(seed.jmTotals.onHand, 190934);
  assert.equal(seed.jmTotals.available, 145142);
  assert.equal(seed.jmTotals.criticalSkus, 3);
  assert.equal(seed.distributorSummary.length, 6);
  assert.equal(seed.formula.equivalent, "BAL = SOH + Billing - GRN");
  assert.equal(seed.liveReconciliation.all.opening, 134378);
  assert.equal(seed.liveReconciliation.all.billing, 166505);
  assert.equal(seed.liveReconciliation.all.grn, 128335);
  assert.equal(seed.liveReconciliation.all.projected, 172548);
  assert.equal(
    seed.liveReconciliation.all.projected,
    seed.liveReconciliation.all.opening +
      seed.liveReconciliation.all.billing -
      seed.liveReconciliation.all.grn,
  );
  const canola = seed.jmInventory.find(
    (row) => row.sapCode === "FG0000032",
  );
  assert.deepEqual(canola.sourceSapCodes.sort(), [
    "FG0000032",
    "FG0000421",
    "FG0000422",
  ]);
  assert.equal(canola.available, 9839);
  assert.equal(canola.status, "Healthy");
});

test("production plan preserves the draft factory calculation", async () => {
  const plan = JSON.parse(
    await readFile(
      new URL("../app/data/production-plan.json", import.meta.url),
      "utf8",
    ),
  );

  assert.equal(plan.status, "Draft");
  assert.equal(plan.planningMonth, "August 2026");
  assert.equal(plan.defaultAssumptions.safetyDays, 7);
  assert.equal(plan.rows.length, 13);
  assert.equal(plan.totals.forecastPieces, 440813);
  assert.equal(plan.totals.productionPieces, 355628);
  assert.ok(
    plan.rows.every(
      (row) => row.suggestedProductionPieces % row.casePack === 0,
    ),
  );
});

test("production signals preserve the live August PO floor", async () => {
  const signals = JSON.parse(
    await readFile(
      new URL("../app/data/production-signals.json", import.meta.url),
      "utf8",
    ),
  );

  assert.equal(signals.targets.status, "Not uploaded");
  assert.equal(signals.openPo.current.pendingPieces, 343408);
  assert.equal(signals.openPo.current.pendingLitres, 337951.8);
  assert.equal(signals.openPo.current.poCount, 386);
  assert.equal(signals.openPo.planningMonth.pendingPieces, 216596);
  assert.equal(signals.openPo.planningMonth.poCount, 193);
  assert.equal(signals.openPo.planningMonth.mappingGapPieces, 32096);
  assert.equal(
    signals.openPo.planningMonth.planCoverage.mappedOutsidePlanPieces,
    35711,
  );
  assert.equal(
    signals.openPo.planningMonth.planCoverage.calculationBlockedPieces,
    67807,
  );
  assert.equal(
    signals.openPo.planningMonth.byScope.premium +
      signals.openPo.planningMonth.byScope.commodity +
      signals.openPo.planningMonth.byScope.other +
      signals.openPo.planningMonth.byScope.unmapped,
    signals.openPo.planningMonth.pendingPieces,
  );
  assert.equal(signals.factoryPlanning.officialForecast.augustExists, false);
  assert.equal(
    signals.factoryPlanning.officialForecast.augustProductionOrders,
    0,
  );
  assert.equal(signals.factoryPlanning.materials.blockers.length, 6);
  assert.equal(signals.factoryPlanning.batchRules.configuredMoq, false);
});
