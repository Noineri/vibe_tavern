import { ImageGenProviderForm } from "./ImageGenProviderForm.js";
import { ImageGenBaseCard } from "./ImageGenBaseCard.js";
import { ImageGenPane } from "./ImageGenPane.js";
import { useImageGenChatStore } from "../../../../stores/image-gen-chat-store.js";
import type { ImageGenProfileForm, useImageProfiles } from "../../../../hooks/use-image-profiles.js";

type ImageGenHook = ReturnType<typeof useImageProfiles>;

/** Image-gen profile editor (IMAGE_GENERATION_PLAN IG-11) — fork of the
 *  SttProfileEditor structure: edit mode renders the level-1 connection
 *  form; view mode renders the base card plus the IG-12 pane below it.
 *
 *  IG-CF4 (owner review 2026-09-15): view mode has NO connection-actions
 *  card. Probe lives INSIDE the connection settings (ImageGenProviderForm's
 *  test card, the STT P10 shape — works on drafts); model refresh lives in
 *  the Pane ("Update models"). The old view-mode Probe + Fetch-models
 *  buttons duplicated both and were deleted together with their hook/api
 *  ladder (probeSaved/probeOutcome → probeImageGenProfile client wrapper;
 *  the server probe ROUTE stays — the draft-probe contract surface). */
export function ImageGenProfileEditor({ imageGen }: { imageGen: ImageGenHook }) {
  const savedProfile =
    imageGen.editingId !== null ? (imageGen.profiles.find((p) => p.id === imageGen.editingId) ?? null) : null;
  const isView = imageGen.headerMode === "view" && savedProfile !== null;
  // MR-5: the global active pointer + its setter (the card's activate
  //  button) — subscribed here so the card alone re-renders on flip.
  const activeImageGenProfileId = useImageGenChatStore((s) => s.activeImageGenProfileId);
  const setActiveImageGenProfile = useImageGenChatStore((s) => s.setActiveImageGenProfile);

  if (!imageGen.form) return null;

  const form: ImageGenProfileForm = imageGen.form;
  const isEdit = imageGen.headerMode === "edit";

  function handleUpdateForm<K extends keyof ImageGenProfileForm>(k: K, v: ImageGenProfileForm[K]): void {
    // Generic computed-key object can't be proven assignable — scoped cast
    // (the SttProfileEditor twin).
    imageGen.setForm({ [k]: v } as Pick<ImageGenProfileForm, K>);
  }

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
          <ImageGenBaseCard
            form={form}
            isActive={activeImageGenProfileId === savedProfile.id}
            onEdit={imageGen.startEdit}
            onActivate={() => setActiveImageGenProfile(savedProfile.id)}
          />

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
