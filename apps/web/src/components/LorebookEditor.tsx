import { useState, useEffect, type KeyboardEvent } from "react";
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

function generateId(): string {
  return `lore_entry_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function LorebookEditor({ charName, lorebookId }: { charName: string; lorebookId: string }) {
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
      else (patch as any)[k] = v;
      updateLoreEntry(lorebookId, activeId, patch).catch(() => {});
    }
  }

  function handleAddEntry(): void {
    const newEntry: LocalEntry = {
      id: generateId(),
      title: "New entry",
      keys: [],
      secondaryKeys: [],
      logic: "AND_ANY",
      position: "before_char",
      depth: 4,
      priority: 10,
      sticky: 0,
      cooldown: 0,
      delay: 0,
      enabled: true,
      content: "",
    };
    setEntries([newEntry, ...entries]);
    setActiveId(newEntry.id);
    setTestResult(null);
    createLoreEntry(lorebookId, {
      title: newEntry.title,
      content: newEntry.content,
      keys: newEntry.keys,
      secondaryKeys: newEntry.secondaryKeys,
      logic: newEntry.logic,
      position: newEntry.position,
      depth: newEntry.depth,
      priority: newEntry.priority,
      stickyWindow: newEntry.sticky,
      cooldownWindow: newEntry.cooldown,
      delayWindow: newEntry.delay,
      enabled: newEntry.enabled,
    }).catch(() => {});
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
      setTestResult({ ok: false, msg: "Enter test text." });
      return;
    }
    if (!active) {
      setTestResult({ ok: false, msg: "Select an entry first." });
      return;
    }
    if (!active.enabled) {
      setTestResult({ ok: false, msg: "Entry is disabled, so it will not activate." });
      return;
    }
    try {
      const result = await testLoreActivation(lorebookId, testText);
      const hit = result.activatedIds.includes(active.id);
      if (hit) {
        setTestResult({
          ok: true,
          msg: `Activated! Will be inserted (${active.position}, depth ${active.depth}). Total activated: ${result.activatedIds.length}/${result.totalEntries}.`,
        });
      } else {
        setTestResult({
          ok: false,
          msg: `Not activated. Keys/logic did not match. Total activated: ${result.activatedIds.length}/${result.totalEntries}.`,
        });
      }
    } catch (error) {
      setTestResult({
        ok: false,
        msg: `Request failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return (
    <div className="lore-layout">
      <div className="lore-sidebar">
        <div className="lore-sidebar-head">
          <span className="lore-sidebar-title">World Info ({entries.length})</span>
          <div style={{ display: "flex", gap: 4 }}>
            <div className="iBtn" style={{ width: 24, height: 24 }} title="New entry" onClick={handleAddEntry}>
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
              <div className="lore-item-title">{e.title || "Untitled"}</div>
              <div className="lore-item-keys">{e.keys.length > 0 ? e.keys.join(", ") : "no keys"}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="lore-main">
        {active ? (
          <div style={{ maxWidth: 860 }}>
            <div className="lore-scope">
              <Ic.Book /> Character Lorebook: {charName}
            </div>

            <div style={{ display: "flex", gap: 16, marginBottom: 20 }}>
              <div className="build-field" style={{ flex: 1, marginBottom: 0 }}>
                <label>Entry title</label>
                <input type="text" value={active.title} onChange={(e) => updateAct("title", e.target.value)} />
              </div>
              <div className="build-field" style={{ width: 140, marginBottom: 0 }}>
                <label>Status</label>
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
                    {active.enabled ? "Enabled" : "Disabled"}
                  </span>
                </div>
              </div>
            </div>

            <div style={{ display: "flex", gap: 16, marginBottom: 20 }}>
              <div className="build-field" style={{ flex: 1, marginBottom: 0 }}>
                <label>Primary Keys (activation keys, press Enter)</label>
                <input
                  type="text"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  onKeyDown={(e) => handleKeyAdd(e, "keys")}
                  placeholder="Word or phrase..."
                />
                <div className="build-tags">
                  {active.keys.map((k) => (
                    <span key={k} className="build-tag on" onClick={() => removeKey("keys", k)}>
                      {k} ✕
                    </span>
                  ))}
                </div>
              </div>
              <div className="build-field" style={{ flex: 1, marginBottom: 0 }}>
                <label>Secondary Keys</label>
                <input
                  type="text"
                  value={secKeyInput}
                  onChange={(e) => setSecKeyInput(e.target.value)}
                  onKeyDown={(e) => handleKeyAdd(e, "secondaryKeys")}
                  placeholder="Additional condition..."
                />
                <div className="build-tags">
                  {active.secondaryKeys.map((k) => (
                    <span key={k} className="build-tag on" onClick={() => removeKey("secondaryKeys", k)}>
                      {k} ✕
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className="lore-grid">
              <div className="build-field">
                <label>Logic</label>
                <select
                  value={active.logic}
                  onChange={(e) => updateAct("logic", e.target.value)}
                  style={{
                    width: "100%",
                    height: 38,
                    padding: "0 10px",
                    background: "var(--s2)",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    color: "var(--t1)",
                    outline: "none",
                    fontFamily: "var(--font-ui)",
                  }}
                >
                  <option value="AND_ANY">AND ANY</option>
                  <option value="AND_ALL">AND ALL</option>
                  <option value="NOT_ANY">NOT ANY</option>
                  <option value="NOT_ALL">NOT ALL</option>
                </select>
              </div>
              <div className="build-field">
                <label>Position</label>
                <select
                  value={active.position}
                  onChange={(e) => updateAct("position", e.target.value)}
                  style={{
                    width: "100%",
                    height: 38,
                    padding: "0 10px",
                    background: "var(--s2)",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    color: "var(--t1)",
                    outline: "none",
                    fontFamily: "var(--font-ui)",
                  }}
                >
                  <option value="before_char">Before Char</option>
                  <option value="after_char">After Char</option>
                  <option value="top">Top</option>
                  <option value="bottom">Bottom</option>
                  <option value="at_depth">At Depth @</option>
                </select>
              </div>
              <div className="build-field">
                <label>Depth</label>
                <input
                  type="number"
                  min={0}
                  value={active.depth}
                  onChange={(e) => updateAct("depth", parseInt(e.target.value))}
                  style={{ height: 38, padding: "0 10px" }}
                />
              </div>
              <div className="build-field">
                <label>Priority</label>
                <input
                  type="number"
                  min={0}
                  value={active.priority}
                  onChange={(e) => updateAct("priority", parseInt(e.target.value))}
                  style={{ height: 38, padding: "0 10px" }}
                />
              </div>
              <div className="build-field">
                <label>Sticky Win</label>
                <input
                  type="number"
                  min={0}
                  value={active.sticky}
                  onChange={(e) => updateAct("sticky", parseInt(e.target.value))}
                  style={{ height: 38, padding: "0 10px" }}
                  title="How many turns the entry stays in context after activation"
                />
              </div>
              <div className="build-field">
                <label>Cooldown</label>
                <input
                  type="number"
                  min={0}
                  value={active.cooldown}
                  onChange={(e) => updateAct("cooldown", parseInt(e.target.value))}
                  style={{ height: 38, padding: "0 10px" }}
                  title="Block activation for N turns"
                />
              </div>
              <div className="build-field">
                <label>Delay</label>
                <input
                  type="number"
                  min={0}
                  value={active.delay}
                  onChange={(e) => updateAct("delay", parseInt(e.target.value))}
                  style={{ height: 38, padding: "0 10px" }}
                  title="Delay before insertion"
                />
              </div>
            </div>

            <div className="build-field">
              <label>Content</label>
              <textarea
                value={active.content}
                onChange={(e) => updateAct("content", e.target.value)}
                style={{ minHeight: 180, lineHeight: 1.6 }}
                placeholder="Describe a fact, location, or rule..."
              />
            </div>

            <div className="lore-test-box">
              <div style={{ fontSize: 13, fontWeight: 500, color: "var(--t1)", marginBottom: 8 }}>
                Activation Test (Preview)
              </div>
              <div style={{ fontSize: 12, color: "var(--t3)", marginBottom: 12 }}>
                Check whether the keys of this entry would activate on a specific chat text.
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <input
                  type="text"
                  value={testText}
                  onChange={(e) => setTestText(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && runTest()}
                  placeholder="Enter a test message..."
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
                  Test
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
                Delete Entry
              </button>
            </div>
          </div>
        ) : (
          <div style={{ color: "var(--t3)", fontSize: 14, textAlign: "center", marginTop: 100 }}>
            Select an entry or create a new one
          </div>
        )}
      </div>
    </div>
  );
}
