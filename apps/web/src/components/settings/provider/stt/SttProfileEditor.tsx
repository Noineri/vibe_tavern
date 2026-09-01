import { useT } from "../../../../i18n/context.js";
import { SttProviderForm } from "./SttProviderForm.js";
import { SttConfigFields } from "./SttConfigFields.js";
import { SttBaseCard } from "./SttBaseCard.js";
import { updateConfigField } from "./stt-form-helpers.js";
import type { SttProfileForm, useSttProfiles } from "./use-stt-profiles.js";

type SttHook = ReturnType<typeof useSttProfiles>;

/** STT editor (STT_PLAN ST-4a): fork of the TTS editor structure — the
 *  connection form renders in edit mode (Edit settings / New); in view mode
 *  the base card sits on top with the config fields below (same
 *  master-detail section pattern as TTS; no voices/bindings/tuning — those
 *  are TTS-only machines). Save/Delete live in the modal footer.
 */
export function SttProfileEditor({ stt }: { stt: SttHook }) {
  const { t } = useT();
  if (!stt.form) return null;

  const form = stt.form;
  const savedProfile =
    stt.editingId !== null ? (stt.profiles.find((p) => p.id === stt.editingId) ?? null) : null;
  const isView = stt.headerMode === "view" && savedProfile !== null;
  const isEdit = stt.headerMode === "edit";

  function handleUpdateForm<K extends keyof SttProfileForm>(k: K, v: SttProfileForm[K]): void {
    // Generic computed-key object can't be proven assignable — scoped cast.
    stt.setForm({ [k]: v } as Pick<SttProfileForm, K>);
  }

  function handleUpdateConfig(key: string, value: unknown): void {
    updateConfigField(stt, form, key, value);
  }

  return (
    <div data-testid="stt-profile-editor" className="flex flex-col gap-4">
      {isEdit ? (
        <SttProviderForm
          form={form}
          editingId={form.id}
          sttProfiles={stt.profiles}
          updateForm={handleUpdateForm}
          stt={stt}
        />
      ) : savedProfile !== null ? (
        <>
          <SttBaseCard
            form={form}
            isDefault={savedProfile.isDefault}
            onEdit={stt.startEdit}
            onSetDefault={() => void stt.setDefault(savedProfile.id)}
          />
          {/* View mode: the config fields below the base card. */}
          <SttConfigFields backend={form.backend} config={form.config} onUpdate={handleUpdateConfig} />
        </>
      ) : null}

      {stt.error && (
        <div data-testid="stt-editor-error" className="rounded-md bg-danger/10 px-3 py-2 font-ui text-[12px] text-danger">
          {stt.error}
        </div>
      )}

      {/* Save/Delete live in the modal FOOTER (MasterDetailFooter, ProviderModal
          stt branch) per the master-detail house pattern — nothing inline here. */}
    </div>
  );
}