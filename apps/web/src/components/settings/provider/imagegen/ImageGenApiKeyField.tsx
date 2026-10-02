import { useT } from "../../../../i18n/context.js";
import { MaskedConnectionKeyField } from "../../../shared/masked-connection-key-field.js";

/** Thin image-gen wrapper over the shared masked connection-key field —
 *  the SttApiKeyField/TtsApiKeyField twin (P11): the shared primitive owns
 *  the masking, toggle, and stored-status mechanics; the family keeps its
 *  own test ids and i18n keys. */
export function ImageGenApiKeyField(props: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** True while the STORED profile has a key and the field is empty — the
   *  placeholder says so and a status line under the field explains the
   *  empty-keeps semantics (the STT tri-state rule). */
  stored?: boolean;
}): React.ReactElement {
  const { t } = useT();
  return (
    <MaskedConnectionKeyField
      value={props.value}
      onChange={props.onChange}
      placeholder={props.placeholder}
      stored={props.stored}
      fieldTestId="image-gen-field-api-key"
      toggleTestId="image-gen-field-api-key-toggle"
      statusTestId="image-gen-field-api-key-status"
      storedPlaceholder={t("image_gen_field_api_key_stored")}
      storedStatus={t("image_gen_field_api_key_status_stored")}
      showLabel={t("image_gen_field_api_key_show")}
      hideLabel={t("image_gen_field_api_key_hide")}
    />
  );
}
