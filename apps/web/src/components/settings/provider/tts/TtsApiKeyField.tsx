import { useT } from "../../../../i18n/context.js";
import { MaskedConnectionKeyField } from "../../../shared/masked-connection-key-field.js";

/** Thin TTS wrapper over the shared masked connection-key field (P11).
 *
 * The wrapper preserves the TTS test ids and i18n keys while the shared
 * primitive owns the masking, toggle, and stored-status mechanics. */
export function TtsApiKeyField(props: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** F2b saved-key status: true while the STORED profile has a key and the
   *  field is empty — the placeholder says so and a status line under the
   *  field explains the empty-keeps semantics (mirrors ProviderForm's
   *  `api_key_stored` placeholder). */
  stored?: boolean;
}): React.ReactElement {
  const { t } = useT();
  return (
    <MaskedConnectionKeyField
      value={props.value}
      onChange={props.onChange}
      placeholder={props.placeholder}
      stored={props.stored}
      fieldTestId="tts-field-api-key"
      toggleTestId="tts-field-api-key-toggle"
      statusTestId="tts-field-api-key-status"
      storedPlaceholder={t("tts_field_api_key_stored")}
      storedStatus={t("tts_field_api_key_status_stored")}
      showLabel={t("tts_field_api_key_show")}
      hideLabel={t("tts_field_api_key_hide")}
    />
  );
}
