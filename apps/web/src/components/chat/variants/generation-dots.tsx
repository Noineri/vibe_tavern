/**
 * Three-dot "generating…" indicator. Used by the MessageBlock main body
 * (streaming placeholder while awaiting the first token) and by
 * PendingAssistantMessage. Pure presentational, no deps.
 */
export function GenerationDots(props: { label: string }) {
  return (
    <span className="inline-flex items-center gap-[3px] ml-[3px] align-middle" aria-label={props.label}>
      <span className="h-1 w-1 rounded-full bg-accent animate-genp" />
      <span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.18s]" />
      <span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.36s]" />
    </span>
  );
}
