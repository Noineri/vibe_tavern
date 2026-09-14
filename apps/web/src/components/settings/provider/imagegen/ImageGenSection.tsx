import { useT } from "../../../../i18n/context.js";
import { ImageGenProfileList } from "./ImageGenProfileList.js";
import { IMAGE_GEN_PROVIDER_PRESETS } from "../../../../provider-presets.js";
import type { useImageProfiles } from "../../../../hooks/use-image-profiles.js";

type ImageGenHook = ReturnType<typeof useImageProfiles>;

/** Image-gen master column for the Providers modal (IMAGE_GENERATION_PLAN
 *  IG-11) — the SttSection fork: loading label, load-error banner, the
 *  profile list. The new-profile seed (default name + first roster row's
 *  backend) derives from the preset table here — roster order, never a
 *  hardcoded slug. */
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
          const firstRow = IMAGE_GEN_ROSTER_SEED;
          imageGen.startCreate(t("image_gen_profile_default_name"), firstRow.backend);
        }}
      />
    </div>
  );
}

/** New-profile seed backend — the roster's FIRST row (cloud group order:
 *  OpenRouter). Module-scope derivation, not an inline literal (the
 *  "roster order, never hardcoded ids" rule from the twins). */
const IMAGE_GEN_ROSTER_SEED = IMAGE_GEN_PROVIDER_PRESETS[0];
