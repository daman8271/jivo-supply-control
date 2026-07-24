import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveActiveControlActions,
  deriveControlStageStates,
  deriveControlVerdictState,
} from "../app/lib/control-loop.js";

const healthyFixture = {
  demandPieces: 100,
  targetsStatus: "Qualified",
  openPoPieces: 50,
  blockedPoPieces: 0,
  networkProjectedUnits: 500,
  missingDistributorOpenings: 0,
  criticalInventorySkus: 0,
  productionPieces: 25,
  productionStatus: "Draft",
  materialBlockerCount: 0,
  productionOrderCount: 0,
  approvalConfigured: true,
};

test("derives every control stage from the present blocked snapshot", () => {
  const stages = deriveControlStageStates({
    ...healthyFixture,
    targetsStatus: "Missing",
    blockedPoPieces: 40,
    missingDistributorOpenings: 2,
    criticalInventorySkus: 3,
    materialBlockerCount: 6,
    approvalConfigured: false,
  });

  assert.deepEqual(stages.demand, { status: "Input needed", tone: "watch" });
  assert.deepEqual(stages.platformPos, { status: "Blocked", tone: "blocked" });
  assert.deepEqual(stages.networkStock, { status: "Watch", tone: "watch" });
  assert.deepEqual(stages.production, { status: "Draft", tone: "draft" });
  assert.deepEqual(stages.materials, { status: "Blocked", tone: "blocked" });
  assert.deepEqual(stages.approvalAndDispatch, {
    status: "Manual gate",
    tone: "blocked",
  });
});

test("moves qualified evidence into ready states without UI changes", () => {
  const stages = deriveControlStageStates(healthyFixture);

  assert.deepEqual(stages.demand, { status: "Ready", tone: "healthy" });
  assert.deepEqual(stages.platformPos, { status: "Ready", tone: "healthy" });
  assert.deepEqual(stages.networkStock, { status: "Ready", tone: "healthy" });
  assert.deepEqual(stages.materials, { status: "Ready", tone: "healthy" });
  assert.deepEqual(stages.approvalAndDispatch, {
    status: "Awaiting approval",
    tone: "watch",
  });
});

test("reports approval only when explicit approval evidence exists", () => {
  const pending = deriveControlStageStates(healthyFixture);
  const approved = deriveControlStageStates({
    ...healthyFixture,
    approvalState: "approved",
  });

  assert.equal(pending.approvalAndDispatch.status, "Awaiting approval");
  assert.deepEqual(approved.approvalAndDispatch, {
    status: "Approved",
    tone: "healthy",
  });
});

test("handles a no-production plan without material or approval crashes", () => {
  const stages = deriveControlStageStates({
    ...healthyFixture,
    openPoPieces: 0,
    productionPieces: 0,
    productionStatus: "Covered",
  });

  assert.deepEqual(stages.platformPos, { status: "Clear", tone: "healthy" });
  assert.deepEqual(stages.production, { status: "Covered", tone: "healthy" });
  assert.deepEqual(stages.materials, { status: "Ready", tone: "healthy" });
  assert.deepEqual(stages.approvalAndDispatch, {
    status: "Not required",
    tone: "healthy",
  });
});

test("escalates invalid demand and negative network stock", () => {
  const stages = deriveControlStageStates({
    ...healthyFixture,
    demandPieces: 0,
    networkProjectedUnits: -1,
    productionStatus: "Blocked by identity mapping",
  });

  assert.deepEqual(stages.demand, { status: "Blocked", tone: "blocked" });
  assert.deepEqual(stages.networkStock, { status: "Blocked", tone: "blocked" });
  assert.deepEqual(stages.production, { status: "Blocked", tone: "blocked" });
});

test("missing source statuses degrade safely instead of throwing", () => {
  const stages = deriveControlStageStates({
    ...healthyFixture,
    targetsStatus: null,
    productionStatus: null,
  });

  assert.deepEqual(stages.demand, { status: "Input needed", tone: "watch" });
  assert.deepEqual(stages.production, { status: "Draft", tone: "draft" });
});

test("resolved exceptions disappear from the planner action queue", () => {
  const blocked = deriveActiveControlActions({
    blockedPoPieces: 10,
    materialBlockerCount: 2,
    missingDistributorOpenings: 1,
    criticalInventorySkus: 3,
    targetsStatus: "Missing",
  });
  const clear = deriveActiveControlActions({
    blockedPoPieces: 0,
    materialBlockerCount: 0,
    missingDistributorOpenings: 0,
    criticalInventorySkus: 0,
    targetsStatus: "Qualified",
  });

  assert.deepEqual(blocked, [
    "unblock-pos",
    "resolve-materials",
    "confirm-openings",
    "critical-inventory",
    "upload-targets",
  ]);
  assert.deepEqual(clear, []);
});

test("a blocked stage prevents a false all-clear verdict", () => {
  const verdict = deriveControlVerdictState({
    actionCount: 0,
    stages: [
      { name: "Demand", tone: "healthy" },
      { name: "Approval & dispatch", tone: "blocked" },
    ],
  });

  assert.equal(verdict.kind, "stage-blocked");
  assert.equal(verdict.blockedStage.name, "Approval & dispatch");
});
