import type { PromptTraceRecordDto } from "@rp-platform/api-contracts";
import type { SidePanel as SidePanelState } from "./app-shell-types.js";
import { formatTraceTimestamp } from "./app-shell-helpers.js";
import { Icons } from "./shared/icons.js";

interface SidePanelProps {
  panel: SidePanelState;
  activePromptTrace: PromptTraceRecordDto | null;
  promptTraceHistory: PromptTraceRecordDto[];
  promptPayloadText: string;
  onClose: () => void;
  onSelectTrace: (traceId: string) => void;
}

export function SidePanel(input: SidePanelProps) {
  if (input.panel === "closed") {
    return null;
  }

  return (
    <aside className="side-panel">
      <div className="side-panel-head">
        <div>
          <div className="sidebar-label">Trace</div>
          <div className="side-panel-title">Prompt assembly</div>
        </div>
        <button className="icon-btn" aria-label="Close panel" title="Close panel" onClick={input.onClose}>
          <Icons.Close />
        </button>
      </div>

      <TracePanel {...input} />
    </aside>
  );
}

function TracePanel(input: SidePanelProps) {
  return (
    <div className="side-panel-body">
      <div className="trace-stats">
        <div className="stat-card">
          <span className="sidebar-meta">Layers</span>
          <strong>{input.activePromptTrace?.layers.length ?? 0}</strong>
        </div>
        <div className="stat-card">
          <span className="sidebar-meta">Lore</span>
          <strong>{input.activePromptTrace?.activatedLoreEntries.length ?? 0}</strong>
        </div>
        <div className="stat-card">
          <span className="sidebar-meta">Memory</span>
          <strong>{input.activePromptTrace?.retrievedMemories.length ?? 0}</strong>
        </div>
      </div>

      <div className="sidebar-label">History</div>
      <div className="trace-list">
        {input.promptTraceHistory.map((trace) => (
          <button
            key={trace.id}
            className={`chat-card${trace.id === input.activePromptTrace?.id ? " active" : ""}`}
            onClick={() => input.onSelectTrace(trace.id)}
          >
            <span className="sidebar-title">{formatTraceTimestamp(trace.createdAt)}</span>
            <span className="sidebar-meta">
              {trace.model} - {trace.latencyMs} ms
            </span>
            <span className="sidebar-meta faint">
              {trace.layers.length} layers - {trace.tokenAccounting.total ?? 0} tok
            </span>
          </button>
        ))}
      </div>

      <div className="trace-list">
        {(input.activePromptTrace?.layers ?? []).map((layer) => (
          <article key={layer.id} className="trace-item">
            <div className="trace-item-head">
              <span>{layer.sourceType}</span>
              <span>{layer.tokenCount} tok</span>
            </div>
            <div className="trace-item-title">{layer.id}</div>
            <div className="trace-item-body">{layer.text}</div>
          </article>
        ))}
      </div>

      <div className="sidebar-label">Payload</div>
      <pre className="payload-box">{input.promptPayloadText}</pre>
    </div>
  );
}
