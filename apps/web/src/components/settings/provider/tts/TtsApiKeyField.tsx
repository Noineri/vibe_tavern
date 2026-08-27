import { useState } from "react";
import { useT } from "../../../../i18n/context.js";
import { monoUICls } from "../../../build/fields/field-styles.js";
import { Ic } from "../../../shared/icons.js";

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
  const [visible, setVisible] = useState(false);
  const placeholder = props.value === "" && props.stored ? t("tts_field_api_key_stored") : props.placeholder;
  return (
    <div className="relative mt-1">
      <input
        data-testid="tts-field-api-key"
        type={visible ? "text" : "password"}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={placeholder}
        className={monoUICls + " w-full pr-10 px-3 py-2 text-[13px]"}
      />
      <button
        type="button"
        data-testid="tts-field-api-key-toggle"
        aria-label={visible ? t("tts_field_api_key_hide") : t("tts_field_api_key_show")}
        onClick={() => setVisible((v) => !v)}
        className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1.5 text-t3 hover:bg-s2 hover:text-t1"
      >
        <span className="flex h-3.5 w-3.5 items-center justify-center [&>svg]:h-3.5 [&>svg]:w-3.5">
          <Ic.eye />
        </span>
      </button>
      {props.value === "" && props.stored && (
        <div data-testid="tts-field-api-key-status" className="mt-1 font-ui text-[11px] text-t4">
          {t("tts_field_api_key_status_stored")}
        </div>
      )}
    </div>
  );
}
