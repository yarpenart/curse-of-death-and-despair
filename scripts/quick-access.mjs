export function hasAssignedCurseAccess({
  isGM = false,
  victimActorIds = [],
  getActor,
  ownsActor
} = {}) {
  if (isGM) return true;
  if (!Array.isArray(victimActorIds) || typeof getActor !== "function" || typeof ownsActor !== "function") {
    return false;
  }
  return victimActorIds.some((actorId) => {
    const actor = getActor(actorId);
    return Boolean(actor && ownsActor(actor));
  });
}
