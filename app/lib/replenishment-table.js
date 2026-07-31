const STATUS_RANK = {
  "identity-blocked": 6,
  blocked: 5,
  review: 4,
  replenish: 3,
  covered: 2,
  "no-demand": 1,
};

function numeric(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function replenishmentSortValue(row, key) {
  if (key === "identity") {
    return `${row.skuName ?? ""}\u0000${row.distributorName ?? ""}`.toLocaleLowerCase();
  }
  if (key === "required") {
    return numeric(row.requiredInventoryPieces ?? row.unqualifiedRequirementPieces);
  }
  if (key === "openPo") return numeric(row.openPoPieces);
  if (key === "stock") {
    return numeric(row.qualifiedStockPieces ?? row.evidencedStockPieces);
  }
  if (key === "ownOnHand") return numeric(row.ownOnHandPieces);
  if (key === "msl") return numeric(row.mslPieces);
  if (key === "need") {
    return numeric(row.recommendedPieces ?? row.rawNeedPieces ?? row.blockedOpenPoPieces);
  }
  if (key === "status") return STATUS_RANK[row.status] ?? 0;
  return null;
}

export function sortReplenishmentRows(rows, { key, direction }) {
  const multiplier = direction === "asc" ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, value: replenishmentSortValue(row, key) }))
    .sort((left, right) => {
      const leftMissing = left.value === null || left.value === undefined || left.value === "";
      const rightMissing = right.value === null || right.value === undefined || right.value === "";
      if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
      if (leftMissing && rightMissing) return left.index - right.index;
      if (typeof left.value === "string" && typeof right.value === "string") {
        const compared = left.value.localeCompare(right.value, "en", {
          numeric: true,
          sensitivity: "base",
        });
        return compared === 0 ? left.index - right.index : compared * multiplier;
      }
      const compared = Number(left.value) - Number(right.value);
      return compared === 0 ? left.index - right.index : compared * multiplier;
    })
    .map(({ row }) => row);
}

export function attachOwnInventoryMetrics(rows, inventoryRows, mslValues) {
  const inventoryByCode = new Map(
    inventoryRows.map((row) => [row.sapCode, numeric(row.onHand)]),
  );
  return rows.map((row) => ({
    ...row,
    ownOnHandPieces:
      row.sapCode && inventoryByCode.has(row.sapCode)
        ? inventoryByCode.get(row.sapCode)
        : null,
    mslPieces:
      row.sapCode && Object.prototype.hasOwnProperty.call(mslValues, row.sapCode)
        ? numeric(mslValues[row.sapCode])
        : null,
  }));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizedSkuLabel(value) {
  return String(value ?? "unknown").trim().toLocaleLowerCase();
}

export function groupReplenishmentRows(rows) {
  const groups = new Map();
  const canonicalCodesByLabel = new Map();
  const canonicalRowsByCode = new Map();

  for (const row of rows) {
    if (!row.sapCode) continue;
    const label = normalizedSkuLabel(row.skuName);
    if (!canonicalCodesByLabel.has(label)) canonicalCodesByLabel.set(label, new Set());
    canonicalCodesByLabel.get(label).add(row.sapCode);
    if (!canonicalRowsByCode.has(row.sapCode)) canonicalRowsByCode.set(row.sapCode, row);
  }

  for (const row of rows) {
    const label = normalizedSkuLabel(row.skuName);
    const exactLabelCodes = canonicalCodesByLabel.get(label) ?? new Set();
    const exactAliasCode = !row.sapCode && exactLabelCodes.size === 1
      ? [...exactLabelCodes][0]
      : null;
    const groupCode = row.sapCode ?? exactAliasCode;
    const key = groupCode ? `sap:${groupCode}` : `label:${label}`;
    const exemplar = groupCode ? canonicalRowsByCode.get(groupCode) ?? row : row;
    let group = groups.get(key);
    if (!group) {
      group = {
        id: key,
        grouped: true,
        skuName: exemplar.skuName,
        sapCode: groupCode,
        itemHead: exemplar.itemHead,
        category: exemplar.category,
        distributorNames: [],
        distributorName: "",
        distributorCount: 0,
        rowCount: 0,
        exactLabelAliasRows: 0,
        requiredInventoryPieces: 0,
        unqualifiedRequirementPieces: 0,
        openPoPieces: 0,
        openPoCount: 0,
        poNumbers: [],
        platforms: [],
        qualifiedStockPieces: 0,
        qualifiedStockDistributorNames: [],
        qualifiedStockDistributors: 0,
        liveStockDistributorNames: [],
        liveStockDistributors: 0,
        stockExceptionCount: 0,
        rawNeedPieces: 0,
        recommendedPieces: 0,
        blockedOpenPoPieces: 0,
        status: "no-demand",
        details: [],
      };
      groups.set(key, group);
    }

    group.distributorNames.push(row.distributorName);
    group.rowCount += 1;
    if (!row.sapCode && exactAliasCode) group.exactLabelAliasRows += 1;
    group.requiredInventoryPieces += numeric(row.requiredInventoryPieces) ?? 0;
    group.unqualifiedRequirementPieces += numeric(
      row.unqualifiedRequirementPieces ?? row.unqualifiedLastMonthPoPieces,
    ) ?? 0;
    group.openPoPieces += numeric(row.openPoPieces) ?? 0;
    group.openPoCount += numeric(row.openPoCount) ?? 0;
    group.poNumbers.push(...(row.poNumbers ?? []));
    group.platforms.push(...(row.platforms ?? []));
    if (row.stockQualified && numeric(row.evidencedStockPieces) !== null) {
      group.qualifiedStockPieces += numeric(row.evidencedStockPieces) ?? 0;
      group.qualifiedStockDistributorNames.push(row.distributorName);
    }
    if (row.liveStockApplied) group.liveStockDistributorNames.push(row.distributorName);
    if (row.stockStatus?.includes("exception")) group.stockExceptionCount += 1;
    group.rawNeedPieces += numeric(row.rawNeedPieces) ?? 0;
    group.recommendedPieces += numeric(row.recommendedPieces) ?? 0;
    if (row.recommendedPieces === null && (numeric(row.openPoPieces) ?? 0) > 0) {
      group.blockedOpenPoPieces += numeric(row.openPoPieces) ?? 0;
    }
    group.details.push({
      id: row.id,
      distributorName: row.distributorName,
      sapCode: row.sapCode,
      identityType: row.sapCode
        ? "canonical"
        : exactAliasCode
          ? "exact-label-alias"
          : "unresolved",
      openPoPieces: numeric(row.openPoPieces) ?? 0,
      openPoCount: numeric(row.openPoCount) ?? 0,
      platforms: unique(row.platforms ?? []),
      poNumbers: unique(row.poNumbers ?? []),
      evidencedStockPieces: row.stockQualified
        ? numeric(row.evidencedStockPieces)
        : null,
      stockStatus: row.stockStatus,
      status: row.status,
      blocker: row.blocker,
    });
  }

  return [...groups.values()].map((group) => {
    group.distributorNames = unique(group.distributorNames);
    group.distributorCount = group.distributorNames.length;
    group.distributorName = group.distributorNames.join(", ");
    group.poNumbers = unique(group.poNumbers);
    group.platforms = unique(group.platforms);
    group.qualifiedStockDistributors = unique(
      group.qualifiedStockDistributorNames,
    ).length;
    group.liveStockDistributors = unique(group.liveStockDistributorNames).length;
    delete group.qualifiedStockDistributorNames;
    delete group.liveStockDistributorNames;
    if (!group.sapCode) group.status = "identity-blocked";
    else if (group.blockedOpenPoPieces > 0) group.status = "blocked";
    else if (group.recommendedPieces > 0) group.status = "replenish";
    else if (group.openPoPieces > 0) group.status = "covered";
    group.details = sortReplenishmentRows(group.details, {
      key: "openPo",
      direction: "desc",
    });
    return group;
  });
}
