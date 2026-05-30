import type { FormState } from '../../modals/ProviderModal.js';
import { useT } from '../../../i18n/context.js';
import { PROVIDER_PRESETS } from '../../../provider-presets.js';
import { Icons } from '../../shared/icons.js';

interface ProviderViewHeaderProps {
  form: FormState;
  isActive: boolean;
  onEdit: () => void;
  onActivate: () => void;
}

export function ProviderViewHeader({ form, isActive, onEdit, onActivate }: ProviderViewHeaderProps) {
  const { t } = useT();
  const preset = PROVIDER_PRESETS.find((p) => p.id === form.providerPreset);
  const presetLabel = preset?.label ?? form.providerPreset;
  const hasKey = form.hasStoredApiKey || Boolean(form.apiKey);

  return (
    <div className="mb-6">
      <div className="flex items-start justify-between rounded-lg border border-border2 bg-s2 p-4">
        <div>
          <div className="mb-1 font-ui text-[16px] font-semibold text-t1">{form.name}</div>
          <div className="flex items-center gap-3 font-ui text-[13px] text-t3">
            <span>{presetLabel}</span>
            <span className="h-1 w-1 rounded-full bg-t4" />
            {hasKey ? (
              <span className="flex items-center gap-1.5 text-success">
                <Icons.Check /> {t("api_key_saved")}
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-warning">
                <Icons.Alert /> {t("no_api_key")}
              </span>
            )}
          </div>
          <button type="button" onClick={onEdit} className="mt-3 flex items-center gap-1.5 font-ui text-[12px] font-medium text-t2 transition-colors hover:text-accent">
            <Icons.Edit /> {t("edit_settings_btn")}
          </button>
        </div>
        <button type="button"
          onClick={onActivate}
          className="h-[34px] rounded-md border border-accent bg-accent-dim px-4 font-ui text-[13px] font-medium text-accent-t transition-colors hover:bg-accent hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={isActive}
        >
          {isActive ? t("provider_active") : t("make_active")}
        </button>
      </div>
    </div>
  );
}
