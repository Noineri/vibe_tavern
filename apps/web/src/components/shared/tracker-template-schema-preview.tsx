import type { SceneTrackerSchemaNode, TrackerTemplate } from "@vibe-tavern/domain";
import { useT } from "../../i18n/context.js";

export interface TrackerTemplatePrompt {
  label: string;
  value: string;
}

/** Read-only authored-prompt blocks shared by tracker-template review surfaces. */
export function TrackerTemplatePromptBlocks({ prompts }: { prompts: readonly TrackerTemplatePrompt[] }) {
  const authoredPrompts = prompts.filter(({ value }) => value !== "");
  if (authoredPrompts.length === 0) return null;

  return (
    <div className="mt-2 flex flex-col gap-2">
      {authoredPrompts.map(({ label, value }) => (
        <div key={label}>
          <div className="font-ui text-[calc(var(--ui-fs)-3px)] font-semibold uppercase tracking-[0.05em] text-t3">
            {label}
          </div>
          <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-s2 p-2 font-mono text-[calc(var(--ui-fs)-2px)] leading-relaxed text-t2">
            {value}
          </pre>
        </div>
      ))}
    </div>
  );
}

/**
 * Read-only recursive rendering of a tracker template's scene schema plus its
 * objective items (the character form "Tracker template" accordion body).
 *
 * Visual language mirrors CoauthorTrackerTemplateReview (review card, visual
 * reference only): per-field rows of mono key + `<type> — label`, objective
 * bullet rows of `• description`. Presentation-only: no store access.
 */
export function TrackerTemplateSchemaPreview({ template }: { template: TrackerTemplate }) {
  const { t } = useT();
  const scene = template.scene;
  const objective = template.objective;
  const objectiveItems = objective?.state.mode === "route"
    ? objective.state.tasks
    : (objective?.state.shortTermGoals ?? []);

  return (
    <div>
      {scene && (
        <>
          {Object.entries(scene.config.schema).map(([key, node]) => (
            <SchemaNodeRow key={key} nodeKey={key} node={node} />
          ))}
          <TrackerTemplatePromptBlocks prompts={[
            { label: t("tracker_template_prompt_scene_generate"), value: scene.config.generatePrompt },
            { label: t("tracker_template_prompt_scene_rules"), value: scene.config.rulesPrompt },
            { label: t("tracker_template_prompt_scene_inject"), value: scene.config.injectPrompt },
          ]} />
        </>
      )}
      {objective && (
        <>
          {objectiveItems.length > 0 && (
            <div className="mt-1 flex flex-col gap-0.5">
              {objectiveItems.map((item) => (
                <div key={item.id} className="flex gap-1.5 font-ui text-[calc(var(--ui-fs)-2px)] leading-relaxed text-t2">
                  <span className="text-t3">•</span>
                  <span>{item.description}</span>
                </div>
              ))}
            </div>
          )}
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
    </div>
  );
}

function SchemaNodeRow({ nodeKey, node }: { nodeKey: string; node: SceneTrackerSchemaNode }) {
  const { t } = useT();
  const typeLabel = t(`tracker_template_type_${node.$type}`);
  const range = node.$type === "number" && typeof node.min === "number" && typeof node.max === "number"
    ? ` ${node.min}–${node.max}`
    : "";
  return (
    <>
      <div className="flex gap-2 font-ui text-[calc(var(--ui-fs)-2px)] leading-relaxed">
        <code className="min-w-24 font-mono text-t2">{nodeKey}</code>
        <span className="text-t3">
          {typeLabel}
          {range}
          {node.label ? ` — ${node.label}` : ""}
        </span>
      </div>
      {node.$type === "object" && (
        <div className="ml-4">
          {Object.entries(node.properties).map(([key, child]) => (
            <SchemaNodeRow key={key} nodeKey={key} node={child} />
          ))}
        </div>
      )}
      {node.$type === "array" && (
        <div className="ml-4">
          <ArrayItemsRow node={node.items} />
        </div>
      )}
    </>
  );
}

/** Array item template: object items expose their properties directly; a leaf
 *  (or nested array) item renders as one indented `[]` row, recursing. */
function ArrayItemsRow({ node }: { node: SceneTrackerSchemaNode }) {
  if (node.$type === "object") {
    return (
      <>
        {Object.entries(node.properties).map(([key, child]) => (
          <SchemaNodeRow key={key} nodeKey={key} node={child} />
        ))}
      </>
    );
  }
  return <SchemaNodeRow nodeKey="[]" node={node} />;
}
