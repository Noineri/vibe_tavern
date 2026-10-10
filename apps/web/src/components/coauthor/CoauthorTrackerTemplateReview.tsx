import type { CoauthorTrackerTemplateOutput } from "@vibe-tavern/api-contracts";
import type { SceneTrackerSchemaNode, TrackerTemplate } from "@vibe-tavern/domain";
import { DEFAULT_SCENE_TRACKER_CONFIG } from "@vibe-tavern/domain";
import { Checkbox } from "../shared/Checkbox.js";
import { TrackerTemplatePromptBlocks } from "../shared/tracker-template-schema-preview.js";
import { describeTrackerTemplate } from "../../hooks/describe-tracker-template.js";
import type { TFunc } from "../../i18n/context.js";

export interface CoauthorTrackerTemplateReviewLabels {
  title: string;
  defaults: string;
  current: string;
  noCurrent: string;
  scene: (count: number) => string;
  objectives: (mode: string, count: number) => string;
  settings: Record<string, string>;
  types: Record<SceneTrackerSchemaNode["$type"], string>;
  enabled: string;
  disabled: string;
}

interface CoauthorTrackerTemplateReviewProps {
  template: CoauthorTrackerTemplateOutput["trackerTemplate"];
  summary: string;
  currentTemplate: TrackerTemplate | null;
  selected: boolean;
  applying: boolean;
  onToggle: () => void;
  labels: CoauthorTrackerTemplateReviewLabels;
  t: TFunc;
}

const SCENE_DIFF_SETTING_KEYS = [
  "autoMode",
  "contextWindow",
  "continuityLastN",
  "injectionDepth",
  "injectLastN",
  "promptFormat",
] as const;

function settingValue(value: string | number | boolean, labels: CoauthorTrackerTemplateReviewLabels): string {
  if (value === true) return labels.enabled;
  if (value === false) return labels.disabled;
  return String(value || "—");
}

export function CoauthorTrackerTemplateReview({
  template,
  summary,
  currentTemplate,
  selected,
  applying,
  onToggle,
  labels,
  t,
}: CoauthorTrackerTemplateReviewProps) {
  const scene = template.scene;
  const objective = template.objective;
  const objectiveItems = objective?.state.mode === "route"
    ? objective.state.tasks
    : (objective?.state.shortTermGoals ?? []);

  return (
    <div className="mx-3 rounded-lg border border-border bg-s2 px-4 py-3">
      <div className="flex items-center gap-2.5">
        <Checkbox checked={selected} disabled={applying} onChange={onToggle} />
        <span className="font-ui text-[calc(var(--ui-fs)-1px)] font-semibold text-t1">{labels.title}</span>
      </div>
      <p className="mt-2 font-ui text-[calc(var(--ui-fs)-2px)] leading-relaxed text-t3">{summary}</p>

      {scene && (
        <>
          <div className="mt-2.5 font-ui text-[calc(var(--ui-fs)-3px)] font-semibold uppercase tracking-[0.05em] text-t3">
            {labels.scene(Object.keys(scene.config.schema).length)}
          </div>
          <div className="mt-1">
            {Object.entries(scene.config.schema).map(([key, node]) => (
              <div key={key} className="flex gap-2 font-ui text-[calc(var(--ui-fs)-2px)] leading-relaxed">
                <code className="min-w-24 font-mono text-t2">{key}</code>
                <span className="text-t3">
                  {labels.types[node.$type]}{node.label ? ` — ${node.label}` : ""}
                </span>
              </div>
            ))}
          </div>
          {SCENE_DIFF_SETTING_KEYS.some((key) => scene.config[key] !== DEFAULT_SCENE_TRACKER_CONFIG[key]) && (
            <>
              <div className="mt-2.5 font-ui text-[calc(var(--ui-fs)-3px)] font-semibold uppercase tracking-[0.05em] text-t3">
                {labels.defaults}
              </div>
              <div className="mt-1">
                {SCENE_DIFF_SETTING_KEYS.map((key) => {
                  const value = scene.config[key];
                  const defaultValue = DEFAULT_SCENE_TRACKER_CONFIG[key];
                  if (value === defaultValue) return null;
                  return (
                    <div key={key} className="flex gap-2 font-ui text-[calc(var(--ui-fs)-2px)] leading-relaxed">
                      <span className="min-w-24 text-t2">{labels.settings[key]}</span>
                      <span className="text-t3">
                        {settingValue(value, labels)} ({t("coauthor.tracker_template.review.was", { value: settingValue(defaultValue, labels) })})
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
          <TrackerTemplatePromptBlocks prompts={[
            { label: t("tracker_template_prompt_scene_generate"), value: scene.config.generatePrompt },
            { label: t("tracker_template_prompt_scene_rules"), value: scene.config.rulesPrompt },
            { label: t("tracker_template_prompt_scene_inject"), value: scene.config.injectPrompt },
          ]} />
        </>
      )}

      {objective && (
        <>
          <div className="mt-2.5 font-ui text-[calc(var(--ui-fs)-3px)] font-semibold uppercase tracking-[0.05em] text-t3">
            {labels.objectives(
              t(objective.state.mode === "route" ? "character_tracker_template_mode_route" : "character_tracker_template_mode_goals"),
              objectiveItems.length,
            )}
          </div>
          <div className="mt-1 flex flex-col gap-0.5">
            {objectiveItems.map((item) => (
              <div key={item.id} className="flex gap-1.5 font-ui text-[calc(var(--ui-fs)-2px)] leading-relaxed text-t2">
                <span className="text-t3">•</span>
                <span>{item.description}</span>
              </div>
            ))}
          </div>
          {objective.state.mode === "goals" && objective.state.longTermGoal && (
            <div className="mt-2 font-ui text-[calc(var(--ui-fs)-2px)] leading-relaxed">
              <div className="font-ui text-[calc(var(--ui-fs)-3px)] font-semibold uppercase tracking-[0.05em] text-t3">
                {t("tracker_template_long_term_goal")}
              </div>
              <div className="text-t2">{objective.state.longTermGoal.description}</div>
            </div>
          )}
          <TrackerTemplatePromptBlocks prompts={[
            { label: t("tracker_template_prompt_objective_generate"), value: objective.state.generatePrompt },
            { label: t("tracker_template_prompt_objective_check"), value: objective.state.checkPrompt },
            { label: t("tracker_template_prompt_objective_inject"), value: objective.state.injectPrompt },
          ]} />
        </>
      )}

      <div className="mt-3 border-t border-border pt-2.5 font-ui text-[calc(var(--ui-fs)-2px)] text-t3">
        {labels.current}: {currentTemplate ? describeTrackerTemplate(currentTemplate, t) : labels.noCurrent}
      </div>
    </div>
  );
}
