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

test("server-renders the Jivo inventory control tower", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Jivo Supply Control<\/title>/i);
  assert.match(html, /See every litre before it gets stuck\./);
  assert.match(html, /Distributor balance/);
  assert.match(html, /JM available/);
  assert.match(html, /Production planning/);
  assert.match(html, /SOH = BAL \+ GRN - Billing/);
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
