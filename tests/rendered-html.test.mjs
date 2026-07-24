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
  assert.match(html, /SOH = BAL \+ GRN - Billing/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|taking shape/i);
});

test("seed data preserves reconciled inventory totals", async () => {
  const seed = JSON.parse(
    await readFile(new URL("../app/data/seed.json", import.meta.url), "utf8"),
  );

  assert.equal(seed.jmTotals.skus, 25);
  assert.equal(seed.jmTotals.onHand, 190934);
  assert.equal(seed.jmTotals.available, 145142);
  assert.equal(seed.jmTotals.criticalSkus, 4);
  assert.equal(seed.distributorSummary.length, 6);
  assert.equal(seed.formula.equivalent, "BAL = SOH + Billing - GRN");
});
