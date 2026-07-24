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

## Technology

React 19, Next.js 16, vinext, Vite, and Cloudflare-compatible hosting.
