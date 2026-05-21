import { useState, useEffect, type KeyboardEvent } from "react";
import { useT } from "../i18n/context.js";
import { Icons as Ic } from "./shared/icons.js";
import {
  listLoreEntries,
  createLoreEntry,
  updateLoreEntry,
  deleteLoreEntry,
  testLoreActivation,
  type LoreEntryRecord,
} from "../app-client.js";

interface LocalEntry {
  id: string;
  title: string;
  keys: string[];
  secondaryKeys: string[];
  logic: string;
  position: string;
  depth: number;
  priority: number;
  sticky: number;
  cooldown: number;
  delay: number;
  enabled: boolean;
  content: string;
}

function toLocal(e: LoreEntryRecord): LocalEntry {
  return {
    id: e.id,
    title: e.title,
    keys: [...e.keys],
    secondaryKeys: [...e.secondaryKeys],
    logic: e.logic,
    position: e.position,
    depth: e.depth,
    priority: e.priority,
    sticky: e.stickyWindow,
    cooldown: e.cooldownWindow,
    delay: e.delayWindow,
    enabled: e.enabled,
    content: e.content,
  };
}

export function LorebookEditor({ charName, lorebookId }: { charName: string; lorebookId: string }) {
  const { t } = useT();
  const [entries, setEntries] = useState<LocalEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [secKeyInput, setSecKeyInput] = useState("");
  const [testText, setTestText] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    listLoreEntries(lorebookId)
      .then((data) => {
        if (cancelled) return;
        const local = data.map(toLocal);
        setEntries(local);
        if (local.length > 0) setActiveId(local[0].id);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [lorebookId]);

  const active = entries.find((e) => e.id === activeId) ?? null;

  function updateAct<K extends keyof LocalEntry>(k: K, v: LocalEntry[K]): void {
    setEntries((es) =>
      es.map((e) => (e.id === activeId ? { ...e, [k]: v } : e)),
    );
    if (activeId) {
      const patch: Partial<LoreEntryRecord> = {};
      if (k === "sticky") patch.stickyWindow = v as number;
      else if (k === "cooldown") patch.cooldownWindow = v as number;
      else if (k === "delay") patch.delayWindow = v as number;
      else if (k === "secondaryKeys") patch.secondaryKeys = v as string[];
      else (patch as Record<string, unknown>)[k as string] = v;
      updateLoreEntry(lorebookId, activeId, patch).catch(() => {});
    }
  }

  async function handleAddEntry(): Promise<void> {
    try {
      const serverEntry = await createLoreEntry(lorebookId, {
        title: t("new_lore_entry"),
        content: "",
        keys: [],
        secondaryKeys: [],
        logic: "and_any",
        position: "in_prompt",
        depth: 4,
        priority: 10,
        stickyWindow: 0,
        cooldownWindow: 0,
        delayWindow: 0,
        enabled: true,
      });
      const local = toLocal(serverEntry);
      setEntries([local, ...entries]);
      setActiveId(local.id);
      setTestResult(null);
    } catch {
      // silently ignore — existing pattern in this component
    }
  }

  function handleKeyAdd(e: KeyboardEvent<HTMLInputElement>, type: "keys" | "secondaryKeys"): void {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const val = (type === "keys" ? keyInput : secKeyInput).trim().toLowerCase();
    if (!val || !active) return;
    const targetArr = type === "keys" ? active.keys : active.secondaryKeys;
    if (!targetArr.includes(val)) {
      updateAct(type, [...targetArr, val]);
    }
    if (type === "keys") setKeyInput("");
    else setSecKeyInput("");
  }

  function removeKey(type: "keys" | "secondaryKeys", keyToRemove: string): void {
    if (!active) return;
    const targetArr = type === "keys" ? active.keys : active.secondaryKeys;
    updateAct(type, targetArr.filter((k) => k !== keyToRemove));
  }

  function handleDeleteEntry(): void {
    if (!activeId) return;
    const next = entries.filter((e) => e.id !== activeId);
    setEntries(next);
    setActiveId(next[0]?.id ?? null);
    deleteLoreEntry(lorebookId, activeId).catch(() => {});
  }

  async function runTest(): Promise<void> {
    if (!testText.trim()) {
      setTestResult({ ok: false, msg: t("test_enter_text") });
      return;
    }
    if (!active) {
      setTestResult({ ok: false, msg: t("test_select_entry") });
      return;
    }
    if (!active.enabled) {
      setTestResult({ ok: false, msg: t("test_disabled") });
      return;
    }
    try {
      const result = await testLoreActivation(lorebookId, testText);
      const hit = result.activatedIds.includes(active.id);
      if (hit) {
        setTestResult({
          ok: true,
          msg: t("test_hit"),
        });
      } else {
        setTestResult({
          ok: false,
          msg: t("test_miss"),
        });
      }
    } catch (error) {
      const errStr = error instanceof Error ? error.message : String(error);
      setTestResult({
        ok: false,
        msg: `${t("request_failed")} ${errStr}`,
      });
    }
  }

  return (
    <div className="lore-layout">
      <div className="lore-sidebar">
        <div className="lore-sidebar-head">
          <span className="lore-sidebar-title">{t("world_info_count")} ({entries.length})</span>
          <div style={{ display: "flex", gap: 4 }}>
            <div className="iBtn" style={{ width: 24, height: 24 }} title={t("new_lore_entry")} onClick={handleAddEntry}>
              <Ic.Plus />
            </div>
          </div>
        </div>
        <div className="lore-list">
          {entries.map((e) => (
            <div
              key={e.id}
              className={`lore-item ${activeId === e.id ? "act" : ""} ${!e.enabled ? "dis" : ""}`}
              onClick={() => {
                setActiveId(e.id);
                setTestResult(null);
              }}
            >
              <div className="lore-item-title">{e.title || t("untitled")}</div>
              <div className="lore-item-keys">{e.keys.length > 0 ? e.keys.join(", ") : t("no_keys")}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="lore-main">
        {active ? (
          <div style={{ maxWidth: 860 }}>
            <div className="lore-scope">
              <Ic.Book /> {t("character_lorebook")} {charName}
            </div>

            <div style={{ display: "flex", gap: 16, marginBottom: 20 }}>
              <div className="build-field" style={{ flex: 1, marginBottom: 0 }}>
                <label>{t("entry_title_label")}</label>
                <input type="text" value={active.title} onChange={(e) => updateAct("title", e.target.value)} />
              </div>
              <div className="build-field" style={{ width: 140, marginBottom: 0 }}>
                <label>{t("status_label")}</label>
                <div
                  style={{
                    height: 40,
                    display: "flex",
                    alignItems: "center",
                    background: "var(--s2)",
                    borderRadius: 6,
                    padding: "0 12px",
                    border: "1px solid var(--border)",
                  }}
                >
                  <label className="toggle" style={{ marginRight: 8 }}>
                    <input
                      type="checkbox"
                      checked={active.enabled}
                      onChange={(e) => updateAct("enabled", e.target.checked)}
                    />
                    <div className="tgl-sl"></div>
                  </label>
                  <span style={{ fontSize: 13, color: active.enabled ? "var(--t1)" : "var(--t3)" }}>
                    {active.enabled ? t("enabled") : t("disabled")}
                  </span>
                </div>
              </div>
            </div>

            <div style={{ display: "flex", gap: 16, marginBottom: 20 }}>
              <div className="build-field" style={{ flex: 1, marginBottom: 0 }}>
                <label>{t("primary_keys_label")}</label>
                <input
                  type="text"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  onKeyDown={(e) => handleKeyAdd(e, "keys")}
                  placeholder={t("key_phrase_placeholder")}
                />
                <div className="build-tags">
                  {active.keys.map((k) => (
                    <span key={k} className="build-tag on" role="button" tabIndex={0} onClick={() => removeKey("keys", k)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") removeKey("keys", k); }}>
                      {k} ✕
                    </span>
                  ))}
                </div>
              </div>
              <div className="build-field" style={{ flex: 1, marginBottom: 0 }}>
                <label>{t("secondary_keys_label")}</label>
                <input
                  type="text"
                  value={secKeyInput}
                  onChange={(e) => setSecKeyInput(e.target.value)}
                  onKeyDown={(e) => handleKeyAdd(e, "secondaryKeys")}
                  placeholder={t("secondary_key_placeholder")}
                />
                <div className="build-tags">
                  {active.secondaryKeys.map((k) => (
                    <span key={k} className="build-tag on" role="button" tabIndex={0} onClick={() => removeKey("secondaryKeys", k)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") removeKey("secondaryKeys", k); }}>
                      {k} ✕
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className="lore-grid">
              <div className="build-field">
                <label>{t("logic_label")}</label>
                <select
                  value={active.logic}
                  onChange={(e) => updateAct("logic", e.target.value)}
                  className="sel-arrow"
                  style={{
                    width: "100%",
                    height: 38,
                    padding: "0 0 0 10px",
                    background: "var(--s2)",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    color: "var(--t1)",
                    outline: "none",
                    fontFamily: "var(--font-ui)",
                  }}
                >
                  <option value="and_any">AND ANY</option>
                  <option value="and_all">AND ALL</option>
                  <option value="not_any">NOT ANY</option>
                  <option value="not_all">NOT ALL</option>
                </select>
              </div>
              <div className="build-field">
                <label>{t("position_label")}</label>
                <select
                  value={active.position}
                  onChange={(e) => updateAct("position", e.target.value)}
                  className="sel-arrow"
                  style={{
                    width: "100%",
                    height: 38,
                    padding: "0 0 0 10px",
                    background: "var(--s2)",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    color: "var(--t1)",
                    outline: "none",
                    fontFamily: "var(--font-ui)",
                  }}
                >
                  <option value="before_prompt">Before Prompt</option>
                  <option value="in_prompt">In Prompt</option>
                  <option value="in_chat">In Chat</option>
                  <option value="hidden_system">Hidden System</option>
                </select>
              </div>
              <div className="build-field">
                <label>{t("depth")}</label>
                <input
                  type="number"
                  min={0}
                  value={active.depth}
                  onChange={(e) => updateAct("depth", parseInt(e.target.value))}
                  style={{ height: 38, padding: "0 10px" }}
                />
              </div>
              <div className="build-field">
                <label>{t("priority_label")}</label>
                <input
                  type="number"
                  min={0}
                  value={active.priority}
                  onChange={(e) => updateAct("priority", parseInt(e.target.value))}
                  style={{ height: 38, padding: "0 10px" }}
                />
              </div>
              <div className="build-field">
                <label>{t("sticky_win_label")}</label>
                <input
                  type="number"
                  min={0}
                  value={active.sticky}
                  onChange={(e) => updateAct("sticky", parseInt(e.target.value))}
                  style={{ height: 38, padding: "0 10px" }}
                  title={t("sticky_win_hint")}
                />
              </div>
              <div className="build-field">
                <label>{t("cooldown_label")}</label>
                <input
                  type="number"
                  min={0}
                  value={active.cooldown}
                  onChange={(e) => updateAct("cooldown", parseInt(e.target.value))}
                  style={{ height: 38, padding: "0 10px" }}
                  title={t("cooldown_hint")}
                />
              </div>
              <div className="build-field">
                <label>{t("delay_label")}</label>
                <input
                  type="number"
                  min={0}
                  value={active.delay}
                  onChange={(e) => updateAct("delay", parseInt(e.target.value))}
                  style={{ height: 38, padding: "0 10px" }}
                  title={t("delay_hint")}
                />
              </div>
            </div>

            <div className="build-field">
              <label>{t("lore_content_label")}</label>
              <textarea
                value={active.content}
                onChange={(e) => updateAct("content", e.target.value)}
                style={{ minHeight: 180, lineHeight: 1.6 }}
                placeholder={t("lore_content_placeholder")}
              />
            </div>

            <div className="lore-test-box">
              <div style={{ fontSize: 13, fontWeight: 500, color: "var(--t1)", marginBottom: 8 }}>
                {t("activation_test")}
              </div>
              <div style={{ fontSize: 12, color: "var(--t3)", marginBottom: 12 }}>
                {t("activation_test_desc")}
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <input
                  type="text"
                  value={testText}
                  onChange={(e) => setTestText(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && runTest()}
                  placeholder={t("test_message_placeholder")}
                  style={{
                    flex: 1,
                    height: 36,
                    background: "var(--bg)",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    padding: "0 12px",
                    color: "var(--t1)",
                    outline: "none",
                  }}
                />
                <button className="api-test-btn idle" style={{ height: 36 }} onClick={runTest}>
                  {t("check_btn")}
                </button>
              </div>
              {testResult && (
                <div className={`lore-test-res ${testResult.ok ? "ok" : "err"}`}>
                  {testResult.ok ? <Ic.Check /> : <Ic.Close />}
                  {testResult.msg}
                </div>
              )}
            </div>

            <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end" }}>
              <button
                className="api-cancel-btn"
                onClick={handleDeleteEntry}
                style={{ color: "var(--danger, #e55)" }}
              >
                {t("delete_lore_confirm")}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ color: "var(--t3)", fontSize: 14, textAlign: "center", marginTop: 100 }}>
            {t("select_or_create")}
          </div>
        )}
      </div>
    </div>
  );
}
