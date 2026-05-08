interface PresetHeaderProps {
  name: string;
  bindModel: string;
  disabled: boolean;
  onUpdateField: (key: "name" | "bindModel", value: string) => void;
  providerProfiles?: Array<{ id: string; name: string }>;
}

const labelCls = "mb-[7px] block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3";
const inputCls = "w-full h-[38px] bg-s2 border border-border rounded-[6px] px-[13px] font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-[border-color] duration-150 focus:border-accent disabled:opacity-50";
const selectCls = "w-full h-[38px] bg-s2 border border-border rounded-[6px] pl-[13px] pr-[34px] font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-[border-color] duration-150 focus:border-accent disabled:opacity-50";

export function PresetHeader({ name, bindModel, disabled, onUpdateField, providerProfiles }: PresetHeaderProps) {
  return (
    <div className="mb-4 flex items-end gap-3">
      <div className="flex-1">
        <label className={labelCls}>Preset name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => onUpdateField("name", e.target.value)}
          disabled={disabled}
          className={inputCls}
          placeholder={disabled ? "No preset selected" : "Preset name"}
        />
      </div>
      <div className="flex-1">
        <label className={labelCls}>Bind to provider</label>
        <select
          value={bindModel}
          onChange={(e) => onUpdateField("bindModel", e.target.value)}
          disabled={disabled}
          className={selectCls}
        >
          <option value="">Default (Global)</option>
          {providerProfiles?.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
