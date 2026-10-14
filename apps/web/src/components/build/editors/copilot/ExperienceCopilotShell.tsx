import type { ReactNode } from "react";
import { useIsMobile } from "../../../../hooks/use-mobile.js";
import type { ScriptRecord } from "../../../../api/types.js";
import { AgentShell } from "../../../shared/agent-shell/AgentShell.js";
import type { ExperienceCopilotHostProps, ExperienceCopilotStep } from "./experience-agent-host.js";
// The experience host registers itself (getAgentHost("experience")) at module
// init — this side-effect import is the shell's ONLY registration, exactly
// once per process (the wrapper and the host module are a pair).
import "./experience-agent-host.js";

/**
 * ExperienceCopilotShell (ER-11d / ER-13b′ / XU-5 / AS-6b2) — the mini-app
 * editor's AI-assistant entry, now a THIN WRAPPER: it maps the editor-facing
 * props onto the generic `AgentShell` (kind "experience") and forwards the
 * host-specific ones opaquely. Everything this surface does lives either in
 * the shared shell (session/chat machinery + the 2-pane / mobile-tabs layout)
 * or in the `experience` host (editor pane + buffer review + send options) —
 * see those files for the behavioral documentation this component used to
 * carry.
 *
 * The public props are UNCHANGED from the pre-split shell so
 * `ExperienceEditor` (its import + mount) is untouched; `creationMode` is
 * still accepted (XU-6, quote 10 deprecated it — the outer toggle is
 * `[Preview | Code | Try]` in BOTH modes) but, as before the split, nothing
 * consumes it.
 */

export type { ExperienceCopilotStep };

export interface ExperienceCopilotShellProps {
  scriptId: string;
  /** SS-7B2: the selected rules script's trust data (origin/firstEnabledAt),
   *  threaded from the editor to the inline playground so its debounced
   *  AUTOMATIC discovery can route through the script execution guard.
   *  Optional — the pre-threading behavior applies when absent. */
  script?: Pick<ScriptRecord, "origin" | "firstEnabledAt"> | null;
  /** Canonical rules buffer (the active script's code). Controlled. */
  rulesCode: string;
  onRulesChange: (code: string) => void;
  /** Canonical visual buffer (the active visual's source). Controlled. */
  visualSource: string;
  onVisualChange: (source: string) => void;
  /** Contextual toolbar rendered BELOW the editor toolbar when the Rules
   *  buffer is active. Optional — undefined renders nothing (no gap). */
  rulesToolbar?: ReactNode;
  /** Contextual toolbar rendered BELOW the editor toolbar when the Visual
   *  buffer is active. Optional — undefined renders nothing (no gap). */
  visualToolbar?: ReactNode;
  /** DEPRECATED (XU-6, quote 10): the outer toggle is `[Preview | Code | Try]`
   *  in BOTH modes, so this no longer changes the shell's tab structure. Kept
   *  for source compatibility (the parent still passes it); not consumed here. */
  creationMode?: boolean;
  /** Reports the shell's current authoring position for the creation stepper
   *  (`rules` / `appearance` / `try`). Optional — unused when the parent renders
   *  no stepper. Fired on mount (initial default) and on every tab switch. */
  onStepChange?: (step: ExperienceCopilotStep) => void;
  /** The copilot profile currently assigned to this experience
   *  (`scripts.copilotProfileId`), or null (built-in seed). Drives the gear
   *  button's profile modal highlight + assignment (CP-8/CP-9). */
  assignedProfileId?: string | null;
  /** E6 (MOBILE_DEFECTS_ROUND_2): back-navigation affordance for the mobile
   *  tab-bar row (a ← chevron left of [Chat][Edit]). The editor's top bar
   *  (which used to carry the back button) is desktop-only now, so without
   *  this leaving the editor from the Chat tab requires a detour through
   *  the Edit tab. Optional — desktop never passes it, mobile-only by design. */
  onBack?: () => void;
  /** E6: management cluster (name / trust / save / duplicate / delete) that
   *  moved OUT of the (now desktop-only) top bar INTO the mobile Edit tab.
   *  Rendered at the top of the edit pane, above the editor toolbar.
   *  Optional — desktop never passes it. */
  editTabHeader?: ReactNode;
  /** E6: the draft needs saving (dirty or save failed) — surfaces as a badge
   *  dot on the Edit tab while the user is on Chat, with a one-shot pulse
   *  on the clean→dirty edge. Mirrors the co-author Doc-tab primitive (CA-14)
   *  but deliberately WITHOUT auto-switch — the user just chose to Apply,
   *  yanking them to the edit tab would be noise. */
  editTabDirty?: boolean;
  /** Optional authoritative save state for the independent live buffers. */
  rulesSaved?: boolean;
  visualSaved?: boolean;
  /** SS-7: «Show in code» — reveal a finding line in the RULES editor
   *  (fresh object per request; switches to Rules when Visual is active). */
  revealRulesLine?: { line: number } | null;
}

export function ExperienceCopilotShell({
  scriptId,
  script,
  rulesCode,
  onRulesChange,
  visualSource,
  onVisualChange,
  rulesToolbar,
  visualToolbar,
  assignedProfileId = null,
  onStepChange,
  onBack,
  editTabHeader,
  editTabDirty = false,
  rulesSaved,
  visualSaved,
  revealRulesLine = null,
}: ExperienceCopilotShellProps) {
  const isMobile = useIsMobile();
  // Host-specific props travel opaquely through the shell; the host narrows
  // the type at its own boundary (see experience-agent-host.tsx).
  const hostProps: ExperienceCopilotHostProps = {
    script,
    rulesCode,
    onRulesChange,
    visualSource,
    onVisualChange,
    rulesToolbar,
    visualToolbar,
    onStepChange,
    revealRulesLine,
    rulesSaved,
    visualSaved,
  };
  return (
    <AgentShell
      kind="experience"
      ownerId={scriptId}
      scriptId={scriptId}
      isMobile={isMobile}
      onBack={onBack}
      editTabDirty={editTabDirty}
      editTabHeader={editTabHeader}
      assignedProfileId={assignedProfileId}
      hostProps={hostProps}
    />
  );
}
