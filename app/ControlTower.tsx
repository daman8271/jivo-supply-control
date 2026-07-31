"use client";

import { useEffect, useMemo, useState } from "react";

import {
  deriveActiveControlActions,
  deriveControlStageStates,
  deriveControlVerdictState,
} from "./lib/control-loop";
import ReplenishmentWorkbench from "./ReplenishmentWorkbench";
import replenishmentData from "./data/distributor-replenishment.json";

type Seed = typeof import("./data/seed.json");
type ProductionPlan = typeof import("./data/production-plan.json");
type ProductionSignals = typeof import("./data/production-signals.json");
type View =
  | "control"
  | "overview"
  | "inventory"
  | "replenishment"
  | "distributors"
  | "production"
  | "readiness";
type Scope = "premium" | "all";
type ControlTone = "healthy" | "watch" | "blocked" | "draft";
type InventoryRow = {
  sapCode: string;
  itemName: string;
  shortName: string;
  city: string;
  onHand: number;
  liters: number;
  committed: number;
  available: number;
  onOrder: number;
  stockValue: number;
  status: string;
};
type InventoryTotals = {
  skus: number;
  onHand: number;
  liters: number;
  committed: number;
  available: number;
  onOrder: number;
  stockValue: number;
  criticalSkus: number;
  unmappedSkus: number;
  lowSkus?: number;
};
type LiveInventory = {
  status: "loading" | "live" | "fallback";
  observedAt: string;
  source: string;
  warehouseCode: string;
  rows: InventoryRow[];
  totals: InventoryTotals;
  error?: string;
};
type DistributorMovementTotals = {
  opening: number;
  billing: number;
  grn: number;
  projected: number;
};
type DistributorProjectionRow = {
  sapCode: string;
  itemName: string;
  itemHead: string;
  reportedOpeningPieces: number;
  usableOpeningPieces: number;
  billingPieces: number;
  grnPieces: number;
  projectedPieces: number;
  status: string;
  openingStatus: string;
};
type DistributorSkuMatrixRow = {
  sapCode: string;
  itemName: string;
  itemHead: string;
  byDistributor: Record<string, DistributorProjectionRow>;
  currentSoh: number;
  hasException: boolean;
};
type DistributorSummaryRow = Seed["distributorSummary"][number] & {
  asOf?: string;
  sourceFile?: string;
  openingExceptionSkus?: number;
  unresolvedGrnPieces?: number;
  rows?: DistributorProjectionRow[];
};
type LiveDistributors = {
  status: "loading" | "live-projection" | "fallback";
  observedAt: string;
  formula: string;
  sources: string[];
  distributors: DistributorSummaryRow[];
  totals: { all: DistributorMovementTotals; premium: DistributorMovementTotals };
  error?: string;
};

const number = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1 });

function formatValue(value: number) {
  if (value >= 10_000_000) return `₹${(value / 10_000_000).toFixed(2)} Cr`;
  if (value >= 100_000) return `₹${(value / 100_000).toFixed(1)} L`;
  return `₹${number.format(value)}`;
}

function formatObservedAt(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  }).format(parsed);
}

const requirements = [
  {
    group: "Product master",
    status: "Partial",
    have: "SAP code, item name, category, case pack, litres per unit",
    need: "MRP, standard cost, shelf life, dimensions, active/inactive dates",
  },
  {
    group: "Location master",
    status: "Partial",
    have: "Distributor, platform facility, city and state mappings",
    need: "Unique location code, ownership, capacity and service region",
  },
  {
    group: "Inventory snapshots",
    status: "Partial",
    have: "JM on-hand, committed, available and distributor SOH",
    need: "Daily as-of timestamp, batch, expiry, damaged and in-transit stock",
  },
  {
    group: "Billing movements",
    status: "Have",
    have: "Live SAP invoice movements by date, distributor, SAP SKU and pieces",
    need: "Unattended service credential and an agreed sales-return treatment",
  },
  {
    group: "GRN movements",
    status: "Partial",
    have: "Platform GRN tabs and consolidated delivered quantities",
    need: "One accepted/rejected definition and exact reporting cutoff",
  },
  {
    group: "PO & fulfilment",
    status: "Have",
    have: "PO number, dates, ordered/delivered quantity, format and location",
    need: "Cancellation reason and owner for every open exception",
  },
  {
    group: "Sales & returns",
    status: "Need",
    have: "Not supplied in the current inventory sources",
    need: "Net orders, delivered sales, returns and cancellations by SKU/city/day",
  },
  {
    group: "Commercials",
    status: "Partial",
    have: "PO rates, landing rates and JM stock value",
    need: "Platform fees, logistics, schemes, tax and settlement deductions",
  },
  {
    group: "Control settings",
    status: "Need",
    have: "Confirmed inventory equation",
    need: "Reporting start date, timezone cutoff, refresh frequency and data owners",
  },
] as const;

const nav: { id: View; label: string; short: string }[] = [
  { id: "control", label: "Control loop", short: "01" },
  { id: "overview", label: "Overview", short: "02" },
  { id: "inventory", label: "Own inventory", short: "03" },
  { id: "replenishment", label: "SKU replenishment", short: "04" },
  { id: "distributors", label: "Distributor network", short: "05" },
  { id: "production", label: "Production planning", short: "06" },
  { id: "readiness", label: "Data readiness", short: "07" },
];

export function ControlTower({
  seed,
  productionPlan,
  productionSignals,
}: {
  seed: Seed;
  productionPlan: ProductionPlan;
  productionSignals: ProductionSignals;
}) {
  const [view, setView] = useState<View>("control");
  const [scope, setScope] = useState<Scope>("premium");
  const [query, setQuery] = useState("");
  const [distributorQuery, setDistributorQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [dealReservePct, setDealReservePct] = useState(0);
  const [safetyDays, setSafetyDays] = useState(
    productionPlan.defaultAssumptions.safetyDays,
  );
  const [liveInventory, setLiveInventory] = useState<LiveInventory>({
    status: "loading",
    observedAt: seed.generatedAt,
    source: "Dated fallback snapshot",
    warehouseCode: "GP-FGM",
    rows: seed.jmInventory as InventoryRow[],
    totals: seed.jmTotals as InventoryTotals,
  });
  const [liveDistributors, setLiveDistributors] = useState<LiveDistributors>({
    status: "loading",
    observedAt: seed.generatedAt,
    formula: seed.liveReconciliation.formula,
    sources: [],
    distributors: seed.distributorSummary as DistributorSummaryRow[],
    totals: {
      all: seed.liveReconciliation.all,
      premium: seed.liveReconciliation.premium,
    },
  });

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function refreshInventory() {
      try {
        const response = await fetch("/api/live/inventory", {
          cache: "no-store",
          headers: { accept: "application/json" },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = (await response.json()) as LiveInventory;
        if (active) setLiveInventory(payload);
      } catch (error) {
        if (active) {
          setLiveInventory((current) => ({
            ...current,
            status: "fallback",
            error:
              error instanceof Error ? error.message : "Live inventory unavailable",
          }));
        }
      } finally {
        if (active) timer = setTimeout(refreshInventory, 60_000);
      }
    }

    void refreshInventory();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function refreshDistributors() {
      try {
        const response = await fetch("/api/live/distributors", {
          cache: "no-store",
          headers: { accept: "application/json" },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = (await response.json()) as LiveDistributors;
        const distributors = payload.distributors.map((row) => {
          const base = seed.distributorSummary.find((candidate) => candidate.id === row.id);
          if (!base) throw new Error(`Unknown distributor ${row.id}`);
          return { ...base, ...row, live: row.live } as DistributorSummaryRow;
        });
        if (active) setLiveDistributors({ ...payload, distributors });
      } catch (error) {
        if (active) {
          setLiveDistributors((current) => ({
            ...current,
            status: "fallback",
            error:
              error instanceof Error
                ? error.message
                : "Live distributor projection unavailable",
          }));
        }
      } finally {
        if (active) timer = setTimeout(refreshDistributors, 300_000);
      }
    }

    void refreshDistributors();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [seed.distributorSummary]);

  const inventoryRows = liveInventory.rows;
  const inventoryTotals = liveInventory.totals;
  const distributorRows = liveDistributors.distributors;
  const distributorIsLive = liveDistributors.status === "live-projection";
  const distributorExceptions = distributorRows.flatMap((distributor) =>
    (distributor.rows ?? [])
      .filter((row) => row.status === "exception")
      .map((row) => ({ ...row, distributor: distributor.name })),
  );
  const distributorSkuRows = useMemo(() => {
    const matrix = new Map<string, DistributorSkuMatrixRow>();
    for (const distributor of distributorRows) {
      for (const row of distributor.rows ?? []) {
        const existing = matrix.get(row.sapCode) ?? {
          sapCode: row.sapCode,
          itemName: row.itemName,
          itemHead: row.itemHead,
          byDistributor: {},
          currentSoh: 0,
          hasException: false,
        };
        if (existing.itemName === existing.sapCode && row.itemName !== row.sapCode) {
          existing.itemName = row.itemName;
          existing.itemHead = row.itemHead;
        }
        existing.byDistributor[distributor.id] = row;
        existing.currentSoh += Math.max(0, row.projectedPieces);
        existing.hasException ||= row.status === "exception";
        matrix.set(row.sapCode, existing);
      }
    }
    return [...matrix.values()].sort(
      (a, b) =>
        Number(b.hasException) - Number(a.hasException) ||
        b.currentSoh - a.currentSoh ||
        a.sapCode.localeCompare(b.sapCode),
    );
  }, [distributorRows]);
  const filteredDistributorSkuRows = useMemo(() => {
    const normalized = distributorQuery.trim().toLowerCase();
    if (!normalized) return distributorSkuRows;
    return distributorSkuRows.filter(
      (row) =>
        row.sapCode.toLowerCase().includes(normalized) ||
        row.itemName.toLowerCase().includes(normalized),
    );
  }, [distributorQuery, distributorSkuRows]);

  const liveTotals = liveDistributors.totals[scope];
  const augustPoByProduct = useMemo(
    () =>
      new Map(
        productionSignals.openPo.planningMonth.byProduct.map((row) => [
          row.name,
          row,
        ]),
      ),
    [productionSignals],
  );
  const augustPoFloor =
    scope === "premium"
      ? productionSignals.openPo.planningMonth.byScope.premium
      : productionSignals.openPo.planningMonth.pendingPieces;
  const maxAugustPlatformPo = Math.max(
    ...productionSignals.openPo.planningMonth.byPlatform.map(
      (row) => row.pendingPieces,
    ),
    1,
  );

  const adjustedProductionRows = useMemo(
    () =>
      productionPlan.rows
        .filter(
          (row) =>
            scope === "all" || row.itemHead.toUpperCase() === "PREMIUM",
        )
        .map((row) => {
          const poFloorPieces =
            augustPoByProduct.get(row.name)?.pendingPieces ?? 0;
          const dealReservePieces = Math.max(
            0,
            Math.round(row.baseForecastPieces * (dealReservePct / 100)),
          );
          const forecastPieces = Math.max(
            row.baseForecastPieces + dealReservePieces,
            poFloorPieces,
          );
          const safetyPieces = Math.ceil(
            (forecastPieces / productionPlan.defaultAssumptions.monthDays) *
              safetyDays,
          );
          const netRequirement = Math.max(
            0,
            forecastPieces +
              safetyPieces -
              row.networkAvailable -
              row.onOrder,
          );
          const productionPieces =
            Math.ceil(netRequirement / row.casePack) * row.casePack;
          const daysOfCover =
            forecastPieces > 0
              ? (Math.max(0, row.networkAvailable) /
                  forecastPieces) *
                productionPlan.defaultAssumptions.monthDays
              : null;
          return {
            ...row,
            poFloorPieces,
            dealReservePieces,
            forecastPieces,
            safetyPieces,
            productionPieces,
            productionCases: productionPieces / row.casePack,
            daysOfCover:
              daysOfCover === null ? null : Number(daysOfCover.toFixed(1)),
            priority:
              productionPieces === 0
                ? "Covered"
                : daysOfCover !== null && daysOfCover < safetyDays
                  ? "Critical"
                  : "Plan",
          };
        })
        .sort(
          (first, second) =>
            second.productionPieces - first.productionPieces ||
            second.forecastPieces - first.forecastPieces,
        ),
    [
      augustPoByProduct,
      dealReservePct,
      productionPlan,
      safetyDays,
      scope,
    ],
  );

  const adjustedProductionTotals = useMemo(
    () =>
      adjustedProductionRows.reduce(
        (totals, row) => {
          totals.baseForecastPieces += row.baseForecastPieces;
          totals.poFloorPieces += row.poFloorPieces;
          totals.dealReservePieces += row.dealReservePieces;
          totals.forecastPieces += row.forecastPieces;
          totals.productionPieces += row.productionPieces;
          totals.productionCases += row.productionCases;
          if (row.priority === "Critical") totals.criticalSkus += 1;
          return totals;
        },
        {
          baseForecastPieces: 0,
          poFloorPieces: 0,
          dealReservePieces: 0,
          forecastPieces: 0,
          productionPieces: 0,
          productionCases: 0,
          criticalSkus: 0,
        },
      ),
    [adjustedProductionRows],
  );

  const filteredInventory = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return inventoryRows.filter((row) => {
      const matchesQuery =
        !normalized ||
        row.sapCode.toLowerCase().includes(normalized) ||
        row.itemName.toLowerCase().includes(normalized);
      const matchesStatus = statusFilter === "All" || row.status === statusFilter;
      return matchesQuery && matchesStatus;
    });
  }, [query, inventoryRows, statusFilter]);

  const maxDistributorBalance = Math.max(
    ...distributorRows.map((row) =>
      Math.max(0, row.live[scope].projected),
    ),
    1,
  );
  const missingDistributorOpenings = distributorRows.filter(
    (row) => row.openingMissing,
  ).length;
  const materialBlockers = productionSignals.factoryPlanning.materials.blockers;
  const controlStageStates = deriveControlStageStates({
    demandPieces: productionPlan.totals.forecastPieces,
    targetsStatus: productionSignals.targets.status,
    openPoPieces: productionSignals.openPo.planningMonth.pendingPieces,
    blockedPoPieces:
      productionSignals.openPo.planningMonth.planCoverage.calculationBlockedPieces,
    networkProjectedUnits: liveDistributors.totals.all.projected,
    missingDistributorOpenings,
    criticalInventorySkus: inventoryTotals.criticalSkus,
    productionPieces: productionPlan.totals.productionPieces,
    productionStatus: productionPlan.status,
    materialBlockerCount: materialBlockers.length,
    productionOrderCount:
      productionSignals.factoryPlanning.officialForecast.augustProductionOrders,
    approvalConfigured:
      productionSignals.factoryPlanning.approvals.sapApprovalConfigured,
    approvalState: null,
  });
  const activeControlActionIds = deriveActiveControlActions({
    blockedPoPieces:
      productionSignals.openPo.planningMonth.planCoverage.calculationBlockedPieces,
    materialBlockerCount: materialBlockers.length,
    missingDistributorOpenings,
    criticalInventorySkus: inventoryTotals.criticalSkus,
    targetsStatus: productionSignals.targets.status,
  });
  const controlStages: {
    name: string;
    status: string;
    tone: ControlTone;
    signal: string;
    detail: string;
    target: View;
  }[] = [
    {
      name: "Demand",
      status: controlStageStates.demand.status,
      tone: controlStageStates.demand.tone as ControlTone,
      signal: `${number.format(productionPlan.totals.forecastPieces)} draft demand pieces`,
      detail: `${productionSignals.planningMonth} targets ${productionSignals.targets.status.toLowerCase()}`,
      target: "production",
    },
    {
      name: "Platform POs",
      status: controlStageStates.platformPos.status,
      tone: controlStageStates.platformPos.tone as ControlTone,
      signal: `${number.format(productionSignals.openPo.planningMonth.pendingPieces)} open pieces`,
      detail: `${number.format(productionSignals.openPo.planningMonth.poCount)} POs · ${number.format(productionSignals.openPo.planningMonth.planCoverage.calculationBlockedPieces)} pieces blocked`,
      target: "production",
    },
    {
      name: "Network stock",
      status: controlStageStates.networkStock.status,
      tone: controlStageStates.networkStock.tone as ControlTone,
      signal: `${number.format(liveDistributors.totals.all.projected)} projected units`,
      detail: `${number.format(inventoryTotals.available)} JM available · ${missingDistributorOpenings} missing openings · ${inventoryTotals.criticalSkus} critical JM SKUs`,
      target: "replenishment",
    },
    {
      name: "Production",
      status: controlStageStates.production.status,
      tone: controlStageStates.production.tone as ControlTone,
      signal: `${number.format(productionPlan.totals.productionPieces)} draft pieces`,
      detail: `${number.format(productionPlan.totals.productionCases)} cases · ${productionSignals.factoryPlanning.officialForecast.augustProductionOrders} August production orders`,
      target: "production",
    },
    {
      name: "Materials",
      status: controlStageStates.materials.status,
      tone: controlStageStates.materials.tone as ControlTone,
      signal:
        materialBlockers.length > 0
          ? `${materialBlockers.length} residual blockers`
          : "No residual blockers",
      detail:
        materialBlockers.length > 0
          ? `${materialBlockers[0].name} leads at ${number.format(materialBlockers[0].shortage)} ${materialBlockers[0].uom}`
          : "Current material feasibility check has no unresolved shortage",
      target: "production",
    },
    {
      name: "Approval & dispatch",
      status: controlStageStates.approvalAndDispatch.status,
      tone: controlStageStates.approvalAndDispatch.tone as ControlTone,
      signal: `${productionSignals.factoryPlanning.officialForecast.augustProductionOrders} August production orders`,
      detail: productionSignals.factoryPlanning.approvals.note,
      target: "readiness",
    },
  ];
  const allControlActions: {
    id: string;
    title: string;
    owner: string;
    consequence: string;
    target: View;
  }[] = [
    {
      id: "unblock-pos",
      title: `Unblock ${number.format(productionSignals.openPo.planningMonth.planCoverage.calculationBlockedPieces)} PO pieces`,
      owner: "Demand planning + e-commerce ops",
      consequence: "Committed platform demand is excluded from the production calculation.",
      target: "production",
    },
    {
      id: "resolve-materials",
      title: `Resolve ${materialBlockers.length} material blockers`,
      owner: "Procurement + factory planning",
      consequence: "The draft production requirement cannot be released as planned.",
      target: "production",
    },
    {
      id: "confirm-openings",
      title: `Confirm ${missingDistributorOpenings} missing distributor openings`,
      owner: "Distributor operations",
      consequence: "Network coverage and replenishment decisions remain unreliable.",
      target: "replenishment",
    },
    {
      id: "critical-inventory",
      title: `Address ${inventoryTotals.criticalSkus} critical JM SKUs`,
      owner: "Inventory planning",
      consequence: "Low or negative availability can put platform PO fulfilment at risk.",
      target: "inventory",
    },
    {
      id: "upload-targets",
      title: "Upload August targets",
      owner: "Commercial planning",
      consequence: "The draft has no official primary or secondary demand benchmark.",
      target: "production",
    },
  ];
  const controlActions = allControlActions.filter((action) =>
    activeControlActionIds.includes(action.id),
  );
  const nextControlAction = controlActions[0];
  const controlVerdict = deriveControlVerdictState({
    actionCount: controlActions.length,
    stages: controlStages,
  });
  const blockedControlStage = controlVerdict.blockedStage
    ? controlStages.find(
        (stage) => stage.name === controlVerdict.blockedStage?.name,
      )
    : undefined;

  function downloadProductionCsv() {
    const headings = [
      "ForecastCode",
      "ForecastName",
      "View",
      "ItemNo",
      "Quantity",
      "Warehouse",
      "ForecastedDay",
    ];
    const rows = adjustedProductionRows
      .filter((row) => row.productionPieces > 0 && row.sapCode)
      .map((row) => [
        "AUGUST 2026",
        "OIL Monthly Production Planning for the AUGUST Month 2026",
        "Monthly",
        row.sapCode ?? "",
        row.productionPieces,
        "GP-FG",
        "2026-08-01",
      ]);
    const csv = [headings, ...rows]
      .map((row) =>
        row
          .map((value) => `"${String(value).replaceAll('"', '""')}"`)
          .join(","),
      )
      .join("\n");
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `Jivo-Oil-SalesForecast-${productionPlan.planningMonth.replaceAll(" ", "-")}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            JS
          </div>
          <div>
            <strong>Jivo Supply</strong>
            <span>Control tower</span>
          </div>
        </div>

        <nav className="primary-nav" aria-label="Primary navigation">
          <p className="nav-label">Workspace</p>
          {nav.map((item) => (
            <button
              className={view === item.id ? "nav-item active" : "nav-item"}
              key={item.id}
              onClick={() => setView(item.id)}
              type="button"
            >
              <span>{item.short}</span>
              {item.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-status">
          <span className="live-dot" />
          <div>
            <strong>Read-only v0.1</strong>
            <span>No operational write-backs</span>
          </div>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="topbar-date">
            <span>
              {view === "inventory"
                ? liveInventory.status === "live"
                  ? "Live inventory"
                  : "Inventory fallback"
                : view === "distributors"
                  ? liveDistributors.status === "live-projection"
                    ? "Live distributor projection"
                    : "Distributor fallback"
                  : view === "replenishment"
                    ? "Planning cutoff"
                    : "Snapshot"}
            </span>
            <strong>
              {view === "inventory"
                ? formatObservedAt(liveInventory.observedAt)
                : view === "distributors"
                  ? formatObservedAt(liveDistributors.observedAt)
                  : view === "replenishment"
                    ? "24 July 2026 · 17:28 IST"
                    : "24 July 2026 · 15:30 IST"}
            </strong>
          </div>
          <div className="topbar-actions">
            <span className="source-count">
              {view === "inventory"
                ? 1
                : view === "distributors"
                  ? liveDistributors.sources.length
                  : view === "replenishment"
                    ? replenishmentData.sources.length
                    : seed.sourceStatus.length}{" "}
              sources
            </span>
            <button
              type="button"
              onClick={() => {
                if (view === "replenishment") {
                  document
                    .getElementById("replenishment-sources-title")
                    ?.scrollIntoView({ behavior: "smooth", block: "start" });
                  return;
                }
                setView("readiness");
              }}
            >
              {view === "replenishment" ? "Source evidence" : "Data checklist"}
            </button>
          </div>
        </header>

        {view === "control" && (
          <div className="page control-page">
            <section className="control-hero" aria-labelledby="control-title">
              <div>
                <span className="eyebrow">End-to-end command view</span>
                <h1 id="control-title">Control the chain, not just the stock.</h1>
                <p>
                  {nextControlAction
                    ? `The current snapshot has ${controlActions.length} unresolved chain ${controlActions.length === 1 ? "action" : "actions"}. Start with the first priority below, then follow the impact downstream.`
                    : blockedControlStage
                      ? `${blockedControlStage.name} remains blocked even though no planner action is currently queued. Review the stage evidence before treating the chain as clear.`
                      : "Every qualified signal in the current snapshot is clear. Continue monitoring source freshness and review new exceptions as they arrive."}
                </p>
              </div>
              <div className="control-verdict" aria-label="Current chain verdict">
                <span>{nextControlAction ? "Next action" : "Chain status"}</span>
                <strong>
                  {nextControlAction?.title ??
                    (blockedControlStage
                      ? `Review ${blockedControlStage.name}`
                      : "No blocking action")}
                </strong>
                <button
                  type="button"
                  onClick={() =>
                    setView(
                      nextControlAction?.target ??
                        blockedControlStage?.target ??
                        "overview",
                    )
                  }
                >
                  {nextControlAction || blockedControlStage
                    ? "Open detail"
                    : "Review overview"}{" "}
                  <span aria-hidden="true">→</span>
                </button>
              </div>
            </section>

            <section className="control-summary" aria-label="Supply chain summary">
              <article className="control-summary-card visible">
                <span>Qualified network signal</span>
                <strong>
                  {number.format(liveDistributors.totals.all.projected)} projected
                  network units
                </strong>
                <p>
                  Calculated from reported JM and distributor positions;{" "}
                  {missingDistributorOpenings} openings remain unconfirmed.
                </p>
              </article>
              <article
                className={`control-summary-card ${productionSignals.openPo.planningMonth.planCoverage.calculationBlockedPieces > 0 ? "blocked" : "visible"}`}
              >
                <span>
                  {productionSignals.openPo.planningMonth.planCoverage
                    .calculationBlockedPieces > 0
                    ? "Blocked now"
                    : "PO demand mapped"}
                </span>
                <strong>
                  {number.format(
                    productionSignals.openPo.planningMonth.planCoverage
                      .calculationBlockedPieces > 0
                      ? productionSignals.openPo.planningMonth.planCoverage
                          .calculationBlockedPieces
                      : productionSignals.openPo.planningMonth.pendingPieces,
                  )}{" "}
                  {productionSignals.openPo.planningMonth.planCoverage
                    .calculationBlockedPieces > 0
                    ? "PO pieces blocked"
                    : "open PO pieces"}
                </strong>
                <p>
                  {productionSignals.openPo.planningMonth.planCoverage
                    .calculationBlockedPieces > 0
                    ? "Unmapped demand and missing plan rows understate the draft."
                    : "Every open PO line is represented in the current demand calculation."}
                </p>
              </article>
              <article
                className={`control-summary-card ${
                  materialBlockers.length > 0
                    ? "watch"
                    : controlStageStates.approvalAndDispatch.tone === "healthy"
                      ? "visible"
                      : controlStageStates.approvalAndDispatch.tone
                }`}
              >
                <span>Release gate</span>
                <strong>
                  {materialBlockers.length > 0
                    ? `${materialBlockers.length} material shortages`
                    : controlStageStates.approvalAndDispatch.status}
                </strong>
                <p>
                  {materialBlockers.length > 0
                    ? "Material feasibility must clear before planner approval."
                    : controlStageStates.approvalAndDispatch.status === "Approved"
                      ? "Explicit planner approval evidence is recorded."
                      : controlStageStates.approvalAndDispatch.status ===
                          "Awaiting approval"
                        ? "Approval is configured, but approval evidence is not yet recorded."
                        : productionSignals.factoryPlanning.approvals.note}
                </p>
              </article>
            </section>

            <section className="control-flow-section" aria-labelledby="flow-title">
              <header className="control-section-heading">
                <div>
                  <span className="eyebrow">Chain health</span>
                  <h2 id="flow-title">Demand to dispatch</h2>
                </div>
                <small>Every signal from the 24 July 2026 snapshot</small>
              </header>
              <ol className="stage-flow">
                {controlStages.map((stage, index) => (
                  <li className={`stage-card ${stage.tone}`} key={stage.name}>
                    <button
                      onClick={() => setView(stage.target)}
                      type="button"
                    >
                      <span className="stage-index">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span className="stage-status">{stage.status}</span>
                      <strong>{stage.name}</strong>
                      <b>{stage.signal}</b>
                      <small>{stage.detail}</small>
                      <span className="stage-link">
                        View detail <span aria-hidden="true">→</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </section>

            <section className="control-action-panel panel" aria-labelledby="queue-title">
              <header className="control-section-heading">
                <div>
                  <span className="eyebrow">Do next</span>
                  <h2 id="queue-title">Prioritized action queue</h2>
                </div>
                <small>{controlActions.length} planner-owned actions</small>
              </header>
              <ol className="control-action-list">
                {controlActions.length === 0 && (
                  <li className="control-action-empty">
                    No unresolved planner-owned actions in this snapshot.
                  </li>
                )}
                {controlActions.map((action, index) => (
                  <li key={action.id}>
                    <button onClick={() => setView(action.target)} type="button">
                      <span className="action-rank">
                        P{String(index + 1).padStart(2, "0")}
                      </span>
                      <span className="action-copy">
                        <strong>{action.title}</strong>
                        <small>
                          <b>Owner</b> {action.owner}
                        </small>
                      </span>
                      <span className="action-consequence">
                        <b>Downstream consequence</b>
                        <small>{action.consequence}</small>
                      </span>
                      <span className="action-open" aria-hidden="true">
                        →
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </section>

            <aside className="control-provenance" aria-label="Operating rule">
              <strong>Operating rule</strong>
              <p>
                Source systems remain read-only. Calculations use the dated
                snapshot from 24 July 2026, and recommended actions stay inside
                the planner until approved.
              </p>
            </aside>
          </div>
        )}

        {view === "overview" && (
          <div className="page overview-page">
            <section className="hero-row">
              <div>
                <span className="eyebrow">Operations snapshot</span>
                <h1>See every litre before it gets stuck.</h1>
                <p>
                  One working view of JM stock, distributor positions and the
                  exceptions that need attention first.
                </p>
              </div>
              <div className="scope-control" aria-label="Inventory scope">
                <button
                  className={scope === "premium" ? "selected" : ""}
                  onClick={() => setScope("premium")}
                  type="button"
                >
                  Premium oil
                </button>
                <button
                  className={scope === "all" ? "selected" : ""}
                  onClick={() => setScope("all")}
                  type="button"
                >
                  All products
                </button>
              </div>
            </section>

            <section className="kpi-grid" aria-label="Key inventory metrics">
              <Metric
                label="JM available"
                value={number.format(inventoryTotals.available)}
                note={`${decimal.format(inventoryTotals.liters)} estimated litres on hand`}
                tone="green"
              />
              <Metric
                label="Projected distributor stock"
                value={number.format(liveTotals.projected)}
                note={`${number.format(liveTotals.opening)} opening · live through 24 Jul`}
                tone={liveTotals.projected < 0 ? "red" : "cream"}
              />
              <Metric
                label="JM committed"
                value={number.format(inventoryTotals.committed)}
                note={`${number.format(inventoryTotals.onOrder)} units currently on order`}
                tone="cream"
              />
              <Metric
                label="Open exceptions"
                value={number.format(
                  inventoryTotals.criticalSkus + distributorExceptions.length,
                )}
                note={`${inventoryTotals.criticalSkus} JM critical · ${distributorExceptions.length} distributor`}
                tone="amber"
              />
            </section>

            <section className="overview-grid">
              <article className="panel distributor-panel">
                <PanelHeading
                  eyebrow="Network position"
                  title="Distributor balance"
                  action={`${scope === "premium" ? "Premium" : "All"} · units`}
                />
                <div className="distributor-bars">
                  {distributorRows.map((distributor) => {
                    const value = distributor.live[scope].projected;
                    const width = `${Math.max(
                      3,
                      (Math.max(0, value) / maxDistributorBalance) * 100,
                    )}%`;
                    return (
                      <button
                        className="distributor-row"
                        key={distributor.id}
                        onClick={() => setView("distributors")}
                        type="button"
                      >
                        <span className="distributor-name">
                          <strong>{distributor.name}</strong>
                          <small>{distributor.city}</small>
                        </span>
                        <span className="bar-track">
                          <span
                            className={value < 0 ? "bar negative" : "bar"}
                            style={{ width }}
                          />
                        </span>
                        <strong className={value < 0 ? "negative-text" : ""}>
                          {number.format(value)}
                        </strong>
                      </button>
                    );
                  })}
                </div>
                <div className="formula-note">
                  <span>Measured baseline + live movements</span>
                  <strong>{liveDistributors.formula}</strong>
                </div>
              </article>

              <article className="panel priority-panel">
                <PanelHeading
                  eyebrow="Priority queue"
                  title="Act on these first"
                  action="JM inventory"
                />
                <div className="priority-list">
                  {inventoryRows
                    .filter((row) => row.available < 0)
                    .sort((a, b) => a.available - b.available)
                    .map((row, index) => (
                      <button
                        className="priority-item"
                        key={row.sapCode}
                        onClick={() => {
                          setQuery(row.sapCode);
                          setStatusFilter("Critical");
                          setView("inventory");
                        }}
                        type="button"
                      >
                        <span className="priority-rank">0{index + 1}</span>
                        <span>
                          <strong>{row.shortName}</strong>
                          <small>{row.sapCode}</small>
                        </span>
                        <span className="priority-value">
                          {number.format(row.available)}
                          <small>available</small>
                        </span>
                      </button>
                    ))}
                </div>
              </article>
            </section>

            <section className="panel source-panel">
              <PanelHeading
                eyebrow="Data pipeline"
                title="Source readiness"
                action="First release"
              />
              <div className="source-grid">
                {seed.sourceStatus.map((source, index) => (
                  <div className="source-card" key={source.id}>
                    <span className="source-index">0{index + 1}</span>
                    <div>
                      <strong>{source.name}</strong>
                      <p>{source.detail}</p>
                    </div>
                    <span
                      className={
                        source.state === "Mapped"
                          ? "status-pill partial"
                          : "status-pill have"
                      }
                    >
                      {source.state}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}

        {view === "inventory" && (
          <div className="page">
            <PageHeading
              eyebrow="JM own inventory"
              title="Available-to-promise stock"
              description="Live GP-FGM warehouse position from the Ecom SAP feed, with committed quantities separated from physical on-hand stock."
            />
            <section className="formula-banner" aria-label="Inventory source status">
              <span>
                {liveInventory.status === "live"
                  ? "LIVE · auto-refreshes every 60 seconds"
                  : liveInventory.status === "loading"
                    ? "CONNECTING TO LIVE SOURCE"
                    : "DATED FALLBACK · LIVE SOURCE UNAVAILABLE"}
              </span>
              <strong>
                {liveInventory.warehouseCode} · {liveInventory.source}
              </strong>
              <small>
                Captured {formatObservedAt(liveInventory.observedAt)}
                {liveInventory.error ? ` · ${liveInventory.error}` : ""}. Source access is read-only.
              </small>
            </section>
            <section className="compact-kpis">
              <CompactMetric label="On hand" value={number.format(inventoryTotals.onHand)} />
              <CompactMetric
                label="Available"
                value={number.format(inventoryTotals.available)}
              />
              <CompactMetric
                label="On order"
                value={number.format(inventoryTotals.onOrder)}
              />
              <CompactMetric
                label="Stock value"
                value={formatValue(inventoryTotals.stockValue)}
              />
            </section>
            <section className="panel table-panel">
              <div className="table-tools">
                <label>
                  <span className="sr-only">Search inventory</span>
                  <input
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search SAP code or product"
                    type="search"
                    value={query}
                  />
                </label>
                <label>
                  <span className="sr-only">Filter inventory status</span>
                  <select
                    onChange={(event) => setStatusFilter(event.target.value)}
                    value={statusFilter}
                  >
                    <option>All</option>
                    <option>Critical</option>
                    <option>Low</option>
                    <option>Healthy</option>
                  </select>
                </label>
                <span>{filteredInventory.length} SKUs</span>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>SKU</th>
                      <th>Product</th>
                      <th>On hand</th>
                      <th>Committed</th>
                      <th>Available</th>
                      <th>On order</th>
                      <th>Value</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredInventory.map((row) => (
                      <tr key={row.sapCode}>
                        <td className="mono">{row.sapCode}</td>
                        <td>
                          <strong>{row.shortName}</strong>
                          <small>{row.city}</small>
                        </td>
                        <td>{number.format(row.onHand)}</td>
                        <td>{number.format(row.committed)}</td>
                        <td className={row.available < 0 ? "negative-text" : ""}>
                          {number.format(row.available)}
                        </td>
                        <td>{number.format(row.onOrder)}</td>
                        <td>{formatValue(row.stockValue)}</td>
                        <td>
                          <span
                            className={`inventory-status ${row.status.toLowerCase().replaceAll(" ", "-")}`}
                          >
                            {row.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}

        {view === "replenishment" && (
          <ReplenishmentWorkbench
            liveDistributors={liveDistributors}
            liveInventory={liveInventory}
          />
        )}

        {view === "distributors" && (
          <div className="page">
            <PageHeading
              eyebrow="Distributor network"
              title="Live stock projection"
              description="Qualified physical counts from 28–30 July carried forward with live SAP billing and mapped platform-accepted quantities."
            />
            <section className="formula-banner">
              <span>Measured baseline + live movements</span>
              <strong>{liveDistributors.formula}</strong>
              <small>
                Physical openings are dated per distributor; SAP billing and mapped platform GRN movements refresh every five minutes.
              </small>
            </section>
            <section className="distributor-card-grid">
              {distributorRows.map((distributor) => (
                <article className="network-card" key={distributor.id}>
                  <div className="network-card-head">
                    <div>
                      <strong>{distributor.name}</strong>
                      <span>{distributor.city}</span>
                    </div>
                    <span
                      className={
                        liveDistributors.status === "live-projection"
                          ? "status-pill have"
                          : "status-pill need"
                      }
                    >
                      {liveDistributors.status === "live-projection"
                        ? "Live projected"
                        : "Fallback"}
                    </span>
                  </div>
                  <div className="network-metrics">
                    <span>
                      <small>{distributor.asOf ? `${distributor.asOf} qualified opening` : "Qualified opening"}</small>
                      <strong>{number.format(distributor.live.all.opening)}</strong>
                    </span>
                    <span>
                      <small>SAP billing</small>
                      <strong>{number.format(distributor.live.all.billing)}</strong>
                    </span>
                    <span>
                      <small>Platform GRN</small>
                      <strong>{number.format(distributor.live.all.grn)}</strong>
                    </span>
                    <span>
                      <small>Now projected</small>
                      <strong
                        className={
                          distributor.live.all.projected < 0 ? "negative-text" : ""
                        }
                      >
                        {number.format(distributor.live.all.projected)}
                      </strong>
                    </span>
                  </div>
                  <p>
                    {distributor.activeSkuCount} active SKUs ·{" "}
                    {distributor.negativeSkuCount} negative balances
                  </p>
                </article>
              ))}
            </section>
            <section className="panel table-panel" aria-labelledby="distributor-sku-soh-title">
              <PanelHeading
                eyebrow={distributorIsLive ? "Live distributor SOH" : "Stale distributor SOH"}
                title="Current stock by SKU and distributor"
                action={`${filteredDistributorSkuRows.length} SKUs`}
              />
              <div className="table-tools">
                <input
                  aria-label="Search distributor SKU stock"
                  onChange={(event) => setDistributorQuery(event.target.value)}
                  placeholder="Search SAP code or SKU name"
                  type="search"
                  value={distributorQuery}
                />
                <span>
                  {distributorIsLive
                    ? `Live usable SOH in pieces · refreshed ${formatObservedAt(liveDistributors.observedAt)}`
                    : `STALE — live source unavailable · last successful ${formatObservedAt(liveDistributors.observedAt)}`}
                </span>
              </div>
              <div className="table-scroll">
                <table aria-label="Current distributor stock by SKU">
                  <thead>
                    <tr>
                      <th id="distributor-sku-soh-title">SKU</th>
                      <th>Scope</th>
                      {distributorRows.map((distributor) => (
                        <th key={distributor.id}>{distributor.name} SOH</th>
                      ))}
                      <th>Network SOH</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredDistributorSkuRows.map((row) => (
                      <tr key={row.sapCode}>
                        <td>
                          <strong title={row.itemName}>{row.itemName}</strong>
                          <small className="mono">{row.sapCode}</small>
                        </td>
                        <td>{row.itemHead}</td>
                        {distributorRows.map((distributor) => {
                          const position = row.byDistributor[distributor.id];
                          const usableSoh = Math.max(0, position?.projectedPieces ?? 0);
                          return (
                            <td key={distributor.id}>
                              <strong>{number.format(usableSoh)}</strong>
                              <small>
                                {position
                                  ? `O ${number.format(position.usableOpeningPieces)} + B ${number.format(position.billingPieces)} − G ${number.format(position.grnPieces)}`
                                  : "Complete report · zero"}
                              </small>
                              {position && position.projectedPieces < 0 && (
                                <small className="negative-text">
                                  Projection {number.format(position.projectedPieces)}
                                </small>
                              )}
                            </td>
                          );
                        })}
                        <td>
                          <strong>{number.format(row.currentSoh)}</strong>
                        </td>
                        <td>
                          <span
                            className={
                              !distributorIsLive || row.hasException
                                ? "status-pill need"
                                : "status-pill have"
                            }
                          >
                            {!distributorIsLive
                              ? "Stale"
                              : row.hasException
                                ? "Exception"
                                : "Qualified"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="panel table-panel">
              <PanelHeading
                eyebrow="Projection exceptions"
                title="Negative opening or projected balances"
                action={`${distributorExceptions.length} rows`}
              />
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Distributor</th>
                      <th>SKU</th>
                      <th>Scope</th>
                      <th>SOH</th>
                      <th>Billing</th>
                      <th>GRN</th>
                      <th>BAL</th>
                      <th>Issue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {distributorExceptions.map((row, index) => (
                      <tr key={`${row.distributor}-${row.sapCode}-${index}`}>
                        <td>{row.distributor}</td>
                        <td>
                          <strong>{row.itemName}</strong>
                          <small className="mono">{row.sapCode}</small>
                        </td>
                        <td>{row.itemHead}</td>
                        <td>{number.format(row.usableOpeningPieces)}</td>
                        <td>{number.format(row.billingPieces)}</td>
                        <td>{number.format(row.grnPieces)}</td>
                        <td className="negative-text">{number.format(row.projectedPieces)}</td>
                        <td>
                          <span className="status-pill need">
                            {row.projectedPieces < 0 ? "Projected below zero" : row.openingStatus}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}

        {view === "production" && (
          <div className="page production-page">
            <PageHeading
              eyebrow="Factory planning"
              title={`${productionPlan.planningMonth} production draft`}
              description="A working e-commerce plan that separates baseline demand, committed platform POs and an explicit reserve for deals that are not confirmed yet."
            />

            <section className="production-command">
              <div>
                <span className="status-pill partial">{productionPlan.status}</span>
                <strong>Scenario controls</strong>
                <p>
                  Committed August POs set a minimum demand floor. Add a deal
                  reserve only when commercial discussions justify it; the
                  result stays rounded to factory case packs.
                </p>
              </div>
              <div className="production-actions">
                <div className="scope-control" aria-label="Production scope">
                  <button
                    className={scope === "premium" ? "selected" : ""}
                    onClick={() => setScope("premium")}
                    type="button"
                  >
                    Premium only
                  </button>
                  <button
                    className={scope === "all" ? "selected" : ""}
                    onClick={() => setScope("all")}
                    type="button"
                  >
                    All e-commerce
                  </button>
                </div>
                <button
                  className="export-button"
                  onClick={downloadProductionCsv}
                  type="button"
                >
                  Export SAP forecast
                </button>
              </div>
            </section>

            <section className="planning-controls">
              <label>
                <span>
                  Unconfirmed deal reserve
                  <strong>+{dealReservePct}%</strong>
                </span>
                <input
                  aria-label="Unconfirmed deal reserve percentage"
                  max="50"
                  min="0"
                  onChange={(event) =>
                    setDealReservePct(Number(event.target.value))
                  }
                  step="5"
                  type="range"
                  value={dealReservePct}
                />
                <small>
                  A visible assumption for deals that may create extra POs; 0%
                  means no unconfirmed deal volume.
                </small>
              </label>
              <label>
                <span>
                  Safety stock
                  <strong>{safetyDays} days</strong>
                </span>
                <input
                  aria-label="Safety stock days"
                  max="15"
                  min="0"
                  onChange={(event) => setSafetyDays(Number(event.target.value))}
                  step="1"
                  type="range"
                  value={safetyDays}
                />
                <small>Extra cover held after the selected August plan demand.</small>
              </label>
              <div className="planning-method">
                <span>Demand selection rule</span>
                <strong>Higher of base or committed POs</strong>
                <small>
                  Base: 50% July run-rate · 30% June · 20% May
                </small>
              </div>
            </section>

            <section className="signal-stack" aria-label="Planning signal status">
              <article>
                <div>
                  <span>01 · Baseline</span>
                  <strong>Historical demand</strong>
                </div>
                <span className="status-pill have">Ready</span>
                <p>May–July e-commerce movement, weighted toward July.</p>
              </article>
              <article>
                <div>
                  <span>02 · Committed</span>
                  <strong>Platform POs</strong>
                </div>
                <span className="status-pill have">Live</span>
                <p>
                  {number.format(
                    productionSignals.openPo.planningMonth.pendingPieces,
                  )}{" "}
                  pieces across{" "}
                  {number.format(productionSignals.openPo.planningMonth.poCount)}{" "}
                  POs expiring in August.
                </p>
              </article>
              <article>
                <div>
                  <span>03 · Uncertain</span>
                  <strong>Deal pipeline</strong>
                </div>
                <span className="status-pill need">Volumes missing</span>
                <p>
                  Promotion activity is visible, but August deal probability
                  and expected PO quantity are not recorded.
                </p>
              </article>
              <article>
                <div>
                  <span>04 · Feasibility</span>
                  <strong>Factory + materials</strong>
                </div>
                <span className="status-pill partial">SAP checked</span>
                <p>
                  Capacity looks non-binding at the current draft, but{" "}
                  {productionSignals.factoryPlanning.materials.blockers.length}{" "}
                  material blockers and factory execution assumptions still
                  need confirmation.
                </p>
              </article>
            </section>

            <section className="kpi-grid" aria-label="Production plan metrics">
              <Metric
                label="August plan demand"
                value={number.format(adjustedProductionTotals.forecastPieces)}
                note={`${scope === "premium" ? "Premium products" : "All e-commerce"} · ${dealReservePct}% deal reserve`}
                tone="cream"
              />
              <Metric
                label="Committed PO floor"
                value={number.format(augustPoFloor)}
                note="Open balance on POs expiring in August"
                tone="cream"
              />
              <Metric
                label="Suggested production"
                value={number.format(adjustedProductionTotals.productionPieces)}
                note={`${number.format(adjustedProductionTotals.productionCases)} cases · ${number.format(adjustedProductionTotals.criticalSkus)} critical products`}
                tone="green"
              />
              <Metric
                label="PO calculation blocked"
                value={number.format(
                  productionSignals.openPo.planningMonth.planCoverage
                    .calculationBlockedPieces,
                )}
                note="Needs either a product mapping or a stock/forecast row"
                tone="red"
              />
            </section>

            <section className="formula-banner production-formula">
              <span>Planning equation</span>
              <strong>
                Production = max(base + deal reserve, August POs) + safety −
                network stock − JM on order
              </strong>
              <small>
                POs are a floor, not added twice to the baseline. Rounded to
                case pack; no factory order is sent.
              </small>
            </section>

            <section className="panel table-panel production-table">
              <PanelHeading
                eyebrow="Factory submission lines"
                title={`${scope === "premium" ? "Premium" : "All"} requirement`}
                action={`${productionPlan.planningMonth} · Draft`}
              />
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Base</th>
                      <th>Aug PO floor</th>
                      <th>Plan demand</th>
                      <th>Network stock</th>
                      <th>On order</th>
                      <th>Safety</th>
                      <th>Make</th>
                      <th>Cases</th>
                      <th>Cover</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {adjustedProductionRows.map((row) => (
                      <tr key={row.name}>
                        <td>
                          <strong>{row.name}</strong>
                          <small className="mono">
                            {row.sapCode ?? "Mapping needed"} · {row.casePack}/case
                          </small>
                        </td>
                        <td>{number.format(row.baseForecastPieces)}</td>
                        <td>
                          {row.poFloorPieces > 0
                            ? number.format(row.poFloorPieces)
                            : "—"}
                        </td>
                        <td>{number.format(row.forecastPieces)}</td>
                        <td
                          className={
                            row.networkAvailable < 0 ? "negative-text" : ""
                          }
                        >
                          {number.format(row.networkAvailable)}
                        </td>
                        <td>{number.format(row.onOrder)}</td>
                        <td>{number.format(row.safetyPieces)}</td>
                        <td>
                          <strong>{number.format(row.productionPieces)}</strong>
                        </td>
                        <td>{number.format(row.productionCases)}</td>
                        <td>
                          {row.daysOfCover === null
                            ? "—"
                            : `${decimal.format(row.daysOfCover)}d`}
                        </td>
                        <td>
                          <span
                            className={`status-pill ${
                              row.priority === "Critical"
                                ? "need"
                                : row.priority === "Covered"
                                  ? "have"
                                  : "partial"
                            }`}
                          >
                            {row.priority}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="production-signal-details">
              <article className="panel po-pressure">
                <PanelHeading
                  eyebrow="Committed demand"
                  title="August PO pressure by platform"
                  action={`${number.format(productionSignals.openPo.planningMonth.poCount)} POs`}
                />
                <div className="po-pressure-list">
                  {productionSignals.openPo.planningMonth.byPlatform.map(
                    (row) => (
                      <div key={row.platform}>
                        <span>{row.platform}</span>
                        <div>
                          <i
                            style={{
                              width: `${Math.max(
                                2,
                                (row.pendingPieces / maxAugustPlatformPo) * 100,
                              )}%`,
                            }}
                          />
                        </div>
                        <strong>{number.format(row.pendingPieces)}</strong>
                        <small>{number.format(row.poCount)} POs</small>
                      </div>
                    ),
                  )}
                </div>
              </article>
              <article className="panel mapping-blockers">
                <PanelHeading
                  eyebrow="Mapping gate"
                  title="PO demand excluded from calculation"
                  action={`${number.format(productionSignals.openPo.planningMonth.planCoverage.calculationBlockedPieces)} pieces`}
                />
                <p>
                  {number.format(
                    productionSignals.openPo.planningMonth.planCoverage
                      .mappedOutsidePlanPieces,
                  )}{" "}
                  pieces are mapped but missing a stock/forecast row, and{" "}
                  {number.format(
                    productionSignals.openPo.planningMonth.planCoverage
                      .unmappedPieces,
                  )}{" "}
                  pieces have no canonical product mapping. The software will
                  not guess either requirement.
                </p>
                <ol>
                  {[
                    ...productionSignals.openPo.planningMonth.planCoverage.mappedOutsidePlan
                      .slice(0, 2)
                      .map((row) => ({
                        name: row.name,
                        pieces: row.pendingPieces,
                        note: "Mapped · add stock and forecast row",
                      })),
                    ...productionSignals.openPo.planningMonth.unmapped
                      .slice(0, 2)
                      .map((row) => ({
                        name: row.skuName,
                        pieces: row.pendingPieces,
                        note: `${row.platform} · product mapping missing`,
                      })),
                  ].map((row, index) => (
                      <li key={`${row.note}-${row.name}`}>
                        <span>0{index + 1}</span>
                        <div>
                          <strong>{row.name}</strong>
                          <small>
                            {number.format(row.pieces)} pieces · {row.note}
                          </small>
                        </div>
                      </li>
                    ))}
                </ol>
              </article>
            </section>

            <section className="production-bottom-grid">
              <article className="panel factory-inputs">
                <PanelHeading
                  eyebrow="Before submission"
                  title="Factory inputs still needed"
                  action={`${productionPlan.missingFactoryInputs.length} items`}
                />
                <ol>
                  {productionPlan.missingFactoryInputs.map((item, index) => (
                    <li key={item}>
                      <span>0{index + 1}</span>
                      <p>{item}</p>
                    </li>
                  ))}
                </ol>
              </article>
              <article className="panel approval-route">
                <PanelHeading
                  eyebrow="Approval route"
                  title="Draft to factory"
                  action="No submission yet"
                />
                <ol>
                  <li className="complete">
                    <span>01</span>
                    <div>
                      <strong>System draft</strong>
                      <p>Inventory and demand calculation complete.</p>
                    </div>
                  </li>
                  <li>
                    <span>02</span>
                    <div>
                      <strong>Commercial review</strong>
                      <p>Promotions, launches and targets confirmed.</p>
                    </div>
                  </li>
                  <li>
                    <span>03</span>
                    <div>
                      <strong>Factory feasibility</strong>
                      <p>Capacity, batches and materials validated.</p>
                    </div>
                  </li>
                  <li>
                    <span>04</span>
                    <div>
                      <strong>Approved submission</strong>
                      <p>Locked version exported and acknowledged.</p>
                    </div>
                  </li>
                </ol>
              </article>
            </section>
          </div>
        )}

        {view === "readiness" && (
          <div className="page readiness-page">
            <PageHeading
              eyebrow="Build plan"
              title="Every data piece the software needs"
              description="The first release can operate with partial data. Automation begins only after product, location and movement records reconcile."
            />
            <section className="readiness-summary">
              <div>
                <span>Current readiness</span>
                <strong>4 core sources live</strong>
                <p>
                  Distributor opening, JM inventory, SAP billing and platform
                  PO/GRN are now joined in the read-only control tower.
                </p>
              </div>
              <div className="readiness-score" aria-label="Data readiness 56 percent">
                <strong>56%</strong>
                <span>ready for automation</span>
              </div>
            </section>
            <section className="requirements-grid">
              {requirements.map((item, index) => (
                <article className="requirement-card" key={item.group}>
                  <div className="requirement-head">
                    <span>0{index + 1}</span>
                    <strong>{item.group}</strong>
                    <span
                      className={`status-pill ${item.status === "Have" ? "have" : item.status === "Partial" ? "partial" : "need"}`}
                    >
                      {item.status}
                    </span>
                  </div>
                  <dl>
                    <div>
                      <dt>Already available</dt>
                      <dd>{item.have}</dd>
                    </div>
                    <div>
                      <dt>Still needed</dt>
                      <dd>{item.need}</dd>
                    </div>
                  </dl>
                </article>
              ))}
            </section>
            <section className="panel build-sequence">
              <PanelHeading
                eyebrow="Implementation sequence"
                title="What gets built next"
                action="Four stages"
              />
              <ol>
                <li>
                  <span>01</span>
                  <div>
                    <strong>Canonical masters</strong>
                    <p>Clean SAP, channel SKU, distributor and location identities.</p>
                  </div>
                </li>
                <li>
                  <span>02</span>
                  <div>
                    <strong>Movement ledger</strong>
                    <p>Invoice, billing, GRN, transfer and adjustment events.</p>
                  </div>
                </li>
                <li>
                  <span>03</span>
                  <div>
                    <strong>Daily reconciliation</strong>
                    <p>Calculated versus reported stock with owned exceptions.</p>
                  </div>
                </li>
                <li>
                  <span>04</span>
                  <div>
                    <strong>Planning engine</strong>
                    <p>Demand, days of inventory and approved replenishment actions.</p>
                  </div>
                </li>
              </ol>
            </section>
          </div>
        )}
      </section>
    </main>
  );
}

function Metric({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note: string;
  tone: "green" | "cream" | "amber" | "red";
}) {
  return (
    <article className={`metric-card ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{note}</p>
    </article>
  );
}

function CompactMetric({ label, value }: { label: string; value: string }) {
  return (
    <article>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function PanelHeading({
  eyebrow,
  title,
  action,
}: {
  eyebrow: string;
  title: string;
  action: string;
}) {
  return (
    <header className="panel-heading">
      <div>
        <span>{eyebrow}</span>
        <h2>{title}</h2>
      </div>
      <small>{action}</small>
    </header>
  );
}

function PageHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <header className="page-heading">
      <span>{eyebrow}</span>
      <h1>{title}</h1>
      <p>{description}</p>
    </header>
  );
}
