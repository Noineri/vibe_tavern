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
 * dual-mode).
 */
export function LorebookEditorView({
  agentPanel,
  children,
  editorHeader,
  isMobile,
}: {
  /** The script editor's agent-mode shell; null renders the plain container. */
  agentPanel: ReactNode;
  children: ReactNode;
  editorHeader: ReactNode;
  isMobile: boolean;
}) {
  return (
    <div className="animate-[lbFadeIn_250ms_ease-out] flex min-h-0 flex-1 flex-col overflow-hidden">
      {editorHeader}
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
