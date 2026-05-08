import type React from "react";
import { cn } from "../../lib/cn.js";
import type { FormState } from "../ProviderModal.js";
import { Icons } from "../shared/icons.js";

const labelCls = "block text-[calc(var(--ui-fs)-3px)] font-medium tracking-[0.06em] uppercase text-t3 mb-[7px]";
const inputCls = "w-full h-[38px] bg-s2 border border-border rounded-[6px] font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-[border-color] duration-150 focus:border-accent";

interface ModelOption {
  id: string;
  label: string;
}

interface ProviderModelSelectorProps {
  form: FormState;
  models: ModelOption[];
  filteredModels: ModelOption[];
  fetching: boolean;
  fetchError: string | null;
  modelSearch: string;
  modelListOpen: boolean;
  updateForm: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  onFetchModels: () => void;
  setModelSearch: (value: string) => void;
  setModelListOpen: React.Dispatch<React.SetStateAction<boolean>>;
  dropdownRef: React.RefObject<HTMLDivElement | null>;
}

export function ProviderModelSelector({
  form,
  models,
  filteredModels,
  fetching,
  fetchError,
  modelSearch,
  modelListOpen,
  updateForm,
  onFetchModels,
  setModelSearch,
  setModelListOpen,
  dropdownRef,
}: ProviderModelSelectorProps) {
  void fetchError;

  return (
    <div className="mb-6 mt-6">
      <div className="font-ui text-[14px] font-semibold text-t1" style={{ marginBottom: 16, paddingBottom: 8, borderBottom: "1px solid var(--border2)" }}>
        Модель
      </div>
      <div className="flex items-end gap-3">
        <div className="mb-0 flex-1" ref={dropdownRef}>
          <label className={labelCls}>Выбранная модель</label>
          {models.length > 0 ? (
            <div className="relative">
              <button
                type="button"
                onClick={() => setModelListOpen((value) => !value)}
                className="flex w-full items-center justify-between rounded-md border border-border bg-s2 font-ui text-[13px] text-t1 transition-colors hover:border-accent"
                style={{ padding: "7px 12px" }}
              >
                <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                  {models.find((model) => model.id === form.model)?.label || form.model || "Выбрать модель..."}
                </span>
                <span className="text-t3"><Icons.Caret direction="d" /></span>
              </button>
              {modelListOpen && (
                <div className="absolute left-0 right-0 top-full z-[100] mt-1 overflow-hidden rounded-md border border-border shadow-[0_8px_30px_rgba(0,0,0,0.6)]">
                  <div className="border-b border-border2 bg-s2" style={{ padding: 8 }}>
                    <input
                      type="text"
                      placeholder="Поиск моделей..."
                      value={modelSearch}
                      onChange={(event) => setModelSearch(event.target.value)}
                      autoFocus
                      className="w-full rounded border border-border bg-surface font-ui text-[12px] text-t1 outline-none focus:border-accent"
                      style={{ padding: "5px 8px" }}
                    />
                  </div>
                  <div className="max-h-[200px] overflow-y-auto bg-surface" style={{ padding: 4 }}>
                    {filteredModels.map((model) => (
                      <div
                        key={model.id}
                        onClick={() => {
                          updateForm("model", model.id);
                          setModelListOpen(false);
                          setModelSearch("");
                        }}
                        className={cn(
                          "cursor-pointer rounded font-ui text-[12px] transition-colors",
                          model.id === form.model ? "bg-accent-dim font-medium text-accent-t" : "text-t2 hover:bg-s2 hover:text-t1",
                        )}
                        style={{ padding: "6px 10px" }}
                      >
                        {model.label} <span className="ml-1 text-t4 opacity-70">({model.id})</span>
                      </div>
                    ))}
                    {filteredModels.length === 0 && (
                      <div className="text-center font-ui text-[11px] text-t4" style={{ padding: "6px 10px" }}>
                        Модели не найдены
                      </div>
                    )}
                  </div>
                </div>
              )}
              {!models.find((model) => model.id === form.model) && form.model && (
                <div className="mt-2 font-ui text-[12px] font-medium text-accent">
                  Пользовательская модель: {form.model}
                </div>
              )}
            </div>
          ) : (
            <input
              type="text"
              value={form.model || ""}
              onChange={(event) => updateForm("model", event.target.value)}
              placeholder="ID модели (напр. gpt-4o)"
              className={inputCls}
              style={{ padding: "0 13px" }}
            />
          )}
        </div>
        <button
          onClick={() => void onFetchModels()}
          disabled={fetching}
          className="flex h-[37px] shrink-0 items-center gap-2 rounded-md border border-border bg-s2 font-ui text-[13px] font-medium text-t2 transition-colors hover:border-border2 hover:text-t1 disabled:opacity-50"
          style={{ padding: "0 16px" }}
        >
          {fetching ? (
            <>
              <span className="inline-flex items-center gap-[3px] ml-[3px] align-middle">
                <span className="h-1 w-1 rounded-full bg-accent animate-genp" />
                <span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.18s]" />
                <span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.36s]" />
              </span>{" "}
              Загрузка...
            </>
          ) : (
            <>
              <Icons.Regen /> Обновить список
            </>
          )}
        </button>
      </div>
    </div>
  );
}
