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
  const keyNotRequired = preset?.noApiKey === true;
  const hasKey = keyNotRequired || form.hasStoredApiKey || Boolean(form.apiKey);

  return (
    <div className="mb-6">
      <div className="flex flex-col items-stretch gap-3 rounded-lg border border-border2 bg-s2 p-3 sm:flex-row sm:items-start sm:justify-between sm:p-4">
        <div className="min-w-0">
          <div className="mb-1 truncate font-ui text-[16px] font-semibold text-t1">{form.name}</div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-ui text-[13px] text-t3 sm:flex-nowrap">
            <span>{presetLabel}</span>
            <span className="h-1 w-1 rounded-full bg-t4" />
            {hasKey ? (
              <span className="flex items-center gap-1.5 text-success">
                <Icons.Check /> {keyNotRequired ? t("api_key_not_required") : t("api_key_saved")}
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
          className="min-h-11 w-full rounded-md border border-accent bg-accent-dim px-4 font-ui text-[13px] font-medium text-accent-t transition-colors hover:bg-accent hover:text-on-accent disabled:cursor-not-allowed disabled:opacity-50 sm:h-[34px] sm:min-h-0 sm:w-auto"
          disabled={isActive}
        >
          {isActive ? t("provider_active") : t("make_active")}
        </button>
      </div>
    </div>
  );
}
