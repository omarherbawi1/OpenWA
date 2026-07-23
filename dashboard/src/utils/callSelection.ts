export function pickSelectedOngoingCallId<TCall extends { id: string }>(
  previous: string | null,
  calls: readonly TCall[],
  seenIncomingIds: ReadonlySet<string>,
  isOngoing: (call: TCall) => boolean,
  isIncoming: (call: TCall) => boolean,
): string | null {
  const ongoing = calls.filter(isOngoing);
  const unseenIncoming = ongoing.find(call => isIncoming(call) && !seenIncomingIds.has(call.id));
  if (unseenIncoming) return unseenIncoming.id;
  if (previous && ongoing.some(call => call.id === previous)) return previous;
  return ongoing[0]?.id ?? null;
}
