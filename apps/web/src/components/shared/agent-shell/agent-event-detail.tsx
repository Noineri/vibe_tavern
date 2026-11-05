import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { AgentEventDetailResponse } from "@vibe-tavern/api-contracts";
import { AgentFeedStaleError, type getAgentEventDetail } from "../../../api/agent-feed-api.js";
import { RpcError } from "../../../api/unwrap.js";
import { useT } from "../../../i18n/context.js";
import { agentEventDetailCache, agentEventDetailKey, type AgentEventDetailCache } from "./agent-event-detail-cache.js";
import { useOptionalAgentFeedUiStateStore } from "./agent-feed-ui-state.js";
import { agentFeedEventUnitId } from "./agent-feed-window.js";

export interface AgentEventDetailSource {
  threadId: string;
  epoch: number;
  loadDetail: typeof getAgentEventDetail;
  onStale?: (epoch: number) => void;
  /** T1 seam; production consumers share the one module cache. */
  cache?: AgentEventDetailCache;
}
const DetailContext = createContext<AgentEventDetailSource | null>(null);
export function AgentEventDetailProvider({ source, children }: { source: AgentEventDetailSource; children: ReactNode }) {
  return <DetailContext.Provider value={source}>{children}</DetailContext.Provider>;
}
export function useAgentEventDetailSource(): AgentEventDetailSource | null {
  return useContext(DetailContext);
}

// Existing compact-action canon, shared by retry and continuation controls.
const ACTION = "flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t2 transition-all hover:bg-s2 hover:text-t1";
type PageRenderer = (page: AgentEventDetailResponse) => ReactNode;

/** Mounted only inside an OPEN disclosure. Local state retains cursor strings
 * alone; frozen arrays belong to the shared cache, with no second body store. */
export function AgentEventDetail({ source, eventId, renderPage }: { source: AgentEventDetailSource; eventId: string; renderPage: PageRenderer }) {
  const store = useOptionalAgentFeedUiStateStore();
  const stateKey = agentFeedEventUnitId(eventId);
  const [cursors, setCursors] = useState<(string | undefined)[]>(() => {
    const saved = store?.getRowState(stateKey)?.detailPages;
    return [undefined, ...(saved?.epoch === source.epoch ? saved.cursors : [])];
  });
  const latestCursors = useRef(cursors);
  const append = useCallback((cursor: string) => {
    if (latestCursors.current.includes(cursor)) return;
    const next = [...latestCursors.current, cursor];
    latestCursors.current = next;
    setCursors(next);
    store?.setRowState(stateKey, { detailPages: { epoch: source.epoch, cursors: next.filter((value): value is string => value !== undefined) } });
  }, [store, stateKey, source.epoch]);
  return <div className="flex flex-col gap-2">
    {cursors.map((cursor, index) => <DetailPage key={cursor ?? "first"} source={source} eventId={eventId} cursor={cursor}
      last={index === cursors.length - 1} onMore={append} renderPage={renderPage} />)}
  </div>;
}

function DetailPage({ source, eventId, cursor, last, onMore, renderPage }: {
  source: AgentEventDetailSource; eventId: string; cursor?: string; last: boolean; onMore: (cursor: string) => void; renderPage: PageRenderer;
}) {
  const { t } = useT();
  const cache = source.cache ?? agentEventDetailCache;
  const key = { threadId: source.threadId, eventId, epoch: source.epoch, cursor };
  const identity = agentEventDetailKey(key);
  const subscribe = useCallback((listener: () => void) => cache.subscribe(key, source.loadDetail, listener), [cache, identity, source.loadDetail]);
  const snapshot = useSyncExternalStore(subscribe, useCallback(() => cache.getSnapshot(key), [cache, identity]));
  const notified = useRef<string | null>(null);
  useEffect(() => {
    if (snapshot.error instanceof AgentFeedStaleError && notified.current !== identity) {
      notified.current = identity;
      source.onStale?.(snapshot.error.historyEpoch);
    }
  }, [snapshot, identity, source.onStale]);
  if (snapshot.status === "loading") return <p role="status">{t("agent_event_detail_loading")}</p>;
  if (snapshot.status === "error") {
    const stale = snapshot.error instanceof AgentFeedStaleError;
    const unavailable = snapshot.error instanceof RpcError && [404, 422].includes(snapshot.error.status);
    return <div className="flex flex-col items-start gap-2">
      <p role="alert">{t(stale ? "agent_event_detail_stale" : unavailable ? "agent_event_detail_unavailable" : "agent_event_detail_error")}</p>
      {!unavailable && <button type="button" className={ACTION} onClick={() => cache.retry(key, source.loadDetail)}>{t("agent_event_detail_retry")}</button>}
    </div>;
  }
  const page = snapshot.page;
  if (!page) return null;
  return <>
    {renderPage(page)}
    {last && page.nextCursor !== null && <button type="button" className={ACTION} onClick={() => onMore(page.nextCursor!)}>{t("agent_event_detail_more")}</button>}
  </>;
}
