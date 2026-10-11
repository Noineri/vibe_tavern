import { useT } from "../../../i18n/context.js";
import { ApiRefCard, ApiRefCode, ApiRefRow, ApiRefSection } from "./api-reference-parts.js";

export function SceneSchemaReference() {
  const { tDynamic } = useT();

  return (
    <ApiRefCard title={tDynamic("scn_ref_title") || "Scene Schema DSL"}>
      <ApiRefSection heading={tDynamic("scn_ref_nodes") || "1. Node types"}>
        <ApiRefRow code={'$type: "string"'}>— {tDynamic("scn_ref_string_desc") || "A text value."}</ApiRefRow>
        <ApiRefRow code={'$type: "number"'}>— {tDynamic("scn_ref_number_desc") || "A number; add min and max together for a bounded meter."}</ApiRefRow>
        <ApiRefRow code={'$type: "boolean"'}>— {tDynamic("scn_ref_boolean_desc") || "A true or false value."}</ApiRefRow>
        <ApiRefRow code={'$type: "object"'}>— {tDynamic("scn_ref_object_desc") || "A named group with a properties map."}</ApiRefRow>
        <ApiRefRow code={'$type: "array"'}>— {tDynamic("scn_ref_array_desc") || "A homogeneous list with one items template."}</ApiRefRow>
        <ApiRefCode>{`{
  "mood": { "$type": "string", "label": "Mood" },
  "tension": { "$type": "number", "min": 0, "max": 10 },
  "location": {
    "$type": "object",
    "properties": { "room": { "$type": "string" } }
  },
  "tags": { "$type": "array", "items": { "$type": "string" } }
}`}</ApiRefCode>
      </ApiRefSection>

      <ApiRefSection heading={tDynamic("scn_ref_label_limits") || "2. Labels and limits"}>
        <ApiRefRow code="label">— {tDynamic("scn_ref_label_desc") || "Optional on any node; display-only, while the field key stays machine-stable."}</ApiRefRow>
        <ApiRefRow code="depth ≤ 8 · fields/object ≤ 64 · nodes ≤ 256">— {tDynamic("scn_ref_limits_desc") || "Schema limits are validated for the root and every nested object."}</ApiRefRow>
      </ApiRefSection>

      <ApiRefSection heading={tDynamic("scn_ref_tone") || "3. Tone DSL"}>
        <ApiRefRow code="accent">— {tDynamic("scn_ref_accent_desc") || "Highlight an active focus or group."}</ApiRefRow>
        <ApiRefRow code="success">— {tDynamic("scn_ref_success_desc") || "Mark a favorable or completed state."}</ApiRefRow>
        <ApiRefRow code="warning">— {tDynamic("scn_ref_warning_desc") || "Call attention to a caution or rising pressure."}</ApiRefRow>
        <ApiRefRow code="danger">— {tDynamic("scn_ref_danger_desc") || "Mark a harmful or critical state."}</ApiRefRow>
        <ApiRefRow code="tone">— {tDynamic("scn_ref_tone_desc") || "Optional on any node; presentation-only and never changes tracking."}</ApiRefRow>
        <ApiRefRow code="toneBy">— {tDynamic("scn_ref_tone_by_desc") || "STRING nodes only: a closed value-to-tone map; unmapped values stay neutral."}</ApiRefRow>
        <ApiRefRow>— {tDynamic("scn_ref_tone_validation") || "Only these four semantic tokens are valid; hex and unknown names are rejected."}</ApiRefRow>
        <ApiRefCode>{`{
  "status": {
    "$type": "string",
    "toneBy": { "Critical": "danger", "Stable": "success" }
  },
  "health": { "$type": "number", "min": 0, "max": 100, "tone": "warning" },
  "mission": {
    "$type": "object", "tone": "accent",
    "properties": { "active": { "$type": "boolean" } }
  }
}`}</ApiRefCode>
      </ApiRefSection>

      <ApiRefSection heading={tDynamic("scn_ref_strict_json") || "4. Strict JSON"}>
        <ApiRefRow>— {tDynamic("scn_ref_strict_json_desc") || "Unknown keys are rejected; after parsing, the editor names the offending field."}</ApiRefRow>
      </ApiRefSection>
    </ApiRefCard>
  );
}
