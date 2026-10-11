import { beforeAll, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

const realI18nContext = await import("../../../i18n/context.js");
mock.module("../../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
}));

let render: typeof import("@testing-library/react").render;
let SceneSchemaReference: typeof import("./scene-schema-reference.js").SceneSchemaReference;
beforeAll(async () => {
  ({ render } = await import("@testing-library/react"));
  ({ SceneSchemaReference } = await import("./scene-schema-reference.js"));
});

describe("SceneSchemaReference", () => {
  it("renders all five node types, the limits, and both DSL snippets", () => {
    const { container } = render(<SceneSchemaReference />);

    const rowCodes = Array.from(container.querySelectorAll("code")).map((code) => code.textContent);
    expect(rowCodes).toEqual(expect.arrayContaining([
      '$type: "string"',
      '$type: "number"',
      '$type: "boolean"',
      '$type: "object"',
      '$type: "array"',
      "depth ≤ 8 · fields/object ≤ 64 · nodes ≤ 256",
    ]));

    const snippets = Array.from(container.querySelectorAll("pre")).map((snippet) => snippet.textContent ?? "");
    expect(snippets).toHaveLength(2);
    expect(snippets[0]).toContain('"tension": { "$type": "number", "min": 0, "max": 10 }');
    expect(snippets[1]).toContain('"toneBy": { "Critical": "danger", "Stable": "success" }');
    expect(container.textContent).toContain("scn_ref_strict_json_desc");
  });

  it("names all four tone tokens and their string-only value map", () => {
    const { container } = render(<SceneSchemaReference />);

    const rowCodes = Array.from(container.querySelectorAll("code")).map((code) => code.textContent);
    expect(rowCodes).toEqual(expect.arrayContaining(["accent", "success", "warning", "danger", "tone", "toneBy"]));
    expect(container.textContent).toContain("scn_ref_tone_by_desc");
    expect(container.textContent).toContain("scn_ref_tone_validation");
  });
});
