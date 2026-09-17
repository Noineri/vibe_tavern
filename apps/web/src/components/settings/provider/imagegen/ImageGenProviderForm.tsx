import { useState } from "react";
import { IMAGE_GEN_BACKENDS } from "@vibe-tavern/domain";
import { useT } from "../../../../i18n/context.js";
import {
  getImageGenProviderPreset,
  IMAGE_GEN_PROVIDER_PRESETS,
} from "../../../../provider-presets.js";
import { Icons } from "../../../shared/icons.js";
import { cn } from "../../../../lib/cn.js";
import { DropdownSelect } from "../../../shared/DropdownSelect.js";
import { lblCls } from "../../../../lib/field-tokens.js";
import { TextInput } from "../../../shared/text-input.js";
import { ImageGenApiKeyField } from "./ImageGenApiKeyField.js";
import { ConnectionAutoKeyHint } from "../../../shared/connection-auto-key-hint.js";
import { ConnectionProbeStatus } from "../../../shared/connection-probe-status.js";
import { type ImageGenProfileForm, type useImageProfiles } from "../../../../hooks/use-image-profiles.js";

type ImageGenHook = ReturnType<typeof useImageProfiles>;

/** Level-1 segment: the group of the stored preset, or Custom when no preset
 *  row backs the profile. Derived (never stored) — the profile's source of
 *  truth is `presetId`; switching segments applies rows that rewrite it. */
export type ImageGenProviderSegment = "cloud" | "local" | "custom";

function segmentOf(form: ImageGenProfileForm): ImageGenProviderSegment {
  const preset = form.presetId !== null ? getImageGenProviderPreset(form.presetId) : undefined;
  if (preset && (preset.group === "cloud" || preset.group === "local")) return preset.group;
  return "custom";
}

interface ImageGenProviderFormProps {
  form: ImageGenProfileForm;
  editingId: string | null;
  profiles: ImageGenHook["profiles"];
  updateForm: <K extends keyof ImageGenProfileForm>(k: K, v: ImageGenProfileForm[K]) => void;
  imageGen: ImageGenHook;
}

/** Image-gen level-1 connection card (IMAGE_GENERATION_PLAN IG-11) — fork of
 *  the SttProviderForm structure under the SAME governing rule (owner
 *  2026-09-04): the connection card carries ONLY provider preset, endpoint,
 *  API key, and the connection test. Model/size/sampler tuning is FORBIDDEN
 *  here — it is the level-2 surface (IG-12).
 *
 *  Deviations from the STT twin, each forced by the image-gen v1 scope:
 *  - Segments derive from the roster's groups + Custom — Cloud / Local /
 *    Custom. The design's four-segment taxonomy includes Native, but the
 *    locked v1 roster (plan scope: OpenRouter + Custom cloud + A1111
 *    local) has NO native rows, so the segment does not render (a segment
 *    whose dropdown has zero rows is dead chrome; native joins when a
 *    native adapter lands).
 *  - No endpoint→preset auto-detection: the profile STORES `presetId` (a
 *    wire field STT never had — STT detects by endpoint because its
 *    profile has no preset column). Explicit slug, no guessing.
 *  - Custom is BARE (IG-CF8, owner 2026-09-15 — the SttProviderForm twin
 *    rule: "custom means custom"): endpoint + API key, no preset
 *    rows and no pickers of any kind. The wire backend is an
 *    implementation fact, not a UI choice — a custom profile speaks the
 *    OpenAI-images dialect (the only implemented cloud dialect for custom
 *    endpoints), pinned on segment switch.
 *  - The API-key field always renders: the two cloud rows require keys, and
 *    A1111's key is OPTIONAL (keyless default; `--api-auth "user:pass"`
 *    basic auth) — the preset's `keyOptional` flag carries the hint.
 *  - Test connection rides the DRAFT models route (fetchDraftModels — the
 *    STT P10 pattern: the model catalog IS the reachability proof, and it
 *    works on unsaved drafts; all three v1 adapters expose model listing). */
export function ImageGenProviderForm({ form, editingId, profiles, updateForm, imageGen }: ImageGenProviderFormProps) {
  const { t } = useT();
  const [testOk, setTestOk] = useState<boolean | null>(null);
  const [testing, setTesting] = useState(false);

  const segment = segmentOf(form);
  const segmentOptions: Array<{ value: ImageGenProviderSegment; label: string }> = [
    { value: "cloud", label: "Cloud" },
    { value: "local", label: t("image_gen_segment_local") },
    { value: "custom", label: t("custom") },
  ];

  // Rows of the active group; Custom carries none (bare endpoint + key —
  // IG-CF8, no pickers of any kind).
  const groupPresets =
    segment === "cloud" || segment === "local"
      ? IMAGE_GEN_PROVIDER_PRESETS.filter((p) => p.group === segment)
      : [];

  const selectedPreset = form.presetId !== null ? getImageGenProviderPreset(form.presetId) : undefined;
  const presetId = selectedPreset?.id ?? "";
  const presetEndpoint = selectedPreset?.baseUrl ?? "";
  const keyOptional = selectedPreset?.keyOptional === true;

  const duplicateNameWarning =
    form.name &&
    profiles.some((p) => p.id !== editingId && p.name.trim().toLowerCase() === form.name.trim().toLowerCase());

  /** Preset apply: backend + preset slug + prefilled endpoint in ONE patch.
   *  The hook's backend-switch branch resets presetId/endpoint/key when the
   *  backend CHANGES, then this patch lands its values on top — a
   *  same-backend re-apply keeps the typed key (both siblings' rule). */
  function applyPreset(id: string): void {
    const preset = getImageGenProviderPreset(id);
    if (!preset) return;
    updateForm("backend", preset.backend);
    updateForm("presetId", preset.id);
    updateForm("endpoint", preset.baseUrl);
  }

  function handleSegmentChange(next: string) {
    const seg = next as ImageGenProviderSegment;
    if (seg === segment) return;
    if (seg === "cloud" || seg === "local") {
      // Each group segment applies its first roster row (cloud → OpenRouter,
      // local → A1111-compatible — roster order, never hardcoded ids).
      const first = IMAGE_GEN_PROVIDER_PRESETS.find((p) => p.group === seg);
      if (first) applyPreset(first.id);
      return;
    }
    // Custom (IG-CF8): bare endpoint + key. The backend pins to the
    // OpenAI-images dialect (the hook's backend-switch branch resets the
    // preset slug, endpoint, and key when it differs); presetId drops so
    // the segment stays Custom on re-open.
    updateForm("backend", IMAGE_GEN_BACKENDS.OpenAiImages);
    updateForm("presetId", null);
  }

  async function handleTest(): Promise<void> {
    if (testing) return;
    setTesting(true);
    setTestOk(null);
    try {
      // Probe semantics (P10): the draft model catalog proves key + endpoint
      // + protocol in one round-trip; the just-typed key rides inside the
      // draft config (the STT draft rule). Failures throw → fail badge.
      const models = await imageGen.fetchDraftModels();
      setTestOk(models.length > 0);
    } catch {
      setTestOk(false);
    } finally {
      setTesting(false);
    }
  }

  return (
    <div data-testid="image-gen-provider-form">
      {/* Row 1: profile name + provider-preset segment (the STT twin's
          grid — two form-shaped columns, DropdownSelect's default w-full
          trigger is correct in this slot). */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="mb-3">
          <label className={lblCls}>{t("profile_name")}</label>
          <TextInput
            value={form.name}
            onChange={(e) => updateForm("name", e.target.value)}
            placeholder={t("profile_name_placeholder")}
            data-testid="image-gen-profile-name-input"
          />
          {duplicateNameWarning && (
            <div className="mt-1 flex items-center gap-1 text-[11px] text-warning">
              <span className="[&_svg]:h-[12px] [&_svg]:w-[12px]">
                <Icons.Alert />
              </span>
              {t("profile_name_exists")}
            </div>
          )}
        </div>
        <div className="mb-3">
          <label className={lblCls}>{t("provider_preset_label")}</label>
          <DropdownSelect
            value={segment}
            options={segmentOptions.map((o) => ({ id: o.value, label: o.label }))}
            onChange={handleSegmentChange}
            searchable={false}
            triggerTestId="image-gen-segment-select"
          />
        </div>
      </div>

      {/* Row 2 (cloud/local only): named preset rows + read-only preset
          endpoint. Custom renders NOTHING here — bare endpoint + key
          below (IG-CF8, the SttProviderForm custom arm). */}
      {(segment === "cloud" || segment === "local") && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="mb-3">
            <label className={lblCls}>{t("api_format_label")}</label>
            <DropdownSelect
              value={presetId}
              options={groupPresets.map((p) => ({ id: p.id, label: p.label }))}
              onChange={(val) => {
                if (val) applyPreset(val);
              }}
              triggerTestId="image-gen-preset-select"
            />
          </div>
          <div className="mb-3">
            <label className={lblCls}>{t("preset_endpoint_label")}</label>
            <TextInput value={presetEndpoint || t("custom")} readOnly />
          </div>
        </div>
      )}

      {/* Endpoint — always: all three v1 backends are endpoint-configured
          (cloud rows too: the field shows the preset URL and stays
          user-editable — same-backend preset rows may move it). */}
      <div className="mb-3">
        <label className={lblCls}>{t("image_gen_field_endpoint")}</label>
        <TextInput
          value={form.endpoint}
          onChange={(e) => updateForm("endpoint", e.target.value)}
          placeholder="https://api.openai.com/v1"
          data-testid="image-gen-field-endpoint"
        />
      </div>

      {/* API key — always rendered (cloud rows require it; A1111 optional). */}
      <div className="mb-3">
        <label className={lblCls}>{t("api_key_label")}</label>
        <ImageGenApiKeyField
          value={form.apiKey}
          onChange={(v) => updateForm("apiKey", v)}
          placeholder={t("api_key_placeholder")}
          stored={form.hasStoredApiKey}
        />
        {keyOptional && (
          <div data-testid="image-gen-key-optional-hint" className="mt-1 font-ui text-[11px] text-t3">
            {t("image_gen_key_optional_hint")}
          </div>
        )}
        {/* IG-21 default-on key reuse (the STT SttProviderForm twin): a
            provider profile whose endpoint auto-matches — typing an own key
            above overrides it. Mirror of the server cascade
            (imagegen-form-helpers.ts); a1111 never matches. */}
        {!form.apiKey && !form.hasStoredApiKey && imageGen.draftAutoKeyProviderName !== null && (
          <ConnectionAutoKeyHint
            testId="image-gen-key-source-hint"
            message={t("image_gen_key_from_provider_hint", { name: imageGen.draftAutoKeyProviderName })}
          />
        )}
      </div>

      {/* Test connection card — the STT P10 shape: probe = draft model
          catalog; works on unsaved drafts. */}
      <div className="my-3 rounded-lg border border-border bg-surface p-3.5" data-testid="image-gen-test-card">
        <div>
          <div className="flex">
            <button
              type="button"
              data-testid="image-gen-test-connection-btn"
              className={cn(
                "min-h-11 rounded-md border px-4 py-2 font-ui text-[13px] font-medium transition-colors sm:min-h-0 sm:py-1.5",
                testOk === true
                  ? "border-success/30 bg-success/10 text-success"
                  : testOk === false
                    ? "border-danger/30 bg-danger/10 text-danger"
                    : "border-border bg-s2 text-t2 hover:border-border2 hover:text-t1",
              )}
              onClick={() => void handleTest()}
              disabled={testing}
            >
              {testing ? t("testing") : t("test_connection")}
            </button>
          </div>
          {testOk !== null && (
            <ConnectionProbeStatus
              ok={testOk}
              successTestId="image-gen-test-success"
              failureTestId="image-gen-test-failure"
              successText={t("connection_successful")}
              failureText={t("connection_failed")}
            />
          )}
        </div>
      </div>
    </div>
  );
}
