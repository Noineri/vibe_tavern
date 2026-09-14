import { useState } from "react";
import { useT } from "../../../../i18n/context.js";
import { ImageGenProviderForm } from "./ImageGenProviderForm.js";
import { ImageGenBaseCard } from "./ImageGenBaseCard.js";
import { ImageGenPane } from "./ImageGenPane.js";
import { ConnectionProbeStatus } from "../../../shared/connection-probe-status.js";
import { Icons } from "../../../shared/icons.js";
import type { ImageGenProfileForm, useImageProfiles } from "../../../../hooks/use-image-profiles.js";

type ImageGenHook = ReturnType<typeof useImageProfiles>;

/** Image-gen profile editor (IMAGE_GENERATION_PLAN IG-11) — fork of the
 *  SttProfileEditor structure: edit mode renders the level-1 connection
 *  form; view mode renders the base card plus the SAVED-profile connection
 *  actions (Probe + Fetch models — the plan's IG-11 scope). The level-2
 *  surface (model picker, per-mode sizes, samplers — IG-12) mounts below
 *  the base card in a later unit; nothing here pre-empts it.
 *
 *  Probe vs Test-connection (both in the plan row, distinct seams):
 *  - Test connection (edit mode) rides the DRAFT models route — works on
 *    unsaved drafts, the STT P10 pattern (inside ImageGenProviderForm).
 *  - Probe (view mode) hits the SAVED profile's probe route — the hook has
 *    no draft probe in v1, so the button renders for saved profiles only
 *    (form.id !== null — always true in view mode).
 *  - Fetch models (view mode) populates the per-profile cache the IG-12
 *    picker will consume; fail-closed auth — the error shows inline. */
export function ImageGenProfileEditor({ imageGen }: { imageGen: ImageGenHook }) {
  const { t } = useT();
  const savedProfile =
    imageGen.editingId !== null ? (imageGen.profiles.find((p) => p.id === imageGen.editingId) ?? null) : null;
  const isView = imageGen.headerMode === "view" && savedProfile !== null;

  const [probing, setProbing] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelsFetchError, setModelsFetchError] = useState<string | null>(null);
  const [modelsCount, setModelsCount] = useState<number | null>(null);

  if (!imageGen.form) return null;

  const form: ImageGenProfileForm = imageGen.form;
  const isEdit = imageGen.headerMode === "edit";

  function handleUpdateForm<K extends keyof ImageGenProfileForm>(k: K, v: ImageGenProfileForm[K]): void {
    // Generic computed-key object can't be proven assignable — scoped cast
    // (the SttProfileEditor twin).
    imageGen.setForm({ [k]: v } as Pick<ImageGenProfileForm, K>);
  }

  async function handleProbe(): Promise<void> {
    if (probing || form.id === null) return;
    setProbing(true);
    try {
      await imageGen.probeSaved();
    } finally {
      setProbing(false);
    }
  }

  async function handleFetchModels(): Promise<void> {
    if (fetchingModels || form.id === null) return;
    setFetchingModels(true);
    setModelsFetchError(null);
    setModelsCount(null);
    try {
      const models = await imageGen.fetchSavedModels();
      // null = unknown profile (the route's 404); the hook already set its
      // error — surface it through the same inline line.
      setModelsCount(models !== null ? models.length : null);
      if (models === null) setModelsFetchError(imageGen.error ?? t("image_gen_fetch_models_failed"));
    } catch (cause) {
      setModelsFetchError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setFetchingModels(false);
    }
  }

  // Probe outcome renders only while it belongs to THIS profile (the hook
  // keeps the last probe per editor session; a profile switch must not show
  // the previous profile's badge).
  const probeOutcome =
    imageGen.probeOutcome !== null && imageGen.probeOutcome.profileId === form.id ? imageGen.probeOutcome : null;

  const actionButtonCls =
    "min-h-11 rounded-md border border-border bg-s2 px-4 py-2 font-ui text-[13px] font-medium text-t2 transition-colors hover:border-border2 hover:text-t1 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:py-1.5";

  return (
    <div data-testid="image-gen-profile-editor" className="flex flex-col gap-4">
      {isEdit ? (
        <ImageGenProviderForm
          form={form}
          editingId={form.id}
          profiles={imageGen.profiles}
          updateForm={handleUpdateForm}
          imageGen={imageGen}
        />
      ) : savedProfile !== null ? (
        <>
          <ImageGenBaseCard form={form} onEdit={imageGen.startEdit} />
          {/* Saved-profile connection actions (view mode): Probe + Fetch
              models. Width budget: two auto-width buttons in a flex-wrap
              row — the detail pane's ~820px budget against worst-case RU
              («Проверить соединение» ≈160px + «Получить модели» ≈140px +
              gap 8px) leaves the row far under budget at every size. */}
          <div className="rounded-lg border border-border bg-surface p-3.5" data-testid="image-gen-connection-actions">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="image-gen-probe-btn"
                className={actionButtonCls}
                onClick={() => void handleProbe()}
                disabled={probing}
              >
                {probing ? t("testing") : t("test_connection")}
              </button>
              <button
                type="button"
                data-testid="image-gen-fetch-models-btn"
                className={actionButtonCls}
                onClick={() => void handleFetchModels()}
                disabled={fetchingModels}
              >
                {fetchingModels ? t("loading") : t("image_gen_fetch_models")}
              </button>
            </div>
            {probeOutcome !== null && (
              <>
                <ConnectionProbeStatus
                  ok={probeOutcome.result.ok}
                  successTestId="image-gen-probe-success"
                  failureTestId="image-gen-probe-failure"
                  successText={t("connection_successful")}
                  failureText={t("connection_failed")}
                />
                {/* Vendor-supplied detail (model counts / error bodies) —
                    user data: wraps (break-words), never truncated. */}
                {probeOutcome.result.detail && (
                  <div
                    data-testid="image-gen-probe-detail"
                    className="mt-1.5 break-words font-ui text-[12px] text-t3"
                  >
                    {probeOutcome.result.detail}
                  </div>
                )}
              </>
            )}
            {modelsCount !== null && (
              <div data-testid="image-gen-models-count" className="mt-3 flex items-center gap-1.5 font-ui text-[12px] text-success">
                <Icons.Check />
                {t("image_gen_models_fetched", { count: modelsCount })}
              </div>
            )}
            {modelsFetchError !== null && (
              <div data-testid="image-gen-models-error" className="mt-3 break-words font-ui text-[12px] text-danger">
                {modelsFetchError}
              </div>
            )}
          </div>

          {/* Second level (IG-12): picker + favorites + per-mode sizes +
              bind-routed params — view mode only (edit mode keeps the
              level-1 connection form alone, the governing rule). */}
          <ImageGenPane imageGen={imageGen} />
        </>
      ) : null}

      {imageGen.error && (
        <div data-testid="image-gen-editor-error" className="rounded-md bg-danger/10 px-3 py-2 font-ui text-[12px] text-danger">
          {imageGen.error}
        </div>
      )}

      {/* Save/Delete live in the modal FOOTER (ImageGenFooter, the
          master-detail house pattern) — nothing inline here. */}
    </div>
  );
}
