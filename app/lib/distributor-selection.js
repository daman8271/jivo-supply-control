export function toggleDistributorSelection(selectedIds, distributorId) {
  return selectedIds.includes(distributorId)
    ? selectedIds.filter((item) => item !== distributorId)
    : [...selectedIds, distributorId];
}

export function selectAllDistributors(distributors) {
  return distributors.map((item) => item.id);
}

export function clearDistributorSelection() {
  return [];
}
