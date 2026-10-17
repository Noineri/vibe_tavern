import type { ReactNode } from "react";

/**
 * The World & Lore editor view's body (extracted from LorebookEditor for the
 * arch-gate file ratchet, AS-8b): the editor header row plus the plain padded
 * scroll container — OR, when the script editor is in agent mode, the agent
 * shell at the FULL remaining height, unpadded (the AgentShell 2-pane /
 * mobile-tabs layout — the ExperienceEditor container approach; a padded
 * scrolling parent would squeeze the panes and double-scroll). Mobile and
 * desktop differ only in the padding/scroll shape of the plain container;
 * the agent branch is viewport-uniform (the shell owns its responsive
 * dual-mode). The agent panel carries its own back control (first in the
 * bar on desktop, the shell's tab-row chevron on mobile, AS-8c4d), so the
 * header row is skipped then — a whole row for one caret would only cost
 * height; lore entries keep their header row (the view renders it whenever
 * there is no agent panel).
 */
export function LorebookEditorView({
  agentPanel,
  children,
  editorHeader,
  isMobile,
}: {
  /** The always-on script assistant panel; null renders the header row plus the plain container. */
  agentPanel: ReactNode;
  children: ReactNode;
  editorHeader: ReactNode;
  isMobile: boolean;
}) {
  return (
    <div className="animate-[lbFadeIn_250ms_ease-out] flex min-h-0 flex-1 flex-col overflow-hidden">
      {agentPanel == null && editorHeader}
      {agentPanel ?? (isMobile ? (
        <div
          className="min-h-0 flex-1 overflow-y-auto"
          style={{
            padding: "12px",
            paddingBottom:
              "calc(2rem + env(safe-area-inset-bottom, 0px))",
            WebkitOverflowScrolling: "touch",
            overflowAnchor: "none",
          }}
        >
          {children}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div
            className="min-h-0 flex-1 overflow-y-auto"
            style={{ padding: "24px 32px" }}
          >
            {children}
          </div>
        </div>
      ))}
    </div>
  );
}
