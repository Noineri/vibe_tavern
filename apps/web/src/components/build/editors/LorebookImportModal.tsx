/**
 * LorebookImportModal — 3-шаговый мастер импорта записей лорбука.
 *
 * Шаг 1: Загрузка/вставка JSON файла
 * Шаг 2: Обзор обнаруженных записей, выбор целевого лорбука
 * Шаг 3: Выбор режима (новый/объединить/заменить) и запуск
 *
 * Управляет всей своей state самостоятельно.
 * Вызывает onImportComplete при успешном импорте.
 */
import { useState } from "react";

import { Ic } from "../../shared/icons.js";
import { cn } from "../../../lib/cn.js";
import {
  importLorebookEntries,
  type LorebookRecord,
} from "../../../app-client.js";

// ── Types ──────────────────────────────────────────────────────────────

type Scope = "global" | "character" | "persona" | "chat";

interface LorebookImportModalProps {
  open: boolean;
  lorebooks: LorebookRecord[];
  scope: Scope;
  characterId: string;
  personaId: string | null;
  chatId: string | null;
  onClose: () => void;
  onImportComplete: () => void;
  t: (key: string) => string;
}

// ── Component ──────────────────────────────────────────────────────────

export function LorebookImportModal({
  open,
  lorebooks,
  scope,
  characterId,
  personaId,
  chatId,
  onClose,
  onImportComplete,
  t,
}: LorebookImportModalProps) {
  // ── Шаг визарда ──
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // ── Данные файла ──
  const [importData, setImportData] = useState<Record<string, unknown> | null>(
    null
  );
  const [fileName, setFileName] = useState("");
  const [entryCount, setEntryCount] = useState(0);
  const [parseError, setParseError] = useState<string | null>(null);

  // ── Настройки импорта ──
  const [mode, setMode] = useState<"new" | "merge" | "replace">("new");
  const [targetLorebookId, setTargetLorebookId] = useState<string | null>(
    null
  );

  // ── Состояние выполнения ──
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  // ── Сброс при закрытии ──
  const close = () => {
    setStep(1);
    setImportData(null);
    setFileName("");
    setEntryCount(0);
    setParseError(null);
    setMode("new");
    setTargetLorebookId(null);
    setImporting(false);
    setImportError(null);
    onClose();
  };

  // ── Парсинг файла ──
  const parseFileContent = (text: string, name: string) => {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null) {
        setParseError(t("import_invalid_json"));
        return;
      }
      const entries = parsed.entries;
      const count = Array.isArray(entries)
        ? entries.length
        : typeof entries === "object" && entries !== null
          ? Object.keys(entries).length
          : 0;
      setImportData(parsed as Record<string, unknown>);
      setFileName(name);
      setEntryCount(count);
      setParseError(null);
      setStep(2);
    } catch {
      setParseError(t("import_invalid_json"));
    }
  };

  const handleImportFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string")
        parseFileContent(reader.result, file.name);
    };
    reader.readAsText(file);
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      parseFileContent(text, "clipboard.json");
    } catch {
      setParseError(t("import_invalid_json"));
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const file = e.dataTransfer.files[0];
    if (file) handleImportFile(file);
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleImportFile(file);
  };

  // ── Запуск импорта ──
  const runImport = async () => {
    if (!importData) return;
    const lorebookId = mode === "new" ? "new" : targetLorebookId;
    if (!lorebookId) return;

    const body: Parameters<typeof importLorebookEntries>[1] = {
      format: "st",
      data: importData,
      mode,
    };

    if (mode === "new") {
      body.scopeType = scope;
      if (scope === "character") body.characterId = characterId;
      if (scope === "persona" && personaId) body.personaId = personaId;
      if (scope === "chat" && chatId) body.chatId = chatId;
    }
    if (fileName) body.fallbackName = fileName.replace(/\.json$/i, "");

    setImporting(true);
    setImportError(null);
    try {
      await importLorebookEntries(lorebookId, body);
      onImportComplete();
      close();
    } catch (err) {
      setImportError(
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setImporting(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
      onClick={close}
    >
      <div
        className="flex w-[520px] max-w-[90vw] flex-col overflow-hidden rounded-xl border border-border bg-surface"
        style={{ maxHeight: "80vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Заголовок ── */}
        <div
          className="flex items-center justify-between border-b border-border"
          style={{ padding: "16px 20px" }}
        >
          <span className="text-sm font-semibold text-t1">
            {t("import_lorebook_title")}
          </span>
          <div
            className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-t3 transition-all hover:bg-s2 hover:text-t1"
            onClick={close}
          >
            <Ic.close />
          </div>
        </div>

        {/* ── Содержимое ── */}
        <div className="flex-1 overflow-y-auto" style={{ padding: 20 }}>
          {/* Прогресс-бар шагов */}
          <div className="mb-5 flex gap-2">
            {[1, 2, 3].map((s) => (
              <div
                key={s}
                className={cn(
                  "h-1 flex-1 rounded-sm",
                  step >= s ? "bg-accent" : "bg-s3"
                )}
              />
            ))}
          </div>

          {/* ── Шаг 1: Загрузка файла ── */}
          {step === 1 && (
            <>
              <div className="mb-3 text-sm font-medium text-t1">
                {t("import_step1_title")}
              </div>
              <div className="mb-4 text-xs text-t2">
                {t("import_step1_desc")}
              </div>
              <div
                className="flex cursor-pointer flex-col items-center gap-3 rounded-lg border-2 border-dashed border-border2 p-10 text-center text-t3 transition-all hover:border-accent hover:bg-s2 hover:text-t2"
                onDrop={handleDrop}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onClick={() =>
                  document.getElementById("lb-import-file")?.click()
                }
              >
                <input
                  id="lb-import-file"
                  type="file"
                  accept=".json"
                  className="hidden"
                  onChange={handleFileInput}
                />
                <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-s3 text-t2 transition-all">
                  <Ic.import />
                </div>
                <div className="text-[13px] text-t2">
                  {t("import_drop_browse")}
                </div>
              </div>
              <button type="button"
                className="mt-4 h-9 cursor-pointer rounded-md border-0 bg-s3 px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-border2 hover:text-t1"
                onClick={handlePaste}
              >
                {t("import_paste_clipboard")}
              </button>
              {parseError && (
                <div className="mt-3 text-xs text-danger">{parseError}</div>
              )}
            </>
          )}

          {/* ── Шаг 2: Обзор + выбор целевого лорбука ── */}
          {step === 2 && (
            <>
              <div className="mb-3 text-sm font-medium text-t1">
                {t("import_step2_title")}
              </div>
              <div className="mb-4 text-xs text-t2">
                {t("import_step2_desc")}
              </div>
              <div
                className="mb-4 rounded-lg border border-border bg-s2"
                style={{ padding: 12 }}
              >
                <div
                  className="text-[13px] font-medium text-t1"
                  style={{ marginBottom: 4 }}
                >
                  {t("import_detected_format")}
                </div>
                <div className="text-xs text-t3">
                  {entryCount} {t("import_entries_found")}
                </div>
                {fileName && (
                  <div className="mt-1 text-xs text-t3">{fileName}</div>
                )}
              </div>
              <div className="mb-3 text-xs text-t3">
                {t("import_target_lorebook")}
              </div>
              <div className="mb-4 flex flex-col gap-1">
                <div
                  className={cn(
                    "cursor-pointer rounded-lg border px-3 py-2 text-[13px] transition-all",
                    targetLorebookId === null
                      ? "border-accent bg-accent-dim text-accent-t"
                      : "border-border hover:bg-s2 text-t1"
                  )}
                  onClick={() => {
                    setTargetLorebookId(null);
                    setMode("new");
                  }}
                >
                  {t("import_create_new")}
                </div>
                {lorebooks.map((lb) => (
                  <div
                    key={lb.id}
                    className={cn(
                      "cursor-pointer rounded-lg border px-3 py-2 text-[13px] transition-all",
                      targetLorebookId === lb.id
                        ? "border-accent bg-accent-dim text-accent-t"
                        : "border-border hover:bg-s2 text-t1"
                    )}
                    onClick={() => {
                      setTargetLorebookId(lb.id);
                      setMode("merge");
                    }}
                  >
                    {lb.name}
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <button type="button"
                  className="h-9 cursor-pointer rounded-md border-0 bg-s3 px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-border2 hover:text-t1"
                  onClick={() => setStep(1)}
                >
                  {t("import_back")}
                </button>
                <button type="button"
                  className="h-9 cursor-pointer rounded-md border-0 bg-s3 px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-border2 hover:text-t1"
                  onClick={() => setStep(3)}
                >
                  {t("import_next")}
                </button>
              </div>
            </>
          )}

          {/* ── Шаг 3: Режим импорта + запуск ── */}
          {step === 3 && (
            <>
              <div className="mb-3 text-sm font-medium text-t1">
                {t("import_step3_title")}
              </div>
              {targetLorebookId === null ? (
                <div className="mb-4 text-xs text-t2">
                  {t("import_new_desc")}
                </div>
              ) : (
                <>
                  <div className="mb-4 text-xs text-t2">
                    {t("import_step3_desc")}
                  </div>
                  <div className="mb-4 flex flex-col gap-2">
                    <label className="flex items-center gap-2 text-[13px] text-t1">
                      <input
                        type="radio"
                        name="importMode"
                        checked={mode === "merge"}
                        onChange={() => setMode("merge")}
                      />{" "}
                      {t("import_merge")}
                    </label>
                    <div className="ml-6 text-xs text-t3">
                      {t("import_merge_desc")}
                    </div>
                    <label className="flex items-center gap-2 text-[13px] text-t1">
                      <input
                        type="radio"
                        name="importMode"
                        checked={mode === "replace"}
                        onChange={() => setMode("replace")}
                      />{" "}
                      {t("import_replace")}
                    </label>
                    <div className="ml-6 text-xs text-t3">
                      {t("import_replace_desc")}
                    </div>
                  </div>
                </>
              )}
              <div className="flex gap-2">
                <button type="button"
                  className="h-9 cursor-pointer rounded-md border-0 bg-s3 px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-border2 hover:text-t1"
                  onClick={() => setStep(2)}
                >
                  {t("import_back")}
                </button>
                <button type="button"
                  className="h-9 cursor-pointer rounded-md border-0 bg-accent px-4 font-ui text-xs font-medium text-on-accent transition-all"
                  disabled={importing}
                  onClick={runImport}
                >
                  {t("import_btn")}
                </button>
              </div>
              {importError && (
                <div className="mt-3 text-xs text-danger">{importError}</div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
