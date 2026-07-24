# Jivo Supply Control

An e-commerce supply-chain control tower for Jivo demand, platform purchase
orders, network inventory, factory production, materials, approval readiness,
and distributor reconciliation.

> **Public data notice:** this repository intentionally contains a snapshot of
> real operational inventory, distributor, and platform-PO data. It was
> published publicly with the business owner's explicit approval. No passwords,
> API keys, access tokens, service credentials, or `.env` files are included.

## What it does

- Opens on an end-to-end **Control loop** that shows chain health, blockers, and
  the next planner action in one view
- Connects the six planning stages: Demand → Platform POs → Network stock →
  Production → Materials → Approval & dispatch
- Prioritizes planner-owned actions with a responsible role, downstream
  consequence, and link to the supporting detail view
- Tracks every canonical SKU across all six distributors in a dedicated
  **SKU replenishment** workbench
- Calculates a PO-only distributor replenishment draft from open PO balance,
  qualified SKU stock, confirmed inbound, and case-pack rounding
- Keeps unmapped PO identities, missing openings, stale stock, negative
  reconciliation rows, unknown inbound, UOM conflicts, and missing case packs
  visibly blocked
- Preserves the planner-owned lifecycle: Required → Factory-ready →
  Transferred → Platform GRN → Closed
- Reconciles distributor inventory using `SOH = BAL + GRN - Billing`
- Shows JM own inventory, commitments, availability, and critical SKUs
- Combines Cold Press 1L and Canola 1L as one planning product
- Uses live open platform POs as the committed August demand floor
- Keeps uncertain deal volume as an explicit, adjustable reserve
- Calculates case-pack-rounded production requirements
- Surfaces unmapped PO demand and material blockers before submission
- Exports a draft in the SAP `SalesForecast` line format

The current planning snapshot is for **August 2026**, using source data reviewed
on **24 July 2026**. Source systems remain read-only. Recommendations and
exports stay in the planner and remain drafts until a person approves them;
the software does not create source-system orders or dispatches.

## Planning logic

```text
Selected demand = max(weighted baseline + deal reserve, mapped August open POs)

Production = selected demand + safety stock
             - network stock - JM on-order
```

The result is rounded up to the product's case pack. Platform POs are used as a
floor, not added a second time to the baseline.

Distributor replenishment is calculated separately at distributor × SAP SKU:

```text
Open PO balance = max(0, order quantity - source delivered quantity)

Raw replenishment = max(0, open PO balance
                           - qualified usable distributor stock
                           - confirmed inbound)

Recommended replenishment = raw replenishment rounded up to case pack
```

The builder accepts only explicitly qualified open statuses, validates delivered
quantity against filled quantity, collapses exact duplicate PO lines, and fails
closed on conflicting versions. The current feed does not itself prove platform
GRN acceptance, so it remains planning evidence rather than closure evidence.

The initial policy is PO-only. Safety or forecast buffer is explicitly excluded
until a planner approves a separate scenario. Missing or stale stock, identity,
UOM, or case-pack evidence produces a blocked row with no exact quantity.

## Run locally

Requires Node.js `>=22.13.0`.

```bash
npm install
npm run dev
```

Open the local address shown in the terminal.

## Verify

```bash
npm test
npm run lint
```

## Rebuild the distributor-SKU snapshot

`scripts/build-distributor-replenishment.py` accepts read-only exports and
produces the deterministic app snapshot. It does not connect to or mutate a
source system itself.

```bash
python3 scripts/build-distributor-replenishment.py \
  --master-po <master-po.json> \
  --stock-workbook <distributor-stock.xlsx> \
  --antize-workbook <antize-physical-count.xlsx> \
  --calculator-items <calculator-items.json> \
  --master-products <ecom-master-products.json> \
  --planning-as-of <ISO-8601-planning-cutoff> \
  --stock-as-of <YYYY-MM-DD> \
  --max-stock-age-days 2 \
  --output app/data/distributor-replenishment.json
```

`--antize-physical-json <extracted-rows.json>` may be used instead of
`--antize-workbook`; the two options are mutually exclusive. Every source file
is fingerprinted in the generated snapshot.

The SKU universe is the union of stock-tracker SKUs and exact-mapped active-PO
SKUs. PO identities that cannot be mapped to a company-qualified SAP SKU remain
separate blocker rows instead of being joined by product-name similarity.

## Current limitations

- August platform targets and forecast upload are not yet available
- 67,807 August PO pieces are blocked from the calculation by mapping or
  planning-row gaps
- Six material shortages remain after assuming current on-order quantities
  arrive
- Factory shifts, physical line overlap, changeovers, minimum runs, and
  approvers still need confirmation
- No active SAP approval template covers the forecast or production order
- Approval and dispatch stages show readiness only; there is no live execution,
  automated release, or source-system write-back
- The current repository uses a dated snapshot; unattended refresh jobs are not
  included
- Distributor-SKU inbound evidence is not yet connected. Unknown inbound is not
  converted to zero; it independently blocks every exact raw need and recommendation
  until a qualified inbound feed supplies either a confirmed quantity or an
  explicitly evidenced zero
- Product identity, UOM, and case-pack evidence is company/schema-qualified.
  The Control Panel calculator export is JIVO_OIL evidence and is never applied
  to a same-code JIVO_MART SKU
- PO lines with blank UOM remain identity blocker rows rather than being treated
  as pieces
- The available distributor stock is dated 16 July 2026, eight days before the
  planning cutoff; it exceeds the two-day freshness gate, so all exact replenishment
  recommendations remain blocked until fresh stock arrives
- Knowtable and Evara opening stock remains unqualified independently of the
  freshness issue

## Technology

React 19, Next.js 16, vinext, Vite, and Cloudflare-compatible hosting.
