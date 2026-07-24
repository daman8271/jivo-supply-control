"use client";

import { useMemo, useState } from "react";

import replenishmentData from "./data/distributor-replenishment.json";

type Snapshot = typeof replenishmentData;
type Row = Snapshot["rows"][number];
type StatusFilter = "attention" | "replenish" | "blocked" | "all";

const number = new Intl.NumberFormat("en-IN");
const timestamp = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium",
  timeStyle: "short",
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

function matchesStatus(row: Row, status: StatusFilter) {
  if (status === "all") return true;
  if (status === "replenish") return row.status === "replenish";
  if (status === "blocked") {
    return ["identity-blocked", "blocked", "review"].includes(row.status);
  }
  return (
    row.openPoPieces > 0 &&
    !["covered", "no-demand"].includes(row.status)
  );
}

export default function ReplenishmentWorkbench() {
  const [distributor, setDistributor] = useState("all");
  const [status, setStatus] = useState<StatusFilter>("attention");
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return replenishmentData.rows.filter((row) => {
      if (distributor !== "all" && row.distributorId !== distributor) return false;
      if (!matchesStatus(row, status)) return false;
      if (!normalized) return true;
      return [row.skuName, row.sapCode, row.distributorName, row.category]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(normalized));
    });
  }, [distributor, query, status]);

  const visibleOpenPo = rows.reduce((sum, row) => sum + row.openPoPieces, 0);
  const visibleRecommended = rows.reduce(
    (sum, row) => sum + (row.recommendedPieces ?? 0),
    0,
  );
  const visibleBlocked = rows.reduce(
    (sum, row) => sum + (row.recommendedPieces === null ? row.openPoPieces : 0),
    0,
  );
  const distributorStats = replenishmentData.distributors.map((item) => {
    const distributorRows = replenishmentData.rows.filter(
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
    };
  });

  return (
    <div className="page replenishment-page">
      <section className="replenishment-hero" aria-labelledby="replenishment-title">
        <div>
          <span className="eyebrow">Distributor × SKU control</span>
          <h1 id="replenishment-title">Know what to replenish, where and why.</h1>
          <p>
            Every operational SKU from the distributor stock tracker or active PO set is
            crossed with all six distributors. PO demand is offset only by qualified SKU
            stock; stale stock, missing identities, openings and case packs stay visible as
            blockers instead of becoming invented recommendations.
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
        <article className="summary-positive">
          <span>Release-ready replenishment</span>
          <strong>{number.format(replenishmentData.summary.recommendedPieces)} pcs</strong>
          <small>{replenishmentData.summary.rowsToReplenish} SKU-distributor rows pass every evidence gate</small>
        </article>
        <article className="summary-blocked">
          <span>Demand blocked</span>
          <strong>{number.format(replenishmentData.summary.blockedOpenPoPieces)} pcs</strong>
          <small>
            {number.format(replenishmentData.summary.identityBlockedOpenPoPieces)} identity-blocked · {number.format(replenishmentData.summary.mappedEvidenceBlockedOpenPoPieces)} mapped/evidence-blocked
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
            aria-pressed={distributor === item.id}
            className={distributor === item.id ? "selected" : ""}
            key={item.id}
            type="button"
            onClick={() => setDistributor(distributor === item.id ? "all" : item.id)}
          >
            <strong>{item.name}</strong>
            <span>{number.format(item.openPoPieces)} PO pcs</span>
            <small>
              {number.format(item.recommendedPieces)} replenish · {number.format(item.blockedPieces)} blocked
            </small>
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
            <label>
              <span>Distributor</span>
              <select value={distributor} onChange={(event) => setDistributor(event.target.value)}>
                <option value="all">All distributors</option>
                {replenishmentData.distributors.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Status</span>
              <select value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)}>
                <option value="attention">Needs attention</option>
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
          <span><b>{number.format(rows.length)}</b> visible rows</span>
          <span><b>{number.format(visibleOpenPo)}</b> open PO pcs</span>
          <span><b>{number.format(visibleRecommended)}</b> recommended pcs</span>
          <span><b>{number.format(visibleBlocked)}</b> blocked-demand pcs</span>
        </div>

        <div className="replenishment-table-wrap">
          <table className="replenishment-table">
            <caption className="sr-only">
              Distributor by SKU open PO demand, qualified supply and draft replenishment recommendations
            </caption>
            <thead>
              <tr>
                <th>Distributor / SKU</th>
                <th>Open PO balance</th>
                <th>Stock / inbound</th>
                <th>Need / replenish</th>
                <th>Status / evidence</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
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
                      {row.stockStatus === "missing-physical-count"
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
                  <td colSpan={5} className="replenishment-empty">No SKU rows match the selected filters.</td>
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
          <strong>Tracker BAL = SOH + Billing − GRN</strong>
          <small>The 16 July stock evidence is visible but excluded because it exceeds the {replenishmentData.policy.maxStockAgeDays}-day freshness gate.</small>
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
