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

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function groupReplenishmentRows(rows) {
  const groups = new Map();

  for (const row of rows) {
    const key = row.sapCode
      ? `sap:${row.sapCode}`
      : `unmapped:${row.id}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        id: key,
        grouped: true,
        skuName: row.skuName,
        sapCode: row.sapCode,
        itemHead: row.itemHead,
        category: row.category,
        distributorNames: [],
        distributorName: "",
        distributorCount: 0,
        requiredInventoryPieces: 0,
        unqualifiedRequirementPieces: 0,
        openPoPieces: 0,
        openPoCount: 0,
        poNumbers: [],
        platforms: [],
        qualifiedStockPieces: 0,
        qualifiedStockDistributors: 0,
        liveStockDistributors: 0,
        stockExceptionCount: 0,
        rawNeedPieces: 0,
        recommendedPieces: 0,
        blockedOpenPoPieces: 0,
        status: "no-demand",
      };
      groups.set(key, group);
    }

    group.distributorNames.push(row.distributorName);
    group.distributorCount += 1;
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
      group.qualifiedStockDistributors += 1;
    }
    if (row.liveStockApplied) group.liveStockDistributors += 1;
    if (row.stockStatus?.includes("exception")) group.stockExceptionCount += 1;
    group.rawNeedPieces += numeric(row.rawNeedPieces) ?? 0;
    group.recommendedPieces += numeric(row.recommendedPieces) ?? 0;
    if (row.recommendedPieces === null && (numeric(row.openPoPieces) ?? 0) > 0) {
      group.blockedOpenPoPieces += numeric(row.openPoPieces) ?? 0;
    }
  }

  return [...groups.values()].map((group) => {
    group.distributorNames = unique(group.distributorNames);
    group.distributorName = group.distributorNames.join(", ");
    group.poNumbers = unique(group.poNumbers);
    group.platforms = unique(group.platforms);
    if (!group.sapCode) group.status = "identity-blocked";
    else if (group.blockedOpenPoPieces > 0) group.status = "blocked";
    else if (group.recommendedPieces > 0) group.status = "replenish";
    else if (group.openPoPieces > 0) group.status = "covered";
    return group;
  });
}
