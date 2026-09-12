import { useT } from "../../../../i18n/context.js";
import { MaskedConnectionKeyField } from "../../../shared/masked-connection-key-field.js";

/** Thin STT wrapper over the shared masked connection-key field (P11).
 *
 * The wrapper preserves the STT test ids and i18n keys while the shared
 * primitive owns the masking, toggle, and stored-status mechanics. */
export function SttApiKeyField(props: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** ST-1 saved-key status: true while the STORED profile has a key and the
   *  field is empty — the placeholder says so and a status line under the
   *  field explains the empty-keeps semantics. */
  stored?: boolean;
}): React.ReactElement {
  const { t } = useT();
  return (
    <MaskedConnectionKeyField
      value={props.value}
      onChange={props.onChange}
      placeholder={props.placeholder}
      stored={props.stored}
      fieldTestId="stt-field-api-key"
      toggleTestId="stt-field-api-key-toggle"
      statusTestId="stt-field-api-key-status"
      storedPlaceholder={t("stt_field_api_key_stored")}
      storedStatus={t("stt_field_api_key_status_stored")}
      showLabel={t("stt_field_api_key_show")}
      hideLabel={t("stt_field_api_key_hide")}
    />
  );
}
