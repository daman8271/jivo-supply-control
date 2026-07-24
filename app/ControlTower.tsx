"use client";

import { useMemo, useState } from "react";

import { deriveControlStageStates } from "./lib/control-loop";

type Seed = typeof import("./data/seed.json");
type ProductionPlan = typeof import("./data/production-plan.json");
type ProductionSignals = typeof import("./data/production-signals.json");
type View =
  | "control"
  | "overview"
  | "inventory"
  | "distributors"
  | "production"
  | "readiness";
type Scope = "premium" | "all";
type ControlTone = "healthy" | "watch" | "blocked" | "draft";

const number = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1 });

function formatValue(value: number) {
  if (value >= 10_000_000) return `₹${(value / 10_000_000).toFixed(2)} Cr`;
  if (value >= 100_000) return `₹${(value / 100_000).toFixed(1)} L`;
  return `₹${number.format(value)}`;
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
  { id: "distributors", label: "Distributor network", short: "04" },
  { id: "production", label: "Production planning", short: "05" },
  { id: "readiness", label: "Data readiness", short: "06" },
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
  const [statusFilter, setStatusFilter] = useState("All");
  const [dealReservePct, setDealReservePct] = useState(0);
  const [safetyDays, setSafetyDays] = useState(
    productionPlan.defaultAssumptions.safetyDays,
  );

  const liveTotals = seed.liveReconciliation[scope];
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
    return seed.jmInventory.filter((row) => {
      const matchesQuery =
        !normalized ||
        row.sapCode.toLowerCase().includes(normalized) ||
        row.itemName.toLowerCase().includes(normalized);
      const matchesStatus = statusFilter === "All" || row.status === statusFilter;
      return matchesQuery && matchesStatus;
    });
  }, [query, seed.jmInventory, statusFilter]);

  const maxDistributorBalance = Math.max(
    ...seed.distributorSummary.map((row) =>
      Math.max(0, row.live[scope].projected),
    ),
    1,
  );
  const missingDistributorOpenings = seed.distributorSummary.filter(
    (row) => row.openingMissing,
  ).length;
  const materialBlockers = productionSignals.factoryPlanning.materials.blockers;
  const controlStageStates = deriveControlStageStates({
    demandPieces: productionPlan.totals.forecastPieces,
    targetsStatus: productionSignals.targets.status,
    openPoPieces: productionSignals.openPo.planningMonth.pendingPieces,
    blockedPoPieces:
      productionSignals.openPo.planningMonth.planCoverage.calculationBlockedPieces,
    networkProjectedUnits: seed.liveReconciliation.all.projected,
    missingDistributorOpenings,
    criticalInventorySkus: seed.jmTotals.criticalSkus,
    productionPieces: productionPlan.totals.productionPieces,
    productionStatus: productionPlan.status,
    materialBlockerCount: materialBlockers.length,
    productionOrderCount:
      productionSignals.factoryPlanning.officialForecast.augustProductionOrders,
    approvalConfigured:
      productionSignals.factoryPlanning.approvals.sapApprovalConfigured,
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
      signal: `${number.format(seed.liveReconciliation.all.projected)} projected units`,
      detail: `${number.format(seed.jmTotals.available)} JM available · ${missingDistributorOpenings} missing openings · ${seed.jmTotals.criticalSkus} critical JM SKUs`,
      target: "distributors",
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
  const controlActions: {
    title: string;
    owner: string;
    consequence: string;
    target: View;
  }[] = [
    {
      title: `Unblock ${number.format(productionSignals.openPo.planningMonth.planCoverage.calculationBlockedPieces)} PO pieces`,
      owner: "Demand planning + e-commerce ops",
      consequence: "Committed platform demand is excluded from the production calculation.",
      target: "production",
    },
    {
      title: `Resolve ${materialBlockers.length} material blockers`,
      owner: "Procurement + factory planning",
      consequence: "The draft production requirement cannot be released as planned.",
      target: "production",
    },
    {
      title: `Confirm ${missingDistributorOpenings} missing distributor openings`,
      owner: "Distributor operations",
      consequence: "Network coverage and replenishment decisions remain unreliable.",
      target: "distributors",
    },
    {
      title: `Address ${seed.jmTotals.criticalSkus} critical JM SKUs`,
      owner: "Inventory planning",
      consequence: "Low or negative availability can put platform PO fulfilment at risk.",
      target: "inventory",
    },
    {
      title: "Upload August targets",
      owner: "Commercial planning",
      consequence: "The draft has no official primary or secondary demand benchmark.",
      target: "production",
    },
  ];

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
            <span>Snapshot</span>
            <strong>24 July 2026 · 15:30 IST</strong>
          </div>
          <div className="topbar-actions">
            <span className="source-count">{seed.sourceStatus.length} sources</span>
            <button type="button" onClick={() => setView("readiness")}>
              Data checklist
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
                  The network has qualified stock signals, but the August release
                  path is blocked by demand coverage, materials and approval gaps.
                  Start with the first action below, then follow the chain
                  downstream.
                </p>
              </div>
              <div className="control-verdict" aria-label="Current chain verdict">
                <span>Next action</span>
                <strong>
                  Unblock {number.format(
                    productionSignals.openPo.planningMonth.planCoverage
                      .calculationBlockedPieces,
                  )}{" "}
                  PO pieces
                </strong>
                <button type="button" onClick={() => setView("production")}>
                  Open production detail <span aria-hidden="true">→</span>
                </button>
              </div>
            </section>

            <section className="control-summary" aria-label="Supply chain summary">
              <article className="control-summary-card visible">
                <span>Qualified network signal</span>
                <strong>
                  {number.format(seed.liveReconciliation.all.projected)} projected
                  network units
                </strong>
                <p>
                  Calculated from reported JM and distributor positions;{" "}
                  {missingDistributorOpenings} openings remain unconfirmed.
                </p>
              </article>
              <article className="control-summary-card blocked">
                <span>Blocked now</span>
                <strong>
                  {number.format(
                    productionSignals.openPo.planningMonth.planCoverage
                      .calculationBlockedPieces,
                  )}{" "}
                  PO pieces
                </strong>
                <p>Unmapped demand and missing plan rows understate the draft.</p>
              </article>
              <article className="control-summary-card watch">
                <span>Release gate</span>
                <strong>{materialBlockers.length} material shortages</strong>
                <p>No active SAP approval template covers the release.</p>
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
                {controlActions.map((action, index) => (
                  <li key={action.title}>
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
                value={number.format(seed.jmTotals.available)}
                note={`${decimal.format(seed.jmTotals.liters)} estimated litres on hand`}
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
                value={number.format(seed.jmTotals.committed)}
                note={`${number.format(seed.jmTotals.onOrder)} units currently on order`}
                tone="cream"
              />
              <Metric
                label="Open exceptions"
                value={number.format(
                  seed.jmTotals.criticalSkus + seed.distributorExceptions.length,
                )}
                note={`${seed.jmTotals.criticalSkus} JM critical · ${seed.distributorExceptions.length} distributor`}
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
                  {seed.distributorSummary.map((distributor) => {
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
                  <span>{seed.liveReconciliation.label}</span>
                  <strong>{seed.liveReconciliation.formula}</strong>
                </div>
              </article>

              <article className="panel priority-panel">
                <PanelHeading
                  eyebrow="Priority queue"
                  title="Act on these first"
                  action="JM inventory"
                />
                <div className="priority-list">
                  {seed.jmInventory
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
              description="Current Sonipat warehouse position, with committed quantities separated from physical on-hand stock."
            />
            <section className="compact-kpis">
              <CompactMetric label="On hand" value={number.format(seed.jmTotals.onHand)} />
              <CompactMetric
                label="Available"
                value={number.format(seed.jmTotals.available)}
              />
              <CompactMetric
                label="On order"
                value={number.format(seed.jmTotals.onOrder)}
              />
              <CompactMetric
                label="Stock value"
                value={formatValue(seed.jmTotals.stockValue)}
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

        {view === "distributors" && (
          <div className="page">
            <PageHeading
              eyebrow="Distributor network"
              title="Live stock projection"
              description="The 16 July opening carried forward with live SAP billing and platform-accepted quantities."
            />
            <section className="formula-banner">
              <span>{seed.liveReconciliation.label}</span>
              <strong>{seed.liveReconciliation.formula}</strong>
              <small>
                Excludes unreported in-transit stock and manual adjustments;
                Knowtable and Evara still need physical opening confirmation.
              </small>
            </section>
            <section className="distributor-card-grid">
              {seed.distributorSummary.map((distributor) => (
                <article className="network-card" key={distributor.id}>
                  <div className="network-card-head">
                    <div>
                      <strong>{distributor.name}</strong>
                      <span>{distributor.city}</span>
                    </div>
                    <span
                      className={
                        distributor.openingMissing
                          ? "status-pill need"
                          : distributor.live.leadTimeDays
                            ? "status-pill have"
                            : "status-pill partial"
                      }
                    >
                      {distributor.openingMissing
                        ? "Opening missing"
                        : distributor.live.leadTimeDays
                          ? `${distributor.live.leadTimeDays}d transit`
                          : "Lead time needed"}
                    </span>
                  </div>
                  <div className="network-metrics">
                    <span>
                      <small>16 Jul opening</small>
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
                      <small>24 Jul projected</small>
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
            <section className="panel table-panel">
              <PanelHeading
                eyebrow="Opening exceptions"
                title="Negative 16 July balances"
                action={`${seed.distributorExceptions.length} rows`}
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
                    {seed.distributorExceptions.map((row, index) => (
                      <tr key={`${row.distributorId}-${row.sapCode}-${index}`}>
                        <td>{row.distributor}</td>
                        <td>
                          <strong>{row.sku}</strong>
                          <small className="mono">{row.sapCode}</small>
                        </td>
                        <td>{row.itemHead}</td>
                        <td>{number.format(row.soh)}</td>
                        <td>{number.format(row.billing)}</td>
                        <td>{number.format(row.grn)}</td>
                        <td className="negative-text">{number.format(row.balance)}</td>
                        <td>
                          <span className="status-pill need">{row.issue}</span>
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
