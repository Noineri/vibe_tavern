import type { TrackerTemplate } from "@vibe-tavern/domain";
import type { TFunc } from "../i18n/locale-helpers.js";

/** Returns the compact, localized character-editor summary for a tracker template. */
export function describeTrackerTemplate(template: TrackerTemplate, t: TFunc): string {
  const parts: string[] = [];

  if (template.scene) {
    const count = Object.keys(template.scene.config.schema).length;
    parts.push(t("character_tracker_template_scene", { count, n: count }));
  }

  if (template.objective) {
    const { mode } = template.objective.state;
    const count = mode === "route"
      ? template.objective.state.tasks.length
      : template.objective.state.shortTermGoals.length;
    const modeLabel = t(mode === "route"
      ? "character_tracker_template_mode_route"
      : "character_tracker_template_mode_goals");
    parts.push(t("character_tracker_template_objective", { mode: modeLabel, count, n: count }));
  }

  return parts.join(" · ");
}
