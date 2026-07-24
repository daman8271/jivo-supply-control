"use client";

import { useMemo, useState } from "react";

type Seed = typeof import("./data/seed.json");
type ProductionPlan = typeof import("./data/production-plan.json");
type View =
  | "overview"
  | "inventory"
  | "distributors"
  | "production"
  | "readiness";
type Scope = "premium" | "all";

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
  { id: "overview", label: "Overview", short: "01" },
  { id: "inventory", label: "Own inventory", short: "02" },
  { id: "distributors", label: "Distributor network", short: "03" },
  { id: "production", label: "Production planning", short: "04" },
  { id: "readiness", label: "Data readiness", short: "05" },
];

export function ControlTower({
  seed,
  productionPlan,
}: {
  seed: Seed;
  productionPlan: ProductionPlan;
}) {
  const [view, setView] = useState<View>("overview");
  const [scope, setScope] = useState<Scope>("premium");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [growthPct, setGrowthPct] = useState(0);
  const [safetyDays, setSafetyDays] = useState(
    productionPlan.defaultAssumptions.safetyDays,
  );

  const liveTotals = seed.liveReconciliation[scope];

  const adjustedProductionRows = useMemo(
    () =>
      productionPlan.rows
        .filter(
          (row) =>
            scope === "all" || row.itemHead.toUpperCase() === "PREMIUM",
        )
        .map((row) => {
          const forecastPieces = Math.max(
            0,
            Math.round(row.baseForecastPieces * (1 + growthPct / 100)),
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
    [growthPct, productionPlan, safetyDays, scope],
  );

  const adjustedProductionTotals = useMemo(
    () =>
      adjustedProductionRows.reduce(
        (totals, row) => {
          totals.forecastPieces += row.forecastPieces;
          totals.productionPieces += row.productionPieces;
          totals.productionCases += row.productionCases;
          if (row.priority === "Critical") totals.criticalSkus += 1;
          return totals;
        },
        {
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

  function downloadProductionCsv() {
    const headings = [
      "Planning Month",
      "SKU",
      "SAP Code",
      "Scope",
      "Forecast Pieces",
      "Network Available",
      "On Order",
      "Safety Pieces",
      "Production Pieces",
      "Case Pack",
      "Production Cases",
      "Priority",
    ];
    const rows = adjustedProductionRows.map((row) => [
      productionPlan.planningMonth,
      row.name,
      row.sapCode ?? "",
      row.itemHead,
      row.forecastPieces,
      row.networkAvailable,
      row.onOrder,
      row.safetyPieces,
      row.productionPieces,
      row.casePack,
      row.productionCases,
      row.priority,
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
    link.download = `Jivo-production-plan-${productionPlan.planningMonth.replaceAll(" ", "-")}.csv`;
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
              description="A factory-ready monthly requirement built from recent e-commerce movement, live network stock and JM on-order quantities."
            />

            <section className="production-command">
              <div>
                <span className="status-pill partial">{productionPlan.status}</span>
                <strong>Scenario controls</strong>
                <p>
                  Adjust the demand uplift and safety cover. The requirement
                  recalculates instantly and stays rounded to case packs.
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
                  Export factory CSV
                </button>
              </div>
            </section>

            <section className="planning-controls">
              <label>
                <span>
                  Demand adjustment
                  <strong>{growthPct > 0 ? `+${growthPct}` : growthPct}%</strong>
                </span>
                <input
                  aria-label="Demand adjustment percentage"
                  max="30"
                  min="-10"
                  onChange={(event) => setGrowthPct(Number(event.target.value))}
                  step="5"
                  type="range"
                  value={growthPct}
                />
                <small>Use for promotions, launches or a cautious forecast.</small>
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
                <small>Extra cover held after August forecast demand.</small>
              </label>
              <div className="planning-method">
                <span>Forecast method</span>
                <strong>May–July weighted run-rate</strong>
                <small>50% July · 30% June · 20% May</small>
              </div>
            </section>

            <section className="kpi-grid" aria-label="Production plan metrics">
              <Metric
                label="August forecast"
                value={number.format(adjustedProductionTotals.forecastPieces)}
                note={`${scope === "premium" ? "Premium products" : "All e-commerce"} · pieces`}
                tone="cream"
              />
              <Metric
                label="Suggested production"
                value={number.format(adjustedProductionTotals.productionPieces)}
                note={`${number.format(adjustedProductionTotals.productionCases)} factory cases`}
                tone="green"
              />
              <Metric
                label="Products to make"
                value={number.format(
                  adjustedProductionRows.filter(
                    (row) => row.productionPieces > 0,
                  ).length,
                )}
                note={`${adjustedProductionRows.length} products in selected scope`}
                tone="cream"
              />
              <Metric
                label="Critical cover"
                value={number.format(adjustedProductionTotals.criticalSkus)}
                note="Below selected safety-stock days"
                tone={
                  adjustedProductionTotals.criticalSkus > 0 ? "red" : "green"
                }
              />
            </section>

            <section className="formula-banner production-formula">
              <span>Planning equation</span>
              <strong>
                Production = forecast + safety − network stock − on order
              </strong>
              <small>Rounded up to the SKU case pack; no factory order is sent.</small>
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
                      <th>Forecast</th>
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
