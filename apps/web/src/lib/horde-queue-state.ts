export type HordeQueueState =
  | { kind: "queue"; position: number; etaSeconds: number }
  | { kind: "drawing" };

/** Parses the opaque AI Horde state published through image-gen progress. */
export function parseHordeQueueState(state: string | undefined): HordeQueueState | null {
  if (state === "drawing") return { kind: "drawing" };
  const match = /^queue:([1-9]\d*):(\d+)$/.exec(state ?? "");
  if (match === null) return null;
  return { kind: "queue", position: Number(match[1]), etaSeconds: Number(match[2]) };
}
