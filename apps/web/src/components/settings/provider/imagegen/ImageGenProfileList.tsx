import { useT } from "../../../../i18n/context.js";
import { useMasterDetail, MasterDetailMobileDrillDown } from "../../../shared/MasterDetailModal.js";
import { IMAGE_GEN_PROVIDER_PRESETS } from "../../../../provider-presets.js";
import type { ImageGenProfileRecord } from "../../../../api/image-gen-api.js";
import { cn } from "../../../../lib/cn.js";

interface ImageGenProfileListProps {
  profiles: ImageGenProfileRecord[];
  editingId: string | null;
  onSelectProfile: (id: string) => void;
  onAddProfile: () => void;
}

/** Row sub-label: the preset row label (OpenRouter / OpenAI /
 *  A1111-compatible) or the raw backend slug for Custom profiles. */
function rowSubLabel(backend: string, presetId: string | null): string {
  const preset = presetId !== null ? IMAGE_GEN_PROVIDER_PRESETS.find((p) => p.id === presetId) : undefined;
  return preset?.label ?? backend;
}

function ImageGenProfileRow({
  profile,
  isEditing,
  onSelectProfile,
}: {
  profile: ImageGenProfileRecord;
  isEditing: boolean;
  onSelectProfile: (id: string) => void;
}) {
  return (
    <div
      data-testid="image-gen-profile-row"
      data-profile-id={profile.id}
      className={cn(
        "cursor-pointer border-l-[3px] pl-4 pr-2 min-h-[56px] flex items-center active:bg-s2 sm:overflow-hidden sm:whitespace-nowrap sm:text-ellipsis sm:transition-colors touch-manipulation",
        isEditing ? "border-l-accent bg-accent-dim text-accent-t" : "border-l-transparent text-t2 hover:bg-s2",
      )}
      onPointerDown={() => onSelectProfile(profile.id)}
    >
      <div className="flex w-full items-center gap-3">
        <div className={cn("h-2 w-2 shrink-0 rounded-full", isEditing ? "bg-accent" : "bg-t4")} />
        <div className="min-w-0 flex-1 py-2">
          <div className="truncate text-[13px] font-medium">{profile.name}</div>
          <div className={cn("mt-0.5 text-[11px]", isEditing ? "text-accent-t" : "text-t4")}>
            {rowSubLabel(profile.backend, profile.presetId ?? null)}
          </div>
        </div>
        <MasterDetailMobileDrillDown onSelect={() => onSelectProfile(profile.id)} className="py-3" />
      </div>
    </div>
  );
}

/** Image-gen master list — the SttProfileList fork (IG-11): title, rows,
 *  "+ New" docked at the bottom of the master column (never headerActions —
 *  the master-detail house pattern). The seed for a new profile comes from
 *  the caller (the pane owns i18n + the roster's first row, the STT
 *  startCreateParameters rule). */
export function ImageGenProfileList({ profiles, editingId, onSelectProfile, onAddProfile }: ImageGenProfileListProps) {
  const { t } = useT();
  const { openDetail } = useMasterDetail();

  return (
    <div className="flex flex-col flex-1 min-h-0 pt-5 pb-2.5">
      <div className="mb-1.5 px-4 font-ui text-[12px] font-medium uppercase tracking-[0.05em] text-t3">
        {t("image_gen_section_title")}
      </div>

      <div className="flex-1 overflow-y-auto">
        {profiles.map((p) => (
          <ImageGenProfileRow key={p.id} profile={p} isEditing={editingId === p.id} onSelectProfile={onSelectProfile} />
        ))}
      </div>

      <div
        data-testid="image-gen-new-profile-btn"
        className="mx-3 mt-3 cursor-pointer rounded-md border border-dashed border-border2 py-2 text-center font-ui text-[12px] font-medium text-t3 transition-colors hover:border-border hover:text-t1 hover:bg-s2"
        onClick={() => {
          onAddProfile();
          openDetail();
        }}
      >
        {t("image_gen_profile_new")}
      </div>
    </div>
  );
}
