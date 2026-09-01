export function validateCompleteWorkOrder(
  currentWorkIds: string[],
  requestedWorkIds: string[]
): string | null {
  if (new Set(requestedWorkIds).size !== requestedWorkIds.length) {
    return "Work order contains duplicate IDs";
  }
  if (currentWorkIds.length !== requestedWorkIds.length) {
    return "Current Work changed; refresh before reordering";
  }
  const requested = new Set(requestedWorkIds);
  if (currentWorkIds.some((id) => !requested.has(id))) {
    return "Work order contains missing or inaccessible IDs";
  }
  return null;
}