"use client";

import { useMemo, useState } from "react";

import replenishmentData from "./data/distributor-replenishment.json";
import {
  clearDistributorSelection,
  selectAllDistributors,
  toggleDistributorSelection,
} from "./lib/distributor-selection.js";
import { applyLiveDistributorStock } from "./lib/live-replenishment.js";
import {
  groupReplenishmentRows,
  sortReplenishmentRows,
} from "./lib/replenishment-table.js";

type Snapshot = typeof replenishmentData;
type Row = Snapshot["rows"][number];
type GroupedRow = {
  id: string;
  grouped: true;
  skuName: string;
  sapCode: string | null;
  itemHead: string;
  category: string;
  distributorNames: string[];
  distributorName: string;
  distributorCount: number;
  requiredInventoryPieces: number;
  unqualifiedRequirementPieces: number;
  openPoPieces: number;
  openPoCount: number;
  poNumbers: string[];
  platforms: string[];
  qualifiedStockPieces: number;
  qualifiedStockDistributors: number;
  liveStockDistributors: number;
  stockExceptionCount: number;
  rawNeedPieces: number;
  recommendedPieces: number;
  blockedOpenPoPieces: number;
  status: string;
};
type DisplayRow = (Row & { grouped?: false }) | GroupedRow;
type StatusFilter = "attention" | "requirement" | "replenish" | "blocked" | "all";
type SortKey = "identity" | "required" | "openPo" | "stock" | "need" | "status";
type SortDirection = "asc" | "desc";
type GroupMode = "rows" | "sku";
type SortState = { key: SortKey; direction: SortDirection };
type LiveProjection = {
  status: string;
  observedAt: string;
  distributors: Array<{
    id: string;
    rows?: Array<{
      sapCode: string;
      projectedPieces: number;
      status: string;
    }>;
  }>;
};

const number = new Intl.NumberFormat("en-IN");
const timestamp = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Kolkata",
});
const monthYear = new Intl.DateTimeFormat("en-IN", {
  month: "long",
  year: "numeric",
  timeZone: "Asia/Kolkata",
});
const statusLabels: Record<string, string> = {
  "identity-blocked": "Identity blocked",
  blocked: "Evidence blocked",
  review: "Review pack",
  replenish: "Replenish",
  covered: "Covered",
  "no-demand": "No PO demand",
};

function formatSourceAsOf(value: string | null) {
  if (!value) return "Source timestamp unavailable";
  if (value.length === 10) return `As of ${value}`;
  return `As of ${timestamp.format(new Date(value))} IST`;
}

function formatRequirementMonth(value: string) {
  return monthYear.format(new Date(`${value}T00:00:00+05:30`));
}

function unqualifiedRequirementPieces(row: Row) {
  return "unqualifiedLastMonthPoPieces" in row
    ? (row.unqualifiedLastMonthPoPieces ?? 0)
    : 0;
}

function matchesStatus(row: Row, status: StatusFilter) {
  if (status === "all") return true;
  if (status === "requirement") {
    return (
      (row.requiredInventoryPieces ?? 0) > 0 ||
      unqualifiedRequirementPieces(row) > 0
    );
  }
  if (status === "replenish") return row.status === "replenish";
  if (status === "blocked") {
    return ["identity-blocked", "blocked", "review"].includes(row.status);
  }
  return (
    (row.requiredInventoryPieces ?? 0) > 0 ||
    unqualifiedRequirementPieces(row) > 0 ||
    (row.openPoPieces > 0 && !["covered", "no-demand"].includes(row.status))
  );
}

function isGroupedRow(row: DisplayRow): row is GroupedRow {
  return row.grouped === true;
}

function SortableHeader({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  sort: SortState;
  onSort: (key: SortKey) => void;
}) {
  const active = sort.key === sortKey;
  const directionLabel = !active
    ? "Sort"
    : sort.direction === "desc"
      ? sortKey === "identity" ? "Z → A" : "High → low"
      : sortKey === "identity" ? "A → Z" : "Low → high";
  return (
    <th aria-sort={active ? (sort.direction === "desc" ? "descending" : "ascending") : "none"}>
      <button
        className={`replenishment-sort ${active ? "active" : ""}`}
        type="button"
        onClick={() => onSort(sortKey)}
      >
        <span>{label}</span>
        <small>{active ? (sort.direction === "desc" ? "↓" : "↑") : "↕"} {directionLabel}</small>
      </button>
    </th>
  );
}

export default function ReplenishmentWorkbench({
  liveDistributors,
}: {
  liveDistributors: LiveProjection;
}) {
  const [selectedDistributors, setSelectedDistributors] = useState<string[]>(() =>
    replenishmentData.distributors.map((item) => item.id),
  );
  const [status, setStatus] = useState<StatusFilter>("attention");
  const [query, setQuery] = useState("");
  const [groupMode, setGroupMode] = useState<GroupMode>("rows");
  const [sort, setSort] = useState<SortState>({ key: "openPo", direction: "desc" });
  const selectedDistributorSet = useMemo(
    () => new Set(selectedDistributors),
    [selectedDistributors],
  );
  const canonicalRows = useMemo(
    () => applyLiveDistributorStock(replenishmentData.rows, liveDistributors) as Row[],
    [liveDistributors],
  );

  const toggleDistributor = (distributorId: string) => {
    setSelectedDistributors((current) =>
      toggleDistributorSelection(current, distributorId),
    );
  };

  const filteredRows = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return canonicalRows.filter((row) => {
      if (!selectedDistributorSet.has(row.distributorId)) return false;
      if (!matchesStatus(row, status)) return false;
      if (!normalized) return true;
      return [row.skuName, row.sapCode, row.distributorName, row.category]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(normalized));
    });
  }, [canonicalRows, query, selectedDistributorSet, status]);
  const rows = useMemo<DisplayRow[]>(() => {
    const displayRows = groupMode === "sku"
      ? groupReplenishmentRows(filteredRows)
      : filteredRows;
    return sortReplenishmentRows(displayRows, sort) as DisplayRow[];
  }, [filteredRows, groupMode, sort]);

  const toggleSort = (key: SortKey) => {
    setSort((current) => ({
      key,
      direction: current.key === key
        ? (current.direction === "desc" ? "asc" : "desc")
        : (key === "identity" ? "asc" : "desc"),
    }));
  };
  const setGrouping = (mode: GroupMode) => {
    setGroupMode(mode);
    if (mode === "sku") {
      setStatus("all");
      setSort({ key: "openPo", direction: "desc" });
    }
  };

  const visibleOpenPo = rows.reduce((sum, row) => sum + row.openPoPieces, 0);
  const visibleRecommended = rows.reduce(
    (sum, row) => sum + (row.recommendedPieces ?? 0),
    0,
  );
  const visibleBlocked = rows.reduce(
    (sum, row) =>
      sum + (isGroupedRow(row)
        ? row.blockedOpenPoPieces
        : (row.recommendedPieces === null ? row.openPoPieces : 0)),
    0,
  );
  const visibleRequiredInventory = rows.reduce(
    (sum, row) => sum + (row.requiredInventoryPieces ?? 0),
    0,
  );
  const canonicalRecommendedPieces = canonicalRows.reduce(
    (sum, row) => sum + (row.recommendedPieces ?? 0),
    0,
  );
  const canonicalRowsToReplenish = canonicalRows.filter(
    (row) => row.status === "replenish",
  ).length;
  const canonicalBlockedOpenPoPieces = canonicalRows.reduce(
    (sum, row) => sum + (row.recommendedPieces === null ? row.openPoPieces : 0),
    0,
  );
  const canonicalIdentityBlockedOpenPoPieces = canonicalRows.reduce(
    (sum, row) => sum + (row.status === "identity-blocked" ? row.openPoPieces : 0),
    0,
  );
  const canonicalMappedEvidenceBlockedOpenPoPieces =
    canonicalBlockedOpenPoPieces - canonicalIdentityBlockedOpenPoPieces;
  const distributorStats = replenishmentData.distributors.map((item) => {
    const distributorRows = canonicalRows.filter(
      (row) => row.distributorId === item.id,
    );
    return {
      ...item,
      openPoPieces: distributorRows.reduce(
        (sum, row) => sum + row.openPoPieces,
        0,
      ),
      recommendedPieces: distributorRows.reduce(
        (sum, row) => sum + (row.recommendedPieces ?? 0),
        0,
      ),
      blockedPieces: distributorRows.reduce(
        (sum, row) =>
          sum + (row.recommendedPieces === null ? row.openPoPieces : 0),
        0,
      ),
      requiredInventoryPieces: distributorRows.reduce(
        (sum, row) => sum + (row.requiredInventoryPieces ?? 0),
        0,
      ),
      unqualifiedRequirementPieces: distributorRows.reduce(
        (sum, row) => sum + unqualifiedRequirementPieces(row),
        0,
      ),
    };
  });

  return (
    <div className="page replenishment-page">
      <section className="replenishment-hero" aria-labelledby="replenishment-title">
        <div>
          <span className="eyebrow">Distributor × SKU control</span>
          <h1 id="replenishment-title">Know what to replenish, where and why.</h1>
          <p>
            Every operational SKU from the distributor stock tracker, active PO set or
            previous-month PO set is crossed with all six distributors. PO demand is offset
            only by qualified SKU stock; stale stock, missing identities, openings and case
            packs stay visible as blockers instead of becoming invented recommendations.
          </p>
        </div>
        <div className="replenishment-policy">
          <span>Active policy</span>
          <strong>PO-only · buffer excluded</strong>
          <small>Planning cutoff {timestamp.format(new Date(replenishmentData.planningCutoff))} IST</small>
        </div>
      </section>

      <section className="replenishment-summary" aria-label="Replenishment summary">
        <article>
          <span>Tracked matrix</span>
          <strong>{number.format(replenishmentData.summary.trackedRows)} rows</strong>
          <small>
            {replenishmentData.summary.distributors} distributors × {replenishmentData.summary.canonicalSkus} canonical SKUs, plus PO identity blockers
          </small>
        </article>
        <article>
          <span>Open PO demand</span>
          <strong>{number.format(replenishmentData.summary.openPoPieces)} pcs</strong>
          <small>{number.format(replenishmentData.summary.mappedOpenPoPieces)} pieces mapped to SAP SKUs</small>
        </article>
        <article>
          <span>{formatRequirementMonth(replenishmentData.policy.requirementPeriodStart)} inventory requirement</span>
          <strong>{number.format(replenishmentData.summary.requiredInventoryPieces)} pcs</strong>
          <small>
            80% of {number.format(replenishmentData.summary.lastMonthQualifiedPoPieces)} qualified {formatRequirementMonth(replenishmentData.policy.requirementPeriodStart)} PO pieces · rounded up per distributor × SKU
          </small>
          <small>
            {number.format(replenishmentData.summary.unqualifiedLastMonthPoPieces)} historical PO quantity excluded until SKU identity and UOM are qualified
          </small>
        </article>
        <article className="summary-positive">
          <span>Release-ready replenishment</span>
          <strong>{number.format(canonicalRecommendedPieces)} pcs</strong>
          <small>{canonicalRowsToReplenish} SKU-distributor rows pass every evidence gate</small>
        </article>
        <article className="summary-blocked">
          <span>Demand blocked</span>
          <strong>{number.format(canonicalBlockedOpenPoPieces)} pcs</strong>
          <small>
            {number.format(canonicalIdentityBlockedOpenPoPieces)} identity-blocked · {number.format(canonicalMappedEvidenceBlockedOpenPoPieces)} mapped/evidence-blocked
          </small>
          <small>Missing or stale stock, identity, UOM or case-pack evidence prevents an exact recommendation</small>
        </article>
      </section>

      <section className="replenishment-lifecycle" aria-label="Planner lifecycle">
        {replenishmentData.policy.lifecycle.map((stage, index) => (
          <div key={stage}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{stage}</strong>
          </div>
        ))}
      </section>

      <section className="replenishment-distributors" aria-label="Distributor replenishment totals">
        {distributorStats.map((item) => (
          <button
            aria-pressed={selectedDistributorSet.has(item.id)}
            className={selectedDistributorSet.has(item.id) ? "selected" : ""}
            key={item.id}
            type="button"
            onClick={() => toggleDistributor(item.id)}
          >
            <strong>{item.name}</strong>
            <span>{number.format(item.openPoPieces)} PO pcs</span>
            <span>{number.format(item.requiredInventoryPieces)} qualified required pcs</span>
            <small>
              {number.format(item.recommendedPieces)} replenish · {number.format(item.blockedPieces)} blocked
            </small>
            <small>{number.format(item.unqualifiedRequirementPieces)} historical PO qty excluded from target</small>
          </button>
        ))}
      </section>

      <section className="replenishment-workbench panel" aria-labelledby="sku-matrix-title">
        <header className="replenishment-toolbar">
          <div>
            <span className="eyebrow">Exception-first workbench</span>
            <h2 id="sku-matrix-title">SKU replenishment matrix</h2>
          </div>
          <div className="replenishment-filters">
            <div className="replenishment-view-toggle" role="group" aria-label="Table grouping">
              <button
                aria-pressed={groupMode === "rows"}
                className={groupMode === "rows" ? "active" : ""}
                type="button"
                onClick={() => setGrouping("rows")}
              >
                Distributor rows
              </button>
              <button
                aria-pressed={groupMode === "sku"}
                className={groupMode === "sku" ? "active" : ""}
                type="button"
                onClick={() => setGrouping("sku")}
              >
                Group by SKU
              </button>
            </div>
            <div
              className="replenishment-multi-select"
              role="group"
              aria-labelledby="distributor-selection-label"
            >
              <span id="distributor-selection-label">
                Distributors · {selectedDistributors.length}/{replenishmentData.distributors.length} selected
              </span>
              <div>
                <button
                  type="button"
                  onClick={() => setSelectedDistributors(selectAllDistributors(replenishmentData.distributors))}
                >
                  Select all
                </button>
                <button type="button" onClick={() => setSelectedDistributors(clearDistributorSelection())}>
                  Clear all
                </button>
              </div>
            </div>
            <label>
              <span>Status</span>
              <select value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)}>
                <option value="attention">Needs attention</option>
                <option value="requirement">Has requirement or requirement blocker</option>
                <option value="replenish">Calculable replenishment</option>
                <option value="blocked">Blocked or review</option>
                <option value="all">Every SKU × distributor row</option>
              </select>
            </label>
            <label className="replenishment-search">
              <span>Find SKU</span>
              <input
                type="search"
                placeholder="SAP code or SKU"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          </div>
        </header>

        <div className="replenishment-visible-summary" aria-live="polite">
          <span><b>{number.format(rows.length)}</b> visible {groupMode === "sku" ? "SKU groups / unresolved rows" : "rows"}</span>
          <span><b>{number.format(visibleRequiredInventory)}</b> required inventory pcs</span>
          <span><b>{number.format(visibleOpenPo)}</b> open PO pcs</span>
          <span><b>{number.format(visibleRecommended)}</b> recommended pcs</span>
          <span><b>{number.format(visibleBlocked)}</b> blocked-demand pcs</span>
        </div>

        <div className="replenishment-table-wrap">
          <table className="replenishment-table">
            <caption className="sr-only">
              Distributor by SKU inventory requirement, open PO demand, qualified supply and draft replenishment recommendations
            </caption>
            <thead>
              <tr>
                <SortableHeader label={groupMode === "sku" ? "SKU group" : "Distributor / SKU"} sortKey="identity" sort={sort} onSort={toggleSort} />
                <SortableHeader label="Required inventory" sortKey="required" sort={sort} onSort={toggleSort} />
                <SortableHeader label="Platform PO orders" sortKey="openPo" sort={sort} onSort={toggleSort} />
                <SortableHeader label="Stock / inbound" sortKey="stock" sort={sort} onSort={toggleSort} />
                <SortableHeader label="Need / replenish" sortKey="need" sort={sort} onSort={toggleSort} />
                <SortableHeader label="Status / evidence" sortKey="status" sort={sort} onSort={toggleSort} />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => isGroupedRow(row) ? (
                <tr key={row.id} className={`replenishment-row replenishment-group status-${row.status}`}>
                  <td>
                    <strong>{row.skuName}</strong>
                    <span>{row.sapCode ?? "Unmapped SKU row"}</span>
                    <small>{row.itemHead} · {row.category}</small>
                    <small>{row.distributorCount} selected distributor rows</small>
                  </td>
                  <td>
                    <b>{number.format(row.requiredInventoryPieces)}</b>
                    <span>Qualified inventory target</span>
                    <small>{number.format(row.unqualifiedRequirementPieces)} historical PO pcs unqualified</small>
                  </td>
                  <td>
                    <b>{number.format(row.openPoPieces)} pieces</b>
                    <span>{number.format(row.openPoCount)} platform PO orders</span>
                    <small>{row.platforms.join(", ") || "No mapped platform"}</small>
                    <small>
                      PO refs {row.poNumbers.slice(0, 3).join(", ") || "none"}
                      {row.poNumbers.length > 3 ? ` +${row.poNumbers.length - 3}` : ""}
                    </small>
                  </td>
                  <td>
                    <b>{number.format(row.qualifiedStockPieces)}</b>
                    <span>{row.qualifiedStockDistributors}/{row.distributorCount} distributor positions qualified</span>
                    <small>{row.liveStockDistributors} live · {row.stockExceptionCount} exceptions</small>
                  </td>
                  <td>
                    <span>Raw need {number.format(row.rawNeedPieces)}</span>
                    <b>Replenish {number.format(row.recommendedPieces)}</b>
                    <small>{number.format(row.blockedOpenPoPieces)} platform PO pcs blocked by evidence</small>
                  </td>
                  <td>
                    <span className={`replenishment-status ${row.status}`}>
                      {statusLabels[row.status] ?? row.status}
                    </span>
                    <small>{row.distributorNames.join(", ")}</small>
                  </td>
                </tr>
              ) : (
                <tr key={row.id} className={`replenishment-row status-${row.status}`}>
                  <td>
                    <strong>{row.skuName}</strong>
                    <span>{row.sapCode ?? "SAP mapping missing"} · {row.distributorName}</span>
                    <small>{row.itemHead} · {row.category}</small>
                    <small>
                      {row.companyCode ?? "Company unresolved"} · {row.sapSchema ?? "Schema unresolved"}
                    </small>
                    <small>
                      Base {row.baseUom ?? "unknown"} · per unit {row.perUnit ?? "unknown"} · PO {row.planningUom ?? "unknown"}
                    </small>
                  </td>
                  <td>
                    <b>
                      {row.requirementQualified && row.requiredInventoryPieces !== null
                        ? number.format(row.requiredInventoryPieces)
                        : "Blocked"}
                    </b>
                    <span>
                      {row.lastMonthPoPieces !== null
                        ? `80% of ${number.format(row.lastMonthPoPieces)} ${formatRequirementMonth(row.requirementPeriodStart)} PO pcs`
                        : `${number.format(unqualifiedRequirementPieces(row))} historical PO qty unqualified`}
                    </span>
                    <small>
                      {row.lastMonthPoCount} POs · {row.requirementPlatforms.join(", ") || "No POs in period"}
                    </small>
                    <small>
                      PO refs {row.lastMonthPoNumbers.slice(0, 3).join(", ") || "none"}
                      {row.lastMonthPoNumbers.length > 3 ? ` +${row.lastMonthPoNumbers.length - 3}` : ""}
                    </small>
                    <small>
                      {row.requirementBlocker ?? "Display target only · rounded up to next piece"}
                    </small>
                  </td>
                  <td>
                    <b>{number.format(row.openPoPieces)}</b>
                    <span>{row.openPoCount} POs · {row.platforms.join(", ") || "No mapped platform"}</span>
                    <small>
                      PO refs {row.poNumbers.slice(0, 3).join(", ") || "none"}
                      {row.poNumbers.length > 3 ? ` +${row.poNumbers.length - 3}` : ""}
                    </small>
                    <small>{row.nextPoExpiry ? `Next expiry ${row.nextPoExpiry}` : "No active PO expiry"}</small>
                  </td>
                  <td>
                    <b>{row.evidencedStockPieces !== null ? number.format(row.evidencedStockPieces) : "Unknown"}</b>
                    <span>{row.stockStatus.replaceAll("-", " ")}</span>
                    <small>
                      {row.stockStatus.startsWith("live-")
                        ? `Same live distributor projection · ${formatSourceAsOf(row.stockAsOf).replace("As of ", "")}`
                        : row.stockStatus === "missing-physical-count"
                          ? "SKU absent from the accepted Antize physical count"
                          : row.stockStatus.includes("physical-count")
                            ? `Antize physical count · ${row.stockAsOf ?? "date missing"}`
                            : row.trackerBalancePieces !== null
                              ? `Tracker BAL ${number.format(row.trackerBalancePieces)} · ${row.stockAsOf ?? "date missing"}`
                              : "No qualified SKU stock row"}
                    </small>
                    <small><b>Inbound</b> Unknown · excluded; explicit zero evidence required</small>
                  </td>
                  <td>
                    <span>Raw need {row.rawNeedPieces === null ? "blocked" : number.format(row.rawNeedPieces)}</span>
                    <b>Replenish {row.recommendedPieces === null ? "blocked" : number.format(row.recommendedPieces)}</b>
                    <span>{row.casePack ? `Rounded to ${row.casePack}/case` : "Case pack unavailable"}</span>
                    <small>{row.casePackSource ?? "Case pack source missing"} · buffer excluded</small>
                    <small>{row.stockQualified && row.inboundQualified && row.casePackStatus === "qualified" ? "Draft only · planner approval required" : "Evidence blocked · not release-ready"}</small>
                  </td>
                  <td>
                    <span className={`replenishment-status ${row.status}`}>
                      {statusLabels[row.status] ?? row.status}
                    </span>
                    <small>{(row.blocker ?? (row.poMappingSources.join("; ") || "Qualified source evidence"))}</small>
                    <small>{row.locations.length ? row.locations.join(", ") : "No active PO location"}</small>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="replenishment-empty">No SKU rows match the selected filters.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="replenishment-formula" aria-label="Calculation and evidence rules">
        <div>
          <span>PO-only formula</span>
          <strong>{replenishmentData.policy.formula}</strong>
          <small>{replenishmentData.policy.quantityUnit}</small>
          <small>Then round up to the qualified case pack. Missing or stale evidence blocks every exact quantity.</small>
        </div>
        <div>
          <span>Inventory evidence</span>
          <strong>
            {liveDistributors.status === "live-projection"
              ? "Canonical live SOH shared with Distributor network"
              : "Live distributor SOH unavailable"}
          </strong>
          <small>
            {liveDistributors.status === "live-projection"
              ? `Opening + SAP billing − platform GRN · ${formatSourceAsOf(liveDistributors.observedAt)}`
              : "Dated stock remains visible but cannot qualify a recommendation."}
          </small>
        </div>
        <div>
          <span>Read-only boundary</span>
          <strong>No source-system write-back</strong>
          <small>Required → Factory-ready → Transferred → Platform GRN → Closed is planner-owned evidence only.</small>
        </div>
      </section>

      <section className="replenishment-sources panel" aria-labelledby="replenishment-sources-title">
        <header>
          <span className="eyebrow">Provenance</span>
          <h2 id="replenishment-sources-title">Sources and freshness</h2>
        </header>
        <div>
          {replenishmentData.sources.map((source) => (
            <article key={source.name}>
              <strong>{source.name}</strong>
              <span>{formatSourceAsOf(source.asOf)}</span>
              {"companyCode" in source ? (
                <small>{source.companyCode} · {source.sapSchema}</small>
              ) : null}
              <small>
                {"mode" in source
                  ? source.mode
                  : "formula" in source
                    ? source.formula
                    : `${number.format(source.acceptedPieces)} accepted pieces`}
              </small>
              <small>SHA-256 {source.sha256.slice(0, 12)}…</small>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
