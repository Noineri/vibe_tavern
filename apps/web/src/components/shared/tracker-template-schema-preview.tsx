import type { SceneTrackerSchemaNode, TrackerTemplate } from "@vibe-tavern/domain";
import { useT } from "../../i18n/context.js";

/**
 * Read-only recursive rendering of a tracker template's scene schema plus its
 * objective items (the character form "Tracker template" accordion body).
 *
 * Visual language mirrors CoauthorTrackerTemplateReview (review card, visual
 * reference only): per-field rows of mono key + `<type> — label`, objective
 * bullet rows of `• description`. Presentation-only: no store access.
 */
export function TrackerTemplateSchemaPreview({ template }: { template: TrackerTemplate }) {
  const sceneSchema = template.scene?.config.schema;
  const objective = template.objective;
  const objectiveItems = objective?.state.mode === "route"
    ? objective.state.tasks
    : (objective?.state.shortTermGoals ?? []);

  return (
    <div>
      {sceneSchema
        && Object.entries(sceneSchema).map(([key, node]) => (
          <SchemaNodeRow key={key} nodeKey={key} node={node} />
        ))}
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
