import { useT } from "../../../../i18n/context.js";
import { IMAGE_GEN_BACKENDS } from "@vibe-tavern/domain";
import { ImageGenProfileList } from "./ImageGenProfileList.js";
import type { useImageProfiles } from "../../../../hooks/use-image-profiles.js";

type ImageGenHook = ReturnType<typeof useImageProfiles>;

/** Image-gen master column for the Providers modal (IMAGE_GENERATION_PLAN
 *  IG-11) — the SttSection fork: loading label, load-error banner, the
 *  profile list. The new-profile seed is a bare CUSTOM profile (presetId
 *  null): its wire backend is the OpenAI-images dialect (IG-CF8 — the only
 *  implemented cloud dialect for custom endpoints; an implementation fact,
 *  not a UI choice). */
export function ImageGenSection({ imageGen }: { imageGen: ImageGenHook }) {
  const { t } = useT();

  if (imageGen.loading) {
    return (
      <div data-testid="image-gen-section" className="flex flex-col p-3">
        <div className="mb-3 font-ui text-[12px] font-semibold uppercase tracking-wide text-t3">
          {t("image_gen_section_title")}
        </div>
        <div className="font-ui text-[13px] text-t3">{t("loading")}</div>
      </div>
    );
  }

  return (
    <div data-testid="image-gen-section" className="flex flex-col flex-1 min-h-0">
      {imageGen.error && (
        <div data-testid="image-gen-load-error" className="mx-3 mt-2 rounded-md bg-danger/10 px-3 py-2 font-ui text-[12px] text-danger">
          {t("image_gen_profiles_load_failed")}: {imageGen.error}
        </div>
      )}
      <ImageGenProfileList
        profiles={imageGen.profiles}
        editingId={imageGen.editingId}
        onSelectProfile={imageGen.select}
        onAddProfile={() => {
          imageGen.startCreate(t("image_gen_profile_default_name"), IMAGE_GEN_CUSTOM_SEED_BACKEND);
        }}
      />
    </div>
  );
}

/** New-profile seed backend (IG-CF8): a fresh profile is a bare CUSTOM one
 *  (presetId null), and custom speaks the OpenAI-images dialect under the
 *  hood — the only implemented cloud dialect for custom endpoints. */
const IMAGE_GEN_CUSTOM_SEED_BACKEND = IMAGE_GEN_BACKENDS.OpenAiImages;
