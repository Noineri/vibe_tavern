/**
 * Dev ThemeTuner — a live, WYSIWYG theme-color workbench.
 *
 * Reachable only via the `#theme-tuner` URL hash (wired in `main.tsx`). It does
 * NOT load the real app, so it needs no backend — it renders real markup-driven
 * components (`Markdown`, `MessageReasoning`) plus faithful replicas of the
 * chrome (sidebar, topbar, input area) on the same Tailwind tokens, so what you
 * see is exactly what a tuned theme produces.
 *
 * Two modes:
 *   - "edit": load a registered theme's CSS (imported via Vite `?raw`), tweak
 *     any color, export a surgically-patched copy (comments preserved).
 *   - "scratch": start from a neutral grayscale ramp and build a brand-new theme.
 *
 * The tool's own chrome uses a fixed dark palette (`.tt-*` classes) so it stays
 * legible no matter how unhinged the colors you experiment with get. Only the
 * preview pane is themed.
 */
import { useEffect, useMemo, useState } from "react";
import { Markdown } from "../../lib/markdown.js";
import { MessageReasoning } from "../chat/MessageReasoning.js";
import { THEMES, applyThemeClass, type ThemeId } from "../../themes/registry.js";
import coffeeRaw from "../../themes/coffee.css?raw";
import milkCoffeeRaw from "../../themes/milk-coffee.css?raw";
import mysticDawnRaw from "../../themes/mystic-dawn.css?raw";
import mysticRaw from "../../themes/mystic-night.css?raw";
import lavaRaw from "../../themes/light-lava.css?raw";
import darkLavaRaw from "../../themes/dark-lava.css?raw";
import {
  GROUPS,
  SCRATCH_VALUES,
  parseThemeCss,
  parsePageBgBlobs,
  parsePageGradient,
  extractTokenValue,
  serializePageGradient,
  serializePageBg,
  upsertPageBgInCss,
  serialize,
  describeColor,
  oklchToHex,
  hexToOklch,
  applyOverridesToCss,
  buildScratchCss,
  type OkColor,
  type Blob,
  type PageGradient,
} from "./color-math.js";

const THEME_RAW: Record<ThemeId, string> = {
  coffee: coffeeRaw,
  "milk-coffee": milkCoffeeRaw,
  "mystic-dawn": mysticDawnRaw,
  "mystic-night": mysticRaw,
  "light-lava": lavaRaw,
  "dark-lava": darkLavaRaw,
};

/** Russian hints for token names, shown in the editor panel. */
const TOKEN_HINTS: Record<string, string> = {
  "--bg": "Основной фон страницы",
  "--surface": "Панели, модалки, топбар",
  "--s2": "Инпуты, ячейки, код-блоки",
  "--s3": "Аватары, статус-бар",
  "--input-bg": "Фон поля ввода чата (recessed)",
  "--user-bg": "Фон сообщения пользователя",
  "--glass-bg": "Фон стеклянных поповеров и панелей",
  "--page-bg": "Градиент страницы (если есть)",
  "--border": "Основные границы",
  "--border2": "Акцентные границы / hover",
  "--t1": "Основной текст UI",
  "--t2": "Вторичный текст",
  "--t3": "Приглушённый текст",
  "--t4": "Самый тусклый текст",
  "--msg-t1": "Тело сообщения",
  "--msg-t2": "Вторичный внутри сообщения",
  "--md-italic": "*Курсив* (действия)",
  "--md-bold": "**Жирный**",
  "--md-bold-italic": "***Комбо***",
  "--md-quoted": "«Прямая речь»",
  "--accent": "Кнопки, ссылки, активные",
  "--accent-t": "Текст акцента",
  "--accent-dim": "Фон выбранной строки",
  "--accent-hover": "Hover по акценту",
  "--accent-mid": "Вторичный цвет логотипа и иллюстраций",
  "--mode-switch-bg": "Фон кнопки Игра / Билд",
  "--mode-switch-text": "Текст кнопки Игра / Билд",
  "--mode-switch-hover-bg": "Фон кнопки Игра / Билд при hover",
  "--mode-switch-hover-text": "Текст кнопки Игра / Билд при hover",
  "--sel-bg": "Фон выделенного текста",
  "--sel-text": "Текст внутри выделения",
  "--danger-strong": "Удалённый фрагмент в diff",
  "--success-strong": "Добавленный фрагмент в diff",
  "--on-accent": "Текст на акценте",
  "--on-danger": "Текст на danger",
};

type Mode = "edit" | "scratch";

// ─── Sample content (drives the live preview) ───────────────────────────

const SAMPLE_CHAR =
  "*Мост гудел — низкий звук шин по мокрому асфальту.* Эдриан любил этот вид ночью: " +
  "два берега, залитых огнём бессонного города.\n\n" +
  "Его рука обвила её талию — твёрдо. **\"Не смей.\"** *Голос остался тихим:* " +
  "\"Что ты делаешь?\" Она ***рассмеялась*** — `звонко`, ярко, невыносимо.";

const SAMPLE_REASONING =
  "Analyze input. Translation: **\"Hello!\"** with a cheerful tone. " +
  "*The wildcard: Noi's optimism is a genuine attempt at connection — " +
  "a vulnerability he doesn't expect.* Decision: lower guard slightly.";

const SAMPLE_USER = "*\"Привет!\"* — жизнерадостно сказала я, плюхаясь рядом с ним.";

// ─── Component ──────────────────────────────────────────────────────────

export function ThemeTuner() {
  const [mode, setMode] = useState<Mode>("edit");
  const [editId, setEditId] = useState<ThemeId>("milk-coffee");
  const [scratchName, setScratchName] = useState("my-theme");
  const [values, setValues] = useState<Map<string, OkColor>>(() => new Map());
  const [originals, setOriginals] = useState<Map<string, OkColor>>(() => new Map());
  const [selected, setSelected] = useState<string | null>(null);
  const [blobs, setBlobs] = useState<Blob[]>([]);
  const [blobOriginals, setBlobOriginals] = useState<Blob[]>([]);
  const [selectedBlob, setSelectedBlob] = useState<number | null>(null);
  const [pageGradient, setPageGradient] = useState<PageGradient | null>(null);
  const [gradientOriginal, setGradientOriginal] = useState<PageGradient | null>(null);
  const [editingPageBase, setEditingPageBase] = useState(false);
  const [tokenComments, setTokenComments] = useState<Map<string, string>>(() => new Map());
  const [tokenCommentOriginals, setTokenCommentOriginals] = useState<Map<string, string>>(() => new Map());
  const [drifting, setDrifting] = useState(true);
  const [showHoverStates, setShowHoverStates] = useState(false);
  const [exportText, setExportText] = useState<string | null>(null);

  // Initialize values and the complete page-background stack when mode/theme changes.
  useEffect(() => {
    if (mode === "scratch") {
      const v = new Map<string, OkColor>();
      for (const [k, val] of SCRATCH_VALUES) v.set(k, { ...val });
      setValues(v);
      setOriginals(new Map(v));
      setTokenComments(new Map());
      setTokenCommentOriginals(new Map());
      setBlobs([]);
      setBlobOriginals([]);
      setPageGradient(null);
      setGradientOriginal(null);
    } else {
      const tokens = parseThemeCss(THEME_RAW[editId]);
      const v = new Map<string, OkColor>();
      const o = new Map<string, OkColor>();
      for (const t of tokens) {
        if (t.color) {
          v.set(t.name, { ...t.color });
          o.set(t.name, { ...t.color });
        }
      }
      setValues(v);
      setOriginals(o);
      const tc = new Map<string, string>();
      const tco = new Map<string, string>();
      for (const t of tokens) {
        tc.set(t.name, t.comment);
        tco.set(t.name, t.comment);
      }
      setTokenComments(tc);
      setTokenCommentOriginals(tco);
      const pageBg = extractTokenValue(THEME_RAW[editId], "--page-bg");
      const parsedBlobs = pageBg ? parsePageBgBlobs(pageBg) : [];
      const parsedGradient = pageBg ? parsePageGradient(pageBg) : null;
      setBlobs(parsedBlobs);
      setBlobOriginals(parsedBlobs.map((b) => ({ ...b, color: { ...b.color } })));
      setPageGradient(parsedGradient);
      setGradientOriginal(parsedGradient ? structuredClone(parsedGradient) : null);
    }
    setSelected(null);
    setSelectedBlob(null);
    setEditingPageBase(false);
  }, [mode, editId]);

  // Apply current values to <html> as inline overrides; clean up on unmount.
  useEffect(() => {
    const root = document.documentElement;
    applyThemeClass(root, mode === "scratch" ? "coffee" : editId);
    const names: string[] = [];
    for (const [name, col] of values) {
      root.style.setProperty(name, serialize(col));
      names.push(name);
    }
    return () => {
      for (const p of names) root.style.removeProperty(p);
    };
  }, [values, mode, editId]);

  // Apply the editable background stack exactly as production applies --page-bg.
  // The solid state still needs an explicit var(--bg) override: merely removing
  // the inline value would reveal a selected theme's original fixed gradient.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--page-bg", serializePageBg(blobs, pageGradient));
    return () => {
      root.style.removeProperty("--page-bg");
    };
  }, [blobs, pageGradient]);

  const selectedCol = selected ? values.get(selected) ?? null : null;

  function updateSelected(patch: Partial<OkColor>) {
    if (!selected || !selectedCol) return;
    const next = new Map(values);
    next.set(selected, { ...selectedCol, ...patch });
    setValues(next);
  }

  function resetSelected() {
    if (!selected) return;
    const orig = originals.get(selected);
    if (!orig) return;
    const next = new Map(values);
    next.set(selected, { ...orig });
    setValues(next);
  }

  function setPageGradientKind(kind: "solid" | PageGradient["kind"]) {
    if (kind === "solid") {
      setPageGradient(null);
      return;
    }
    setPageGradient((current) => {
      const start = current?.start ?? {
        color: { ...(values.get("--surface") ?? values.get("--bg") ?? { l: 0.6, c: 0.05, h: 250, a: null }) },
        position: 0,
      };
      const end = current?.end ?? {
        color: { ...(values.get("--bg") ?? { l: 0.2, c: 0.03, h: 250, a: null }) },
        position: 100,
      };
      if (kind === "linear") {
        return { kind, angle: current?.kind === "linear" ? current.angle : 180, start, end };
      }
      return {
        kind,
        x: current?.kind === "radial" ? current.x : 50,
        y: current?.kind === "radial" ? current.y : 0,
        start,
        end,
      };
    });
  }

  function resetPageGradient() {
    setPageGradient(gradientOriginal ? structuredClone(gradientOriginal) : null);
  }

  function updateBlobColor(patch: Partial<OkColor>) {
    if (selectedBlob == null) return;
    setBlobs((prev) =>
      prev.map((b, i) => (i === selectedBlob ? { ...b, color: { ...b.color, ...patch } } : b)),
    );
  }

  function updateBlobPos(key: "x" | "y" | "size", v: number) {
    if (selectedBlob == null) return;
    setBlobs((prev) => prev.map((b, i) => (i === selectedBlob ? { ...b, [key]: v } : b)));
  }

  function updateBlobComment(v: string) {
    if (selectedBlob == null) return;
    setBlobs((prev) => prev.map((b, i) => (i === selectedBlob ? { ...b, comment: v } : b)));
  }

  function updateTokenComment(name: string, v: string) {
    setTokenComments((prev) => new Map(prev).set(name, v));
  }

  function resetBlob() {
    if (selectedBlob == null) return;
    const orig = blobOriginals[selectedBlob];
    if (!orig) return;
    setBlobs((prev) =>
      prev.map((b, i) => (i === selectedBlob ? { ...orig, color: { ...orig.color } } : b)),
    );
  }

  /** Append a new blob at a free-ish center point, cloned from the last blob's
   *  color (or a neutral accent-tinted swatch for themes that had none). Selects
   *  it so the editor opens immediately. */
  function addBlob() {
    const last = blobs[blobs.length - 1];
    const color: OkColor = last
      ? { ...last.color, a: last.color.a ?? 0.5 }
      : { l: 0.6, c: 0.15, h: 290, a: 0.5 };
    // Prefill the comment from the color so the new layer is labeled the
    // moment it's added; the user can edit or clear it in the editor.
    const next = [...blobs, { x: 50, y: 50, color, size: 50, comment: describeColor(color) }];
    setBlobs(next);
    setSelectedBlob(next.length - 1);
    setSelected(null);
    setEditingPageBase(false);
  }

  /** Remove a blob; clamp selection to a neighbor so the editor doesn't go
   *  blank mid-edit. */
  function removeBlob(i: number) {
    setBlobs((prev) => prev.filter((_, idx) => idx !== i));
    setSelectedBlob((cur) => {
      if (cur == null) return null;
      if (cur === i) return blobs.length > 1 ? Math.max(0, i - 1) : null;
      return cur > i ? cur - 1 : cur;
    });
  }

  function handleExport() {
    if (mode === "scratch") {
      let css = buildScratchCss(scratchName.trim() || "my-theme", values);
      const pageBg = serializePageBg(blobs, pageGradient);
      if (pageBg !== "var(--bg)") css = upsertPageBgInCss(css, pageBg);
      setExportText(css);
      return;
    }
    const overrides = new Map<string, string>();
    for (const [name, col] of values) {
      const orig = originals.get(name);
      if (!orig || serialize(orig) !== serialize(col)) {
        overrides.set(name, serialize(col));
      }
    }
    // Collect changed comments (diff vs the parsed originals) so comment-only
    // edits export even when the color itself wasn't touched.
    const comments = new Map<string, string>();
    for (const name of new Set([...tokenComments.keys(), ...tokenCommentOriginals.keys()])) {
      const cur = tokenComments.get(name) ?? "";
      const orig = tokenCommentOriginals.get(name) ?? "";
      if (cur !== orig) comments.set(name, cur);
    }
    let css = applyOverridesToCss(THEME_RAW[editId], overrides, comments);
    // Export the complete stack, including deletion of every blob or switching
    // a fixed gradient back to the linked solid --bg fallback.
    const currentPageBg = serializePageBg(blobs, pageGradient);
    const originalPageBg = serializePageBg(blobOriginals, gradientOriginal);
    if (currentPageBg !== originalPageBg) {
      css = upsertPageBgInCss(css, currentPageBg);
    }
    setExportText(css);
  }

  return (
    <div className="tt-root">
      <style>{TT_CSS}</style>

      {/* ─── Left: controls ─── */}
      <aside className="tt-controls">
        <header className="tt-head">
          <h1>Theme Tuner</h1>
          <p>Цвета, фон страницы и live-превью</p>
        </header>

        <div className="tt-mode">
          <button
            type="button"
            className={mode === "edit" ? "tt-mode-btn active" : "tt-mode-btn"}
            onClick={() => setMode("edit")}
          >
            Поправить тему
          </button>
          <button
            type="button"
            className={mode === "scratch" ? "tt-mode-btn active" : "tt-mode-btn"}
            onClick={() => setMode("scratch")}
          >
            С нуля
          </button>
        </div>

        {mode === "edit" ? (
          <label className="tt-field">
            <span>Тема</span>
            <select value={editId} onChange={(e) => setEditId(e.target.value as ThemeId)}>
              {THEMES.map((t) => (
                <option key={t.id} value={t.id}>{t.id}</option>
              ))}
            </select>
          </label>
        ) : (
          <label className="tt-field">
            <span>className новой темы</span>
            <input
              value={scratchName}
              onChange={(e) => setScratchName(e.target.value)}
              placeholder="my-theme"
            />
          </label>
        )}

        <div className="tt-scroll">
          <div className="tt-group">
            <div className="tt-group-title">Фон страницы (--page-bg)</div>
            <div className="tt-layer-label">Основа</div>
            <PageBaseRow
              gradient={pageGradient}
              active={editingPageBase}
              onClick={() => {
                setEditingPageBase(true);
                setSelectedBlob(null);
                setSelected(null);
              }}
            />
            <div className="tt-layer-head">
              <span className="tt-layer-label">Плавающие пятна поверх основы</span>
              <button type="button" className="tt-layer-add" onClick={addBlob}>+ Добавить</button>
            </div>
            {blobs.length === 0 ? (
              <div className="tt-blob-empty">Пятен пока нет — их можно добавить к любой теме.</div>
            ) : (
              blobs.map((b, i) => (
                <BlobRow
                  key={i}
                  index={i}
                  color={b.color}
                  x={b.x}
                  y={b.y}
                  active={selectedBlob === i}
                  onClick={() => { setSelectedBlob(i); setSelected(null); setEditingPageBase(false); }}
                  onRemove={() => removeBlob(i)}
                />
              ))
            )}
          </div>
          {GROUPS.map((g) => {
            const present = g.tokens.filter((t) => values.has(t));
            if (present.length === 0) return null;
            return (
              <div className="tt-group" key={g.title}>
                <div className="tt-group-title">{g.title}</div>
                {present.map((tok) => (
                  <SwatchRow
                    key={tok}
                    name={tok}
                    color={values.get(tok)!}
                    active={selected === tok}
                    onClick={() => { setSelected(tok); setSelectedBlob(null); setEditingPageBase(false); }}
                  />
                ))}
              </div>
            );
          })}
        </div>

        <footer className="tt-foot">
          <button type="button" className="tt-export" onClick={handleExport}>
            Экспортировать .css
          </button>
        </footer>
      </aside>

      {/* ─── Center: live preview ─── */}
      <main className="tt-stage">
        <div className="tt-stage-label">
          <span>ПРЕВЬЮ {mode === "edit" ? `— ${editId}.css` : `— с нуля («${scratchName || "my-theme"}»)`}</span>
          <div className="tt-stage-actions">
            <button
              type="button"
              className={showHoverStates ? "tt-drift-toggle active" : "tt-drift-toggle"}
              onClick={() => setShowHoverStates((visible) => !visible)}
              title="Зафиксировать hover-состояния в preview"
            >
              {showHoverStates ? "◆ Hover показан" : "◇ Показать hover"}
            </button>
            <button
              type="button"
              className="tt-drift-toggle"
              disabled={blobs.length === 0}
              onClick={() => setDrifting((d) => !d)}
              title={drifting ? "Остановить дрейф пятен" : "Запустить дрейф пятен"}
            >
              {drifting ? "⏸ Стоп" : "▶ Дрейф"}
            </button>
          </div>
        </div>
        <Preview drifting={drifting && blobs.length > 0} showHoverStates={showHoverStates} />

        <div className="tt-demos-label">ДОПОЛНИТЕЛЬНО: код, семантика, матовое стекло</div>
        <DemoStrip />
      </main>

      {/* ─── Right: editor ─── */}
      <aside className="tt-editor">
        {editingPageBase ? (
          <PageGradientEditor
            gradient={pageGradient}
            canReset={serializePageBg([], pageGradient) !== serializePageBg([], gradientOriginal)}
            onKindChange={setPageGradientKind}
            onChange={setPageGradient}
            onReset={resetPageGradient}
          />
        ) : selectedBlob != null && blobs[selectedBlob] ? (
          <BlobEditor
            index={selectedBlob}
            blob={blobs[selectedBlob]}
            comment={blobs[selectedBlob].comment ?? ""}
            canReset={
              blobOriginals[selectedBlob] != null &&
              serializePageBg([blobs[selectedBlob]]) !==
                serializePageBg([blobOriginals[selectedBlob]])
            }
            onColorChange={updateBlobColor}
            onPosChange={updateBlobPos}
            onCommentChange={updateBlobComment}
            onReset={resetBlob}
          />
        ) : selectedCol ? (
          <Editor
            name={selected!}
            color={selectedCol}
            comment={tokenComments.get(selected!) ?? ""}
            hint={TOKEN_HINTS[selected!] ?? selected}
            canReset={mode === "edit" && originals.has(selected!) &&
              serialize(originals.get(selected!)!) !== serialize(selectedCol)}
            onChange={updateSelected}
            onCommentChange={(v) => selected && updateTokenComment(selected, v)}
            onReset={resetSelected}
          />
        ) : (
          <div className="tt-editor-empty">
            <div className="tt-editor-empty-icon">◆</div>
            <p>Выберите цвет слева, чтобы настроить его.</p>
            <p className="tt-editor-empty-sub">
              Нативный пикер — для быстрого выбора / пипетки.<br />
              OKLCH-слайдеры — для точной светлоты и насыщенности.
            </p>
          </div>
        )}
      </aside>

      {exportText && (
        <ExportModal
          text={exportText}
          title={mode === "scratch" ? "Готовый CSS (новая тема)" : `Готовый CSS (патч поверх ${editId}.css)`}
          onClose={() => setExportText(null)}
        />
      )}
    </div>
  );
}

// ─── Swatch row (left list) ─────────────────────────────────────────────

function PageBaseRow({
  gradient, active, onClick,
}: {
  gradient: PageGradient | null;
  active: boolean;
  onClick: () => void;
}) {
  const label = gradient?.kind === "linear"
    ? `линейный · ${Math.round(gradient.angle)}°`
    : gradient?.kind === "radial"
      ? `радиальный · ${Math.round(gradient.x)} / ${Math.round(gradient.y)}`
      : "сплошной · --bg";
  return (
    <button type="button" className={active ? "tt-swatch-row active" : "tt-swatch-row"} onClick={onClick}>
      <span
        className="tt-swatch tt-base-swatch"
        style={{ background: gradient ? serializePageGradient(gradient) : "var(--bg)" }}
      />
      <span className="tt-swatch-name">Основа</span>
      <span className="tt-swatch-val">{label}</span>
    </button>
  );
}

function SwatchRow({
  name, color, active, onClick,
}: { name: string; color: OkColor; active: boolean; onClick: () => void }) {
  return (
    <button type="button" className={active ? "tt-swatch-row active" : "tt-swatch-row"} onClick={onClick}>
      <span className="tt-swatch" style={{ background: serialize(color) }} />
      <span className="tt-swatch-name">{name.replace(/^--/, "")}</span>
      <span className="tt-swatch-val">{serialize(color)}</span>
    </button>
  );
}

function BlobRow({
  index, color, x, y, active, onClick, onRemove,
}: {
  index: number;
  color: OkColor;
  x: number;
  y: number;
  active: boolean;
  onClick: () => void;
  onRemove: () => void;
}) {
  return (
    <div className={active ? "tt-swatch-row active" : "tt-swatch-row"}>
      <button type="button" className="tt-swatch-row-main" onClick={onClick}>
        <span className="tt-swatch" style={{ background: serialize(color) }} />
        <span className="tt-swatch-name">Пятно {index + 1}</span>
        <span className="tt-swatch-val">{Math.round(x)}% · {Math.round(y)}%</span>
      </button>
      <button type="button" className="tt-swatch-del" onClick={onRemove} title="Удалить пятно" aria-label={`Удалить пятно ${index + 1}`}>×</button>
    </div>
  );
}

// ─── Editor (right) ─────────────────────────────────────────────────────

function Editor({
  name, color, comment, hint, canReset, onChange, onCommentChange, onReset,
}: {
  name: string;
  color: OkColor;
  comment: string;
  hint: string;
  canReset: boolean;
  onChange: (patch: Partial<OkColor>) => void;
  onCommentChange: (v: string) => void;
  onReset: () => void;
}) {
  return (
    <div className="tt-editor-inner">
      <div className="tt-ed-name">{name}</div>
      <div className="tt-ed-hint">{hint}</div>
      <ColorFields color={color} onChange={onChange} />
      <CommentField
        value={comment}
        suggest={describeColor(color)}
        onChange={onCommentChange}
      />
      {canReset && (
        <button type="button" className="tt-ed-reset" onClick={onReset}>Сбросить к оригиналу</button>
      )}
    </div>
  );
}

/** Shared color controls (preview + native picker + L/C/H/A sliders), reused by
 *  both the token Editor and the BlobEditor. */
function ColorFields({
  color, onChange,
}: { color: OkColor; onChange: (patch: Partial<OkColor>) => void }) {
  const hex = oklchToHex(color.l, color.c, color.h);
  const hasAlpha = color.a != null;

  // Slider track gradients, recomputed from the current color.
  const gradL = useMemo(() => {
    const s = [];
    for (let i = 0; i <= 10; i++) s.push(oklchToHex(i / 10, color.c, color.h));
    return `linear-gradient(to right, ${s.join(",")})`;
  }, [color.c, color.h]);
  const gradC = useMemo(() => {
    const s = [];
    for (let i = 0; i <= 10; i++) s.push(oklchToHex(color.l, i * 0.04, color.h));
    return `linear-gradient(to right, ${s.join(",")})`;
  }, [color.l, color.h]);
  const gradH = useMemo(() => {
    const s = [];
    for (let i = 0; i <= 12; i++) s.push(oklchToHex(color.l, Math.max(color.c, 0.08), i * 30));
    return `linear-gradient(to right, ${s.join(",")})`;
  }, [color.l, color.c]);

  return (
    <>
      <div className="tt-ed-preview" style={{ background: serialize(color) }} />

      {/* Native OS color picker + hex */}
      <div className="tt-ed-native">
        <input
          type="color"
          value={hex}
          onChange={(e) => {
            const [l, c, h] = hexToOklch(e.target.value);
            onChange({ l, c, h });
          }}
          aria-label="Системный выбор цвета"
        />
        <input
          className="tt-ed-hex"
          type="text"
          value={hex}
          onChange={(e) => {
            const v = e.target.value.trim();
            if (/^#([0-9a-f]{6}|[0-9a-f]{3})$/i.test(v)) {
              const [l, c, h] = hexToOklch(v);
              onChange({ l, c, h });
            }
          }}
          spellCheck={false}
        />
      </div>

      <Slider label="L — Светлота" min={0} max={1} step={0.005} value={color.l} track={gradL}
        onChange={(v) => onChange({ l: v })} />
      <Slider label="C — Насыщенность" min={0} max={0.4} step={0.005} value={color.c} track={gradC}
        onChange={(v) => onChange({ c: v })} />
      <Slider label="H — Тон" min={0} max={360} step={1} value={color.h} track={gradH}
        onChange={(v) => onChange({ h: v })} />
      {hasAlpha && (
        <Slider label="A — Прозрачность" min={0} max={1} step={0.01} value={color.a ?? 1}
          track="linear-gradient(to right, transparent, currentColor)"
          onChange={(v) => onChange({ a: v })} />
      )}

      <div className="tt-ed-string">{serialize(color)}</div>
    </>
  );
}

/** Editor for a single --page-bg blob: full color controls (incl. alpha for
 *  layering) plus x/y anchor position and transparent-falloff size. */
function BlobEditor({
  index, blob, comment, canReset, onColorChange, onPosChange, onCommentChange, onReset,
}: {
  index: number;
  blob: Blob;
  comment: string;
  canReset: boolean;
  onColorChange: (patch: Partial<OkColor>) => void;
  onPosChange: (key: "x" | "y" | "size", v: number) => void;
  onCommentChange: (v: string) => void;
  onReset: () => void;
}) {
  const posTrack = "linear-gradient(to right, var(--border), var(--accent))";
  return (
    <div className="tt-editor-inner">
      <div className="tt-ed-name">Пятно {index + 1}</div>
      <div className="tt-ed-hint">Цветовое пятно фона страницы: цвет, прозрачность и позиция</div>
      <ColorFields color={blob.color} onChange={onColorChange} />
      <CommentField
        value={comment}
        suggest={describeColor(blob.color)}
        onChange={onCommentChange}
      />
      <div className="tt-ed-sep" />
      <Slider label="X — позиция" min={0} max={100} step={1} value={blob.x} track={posTrack}
        onChange={(v) => onPosChange("x", v)} />
      <Slider label="Y — позиция" min={0} max={100} step={1} value={blob.y} track={posTrack}
        onChange={(v) => onPosChange("y", v)} />
      <Slider label="Размер — радиус" min={10} max={100} step={1} value={blob.size} track={posTrack}
        onChange={(v) => onPosChange("size", v)} />
      {canReset && (
        <button type="button" className="tt-ed-reset" onClick={onReset}>Сбросить к оригиналу</button>
      )}
    </div>
  );
}

function PageGradientEditor({
  gradient, canReset, onKindChange, onChange, onReset,
}: {
  gradient: PageGradient | null;
  canReset: boolean;
  onKindChange: (kind: "solid" | PageGradient["kind"]) => void;
  onChange: (gradient: PageGradient) => void;
  onReset: () => void;
}) {
  const [selectedStop, setSelectedStop] = useState<"start" | "end">("start");
  const kind = gradient?.kind ?? "solid";

  function updateStop(colorPatch: Partial<OkColor>, position?: number) {
    if (!gradient) return;
    const current = gradient[selectedStop];
    const nextStop = {
      color: { ...current.color, ...colorPatch },
      position: position ?? current.position,
    };
    const start = selectedStop === "start" ? nextStop : gradient.start;
    const end = selectedStop === "end" ? nextStop : gradient.end;
    onChange(gradient.kind === "linear" ? { ...gradient, start, end } : { ...gradient, start, end });
  }

  return (
    <div className="tt-editor-inner">
      <div className="tt-ed-name">Основа --page-bg</div>
      <div className="tt-ed-hint">Обычный градиент лежит под плавающими пятнами и совпадает с фоном production body.</div>
      <div className="tt-gradient-kinds">
        {(["solid", "linear", "radial"] as const).map((option) => (
          <button
            key={option}
            type="button"
            className={kind === option ? "active" : ""}
            onClick={() => onKindChange(option)}
          >
            {option === "solid" ? "Сплошной" : option === "linear" ? "Линейный" : "Радиальный"}
          </button>
        ))}
      </div>

      {gradient ? (
        <>
          <div className="tt-gradient-stops">
            <button type="button" className={selectedStop === "start" ? "active" : ""} onClick={() => setSelectedStop("start")}>
              <span style={{ background: serialize(gradient.start.color) }} /> Цвет 1
            </button>
            <button type="button" className={selectedStop === "end" ? "active" : ""} onClick={() => setSelectedStop("end")}>
              <span style={{ background: serialize(gradient.end.color) }} /> Цвет 2
            </button>
          </div>
          <ColorFields color={gradient[selectedStop].color} onChange={(patch) => updateStop(patch)} />
          <Slider
            label={`${selectedStop === "start" ? "Цвет 1" : "Цвет 2"} — позиция`}
            min={0}
            max={100}
            step={1}
            value={gradient[selectedStop].position}
            track="linear-gradient(to right, var(--border), var(--accent))"
            onChange={(position) => updateStop({}, position)}
          />
          <div className="tt-ed-sep" />
          {gradient.kind === "linear" ? (
            <Slider label="Угол" min={0} max={360} step={1} value={gradient.angle}
              track="linear-gradient(to right, var(--border), var(--accent))"
              onChange={(angle) => onChange({ ...gradient, angle })} />
          ) : (
            <>
              <Slider label="X — центр" min={0} max={100} step={1} value={gradient.x}
                track="linear-gradient(to right, var(--border), var(--accent))"
                onChange={(x) => onChange({ ...gradient, x })} />
              <Slider label="Y — центр" min={0} max={100} step={1} value={gradient.y}
                track="linear-gradient(to right, var(--border), var(--accent))"
                onChange={(y) => onChange({ ...gradient, y })} />
            </>
          )}
          <div className="tt-ed-string">{serializePageGradient(gradient)}</div>
        </>
      ) : (
        <div className="tt-gradient-solid-note">Используется связанный <code>var(--bg)</code>. Изменение --bg сразу обновляет фон.</div>
      )}
      {canReset && (
        <button type="button" className="tt-ed-reset" onClick={onReset}>Сбросить к оригиналу</button>
      )}
    </div>
  );
}

function Slider({
  label, min, max, step, value, track, onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  track: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="tt-slider-row">
      <div className="tt-slider-head">
        <span>{label}</span>
        <input
          className="tt-slider-num"
          type="number"
          min={min}
          max={max}
          step={step}
          value={Math.round(value * 1000) / 1000}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (!Number.isNaN(v)) onChange(v);
          }}
        />
      </div>
      <input
        className="tt-slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ background: track }}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </div>
  );
}

/** Editable CSS comment for a token or blob. Placeholder shows the
 *  describeColor() suggestion so an empty field still hints at a label; the
 *  "⟳ auto" button fills the field with that suggestion (overwrites whatever's
 *  there — meant as a starting point, not live re-derivation, so user edits
 *  survive color tweaks). */
function CommentField({
  value, suggest, onChange,
}: {
  value: string;
  suggest: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="tt-comment">
      <div className="tt-slider-head">
        <span>Подпись в CSS</span>
        <button
          type="button"
          className="tt-comment-regen"
          onClick={() => onChange(suggest)}
          title={`Подставить: ${suggest}`}
        >⟳ авто</button>
      </div>
      <input
        className="tt-comment-input"
        type="text"
        value={value}
        placeholder={suggest}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
    </div>
  );
}

// ─── Preview (real components + chrome replica) ─────────────────────────

function Preview({ drifting, showHoverStates }: { drifting: boolean; showHoverStates: boolean }) {
  const windowClass = [
    "tt-window",
    drifting ? "tt-window-drift" : "",
    showHoverStates ? "tt-window-show-states" : "",
  ].filter(Boolean).join(" ");
  return (
    <div className={windowClass}>
      {/* Sidebar replica */}
      <div className="tt-win-sidebar">
        <div className="tt-win-brand">
          <span className="tt-win-logo">V</span>
          <span className="tt-win-logo-name">Vibe Tavern</span>
        </div>
        <div className="tt-win-section">Персонажи</div>
        <div className="tt-win-list">
          <SidebarItem initials="ZF" name="Zack Foster" previewHover />
          <SidebarItem initials="AM" name="Adrian Mor" active />
          <SidebarItem initials="AL" name="Alien" />
          <SidebarItem initials="AN" name="Andrea" />
        </div>
        <div className="tt-win-persona">
          <span className="tt-win-avatar-sm">N</span>
          <span className="tt-win-persona-label">Noi — персона</span>
        </div>
      </div>

      {/* Main column */}
      <div className="tt-win-main">
        <div className="tt-win-topbar">
          <span className="tt-win-top-avatar">AM</span>
          <span className="tt-win-name">Adrian Mor</span>
          <span className="tt-win-memory preview-hover"><i /> Память</span>
          <span className="tt-win-provider preview-hover"><i /> OpenRouter <b>·</b> Kimi K2</span>
          <button type="button" className="tt-win-mode-switch preview-hover">Вернуться к игре</button>
        </div>

        <div className="tt-win-messages">
          {/* Char message */}
          <div className="tt-msg preview-hover">
            <div className="tt-msg-head">
              <span className="tt-msg-avatar">AM</span>
              <span className="tt-msg-author">Adrian Mor</span>
            </div>
            {/* Real renderer — exactly what production messages use */}
            <MessageReasoning
              reasoning={SAMPLE_REASONING}
              reasoningDurationMs={1480}
              defaultOpen
            />
            <div className="tt-msg-body">
              <Markdown text={SAMPLE_CHAR} />
            </div>
            <div className="tt-msg-meta">
              <span>16:58</span><span>360 токенов</span>
            </div>
            <div className="tt-msg-actions">
              <span>⌘ Копировать</span><span>✎ Изменить</span><span>⑂ Ветка</span>
            </div>
          </div>

          {/* User message — full-width surface, matching MessageBlock. */}
          <div className="tt-msg tt-msg-user">
            <div className="tt-msg-user-head">
              <span className="tt-msg-user-name">Noi</span>
              <span className="tt-msg-avatar">N</span>
            </div>
            <div className="tt-msg-user-body">
              <div className="tt-msg-user-content"><Markdown text={SAMPLE_USER} /></div>
            </div>
            <div className="tt-msg-user-meta">05:16 · 35 токенов</div>
          </div>
        </div>

        {/* Input bar replica */}
        <div className="tt-win-inputbar">
          <div className="tt-win-textarea">Продолжите историю…</div>
          <div className="tt-win-inputbar-bottom">
            <span className="tt-win-speakas">
              ГОВОРИТЬ КАК <span className="tt-win-avatar-xs">N</span> Noi
              <span className="tt-win-tokens">1 913 / 256 000</span>
            </span>
            <button type="button" className="tt-win-send">Отправить</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SidebarItem({ initials, name, active, previewHover }: { initials: string; name: string; active?: boolean; previewHover?: boolean }) {
  const className = ["tt-win-item", active ? "active" : "", previewHover ? "preview-hover" : ""].filter(Boolean).join(" ");
  return (
    <div className={className}>
      <span className={active ? "tt-win-avatar tt-win-avatar-active" : "tt-win-avatar"}>{initials}</span>
      <span className="tt-win-item-name">{name}</span>
    </div>
  );
}

// ─── Demo strip: code, syntax, semantic, frosted glass ──────────────────

function DemoStrip() {
  return (
    <div className="tt-demos">
      {/* Markdown code block (md-pre) + raw syntax spans */}
      <div className="tt-demo-card">
        <div className="tt-demo-card-label">Код: md-pre + --syn-*</div>
        <pre className="md-pre tt-code">
          <SyntaxSnippet />
        </pre>
      </div>

      {/* Semantic badges / buttons */}
      <div className="tt-demo-card">
        <div className="tt-demo-card-label">Семантика</div>
        <div className="tt-badges">
          <span className="tt-badge tt-badge-success">● Успех</span>
          <span className="tt-badge tt-badge-info">Инфо</span>
          <span className="tt-badge tt-badge-warning">Внимание</span>
          <span className="tt-badge tt-badge-danger">Удалить</span>
        </div>
        <div className="tt-buttons">
          <button type="button" className="tt-btn-accent">Отправить</button>
          <button type="button" className="tt-btn-danger">Удалить</button>
        </div>
      </div>

      {/* Frosted glass over a gradient */}
      <div className="tt-demo-card">
        <div className="tt-demo-card-label">Матовое стекло (реальный --glass-bg)</div>
        <div
          className="tt-frost-bg"
          style={{ background: "linear-gradient(135deg, var(--accent), var(--info) 55%, var(--success))" }}
        >
          <div className="tt-frost-panel">
            <code>bg-glass-bg + glass-blur</code>
            <p>В lava-темах фон пропускает цвет и размывает его.</p>
          </div>
        </div>
      </div>

      <div className="tt-demo-card">
        <div className="tt-demo-card-label">Выделение, логотип и diff</div>
        <div className="tt-selection-sample">Так выглядит выделенный текст</div>
        <div className="tt-token-samples">
          <span className="tt-accent-mid-sample">accent-mid</span>
          <span className="tt-diff-remove">старый фрагмент</span>
          <span className="tt-diff-add">новый фрагмент</span>
        </div>
      </div>
    </div>
  );
}

function SyntaxSnippet() {
  return (
    <code>
      <span style={{ color: "var(--syn-keyword)" }}>const</span>{" "}
      <span style={{ color: "var(--syn-variable)" }}>greeting</span>{" "}
      <span style={{ color: "var(--syn-operator)" }}>=</span>{" "}
      <span style={{ color: "var(--syn-string)" }}>"Adrian"</span>
      <span style={{ color: "var(--syn-punctuation)" }}>;</span>{" "}
      <span style={{ color: "var(--syn-comment)" }}>// привет</span>
      {"\n"}
      <span style={{ color: "var(--syn-keyword)" }}>function</span>{" "}
      <span style={{ color: "var(--syn-function)" }}>greet</span>
      <span style={{ color: "var(--syn-punctuation)" }}>(</span>
      <span style={{ color: "var(--syn-property)" }}>name</span>
      <span style={{ color: "var(--syn-punctuation)" }}>) {"{"}</span>
      {"\n  "}
      <span style={{ color: "var(--syn-keyword)" }}>if</span>{" "}
      <span style={{ color: "var(--syn-punctuation)" }}>(</span>
      <span style={{ color: "var(--syn-bool)" }}>true</span>
      <span style={{ color: "var(--syn-punctuation)" }}>) </span>
      <span style={{ color: "var(--syn-keyword)" }}>return</span>{" "}
      <span style={{ color: "var(--syn-null)" }}>null</span>
      <span style={{ color: "var(--syn-punctuation)" }}>;</span>
      {"\n  "}
      <span style={{ color: "var(--syn-keyword)" }}>return</span>{" "}
      <span style={{ color: "var(--syn-number)" }}>42</span>
      <span style={{ color: "var(--syn-punctuation)" }}>;</span>
      {"\n"}
      <span style={{ color: "var(--syn-punctuation)" }}>{"}"}</span>
    </code>
  );
}

// ─── Export modal ───────────────────────────────────────────────────────

function ExportModal({ text, title, onClose }: { text: string; title: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="tt-modal-overlay" onClick={onClose}>
      <div className="tt-modal" onClick={(e) => e.stopPropagation()}>
        <div className="tt-modal-head">
          <span>{title}</span>
          <button type="button" className="tt-modal-x" onClick={onClose}>×</button>
        </div>
        <textarea className="tt-modal-text" value={text} readOnly spellCheck={false} />
        <div className="tt-modal-foot">
          <button
            type="button"
            className="tt-export"
            onClick={() => {
              navigator.clipboard.writeText(text).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1800);
              });
            }}
          >
            {copied ? "Скопировано ✓" : "Скопировать"}
          </button>
          <button type="button" className="tt-reset" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </div>
  );
}

// ─── Tool-chrome CSS (fixed dark palette, never themed) ─────────────────

const TT_CSS = `
.tt-root{display:flex;height:100vh;width:100vw;overflow:hidden;background:#16140f;color:#c8bca8;font-family:'Inter',system-ui,sans-serif;font-size:13px}

/* controls */
.tt-controls{width:300px;min-width:300px;background:#1e1c18;border-right:1px solid #34302a;display:flex;flex-direction:column;overflow:hidden}
.tt-head{padding:14px 18px 11px;border-bottom:1px solid #34302a}
.tt-head h1{font-size:13px;font-weight:600;color:#e2d6c2;letter-spacing:.04em;text-transform:uppercase}
.tt-head p{font-size:11px;color:#6f655b;margin-top:3px}
.tt-mode{display:flex;gap:6px;padding:10px 14px 0}
.tt-mode-btn{flex:1;padding:7px 4px;background:#25221c;border:1px solid #34302a;border-radius:5px;color:#8a7e70;font-size:11.5px;cursor:pointer;font-family:inherit;transition:all .12s}
.tt-mode-btn:hover{color:#c8bca8;border-color:#4a443c}
.tt-mode-btn.active{background:#b8763e;color:#1a1712;border-color:#b8763e;font-weight:600}
.tt-field{display:block;padding:10px 18px 4px}
.tt-field span{display:block;font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#6f655b;margin-bottom:5px}
.tt-field select,.tt-field input{width:100%;background:#25221c;border:1px solid #3a352e;color:#e2d6c2;border-radius:5px;padding:7px 9px;font-size:12.5px;font-family:inherit;outline:none}
.tt-field select:focus,.tt-field input:focus{border-color:#b8763e}
.tt-scroll{overflow-y:auto;flex:1;padding:8px 12px 14px}
.tt-group{margin-bottom:14px}
.tt-group-title{font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#8a6a3a;margin:6px 4px 6px;padding-bottom:4px;border-bottom:1px solid #2a2620}
.tt-group-head{display:flex;align-items:center;justify-content:space-between;margin:6px 4px 6px;padding-bottom:4px;border-bottom:1px solid #2a2620}
.tt-group-head .tt-group-title{margin:0;padding:0;border:none}
.tt-layer-label{font-size:10px;color:#6f655b;letter-spacing:.04em;margin:7px 4px 5px}
.tt-layer-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px;padding-top:8px;border-top:1px solid #2a2620}
.tt-layer-head .tt-layer-label{margin:0 4px}
.tt-layer-add{background:#25221c;border:1px solid #4a443c;color:#c8bca8;border-radius:5px;font-size:10.5px;line-height:1;padding:5px 8px;cursor:pointer;font-family:inherit;white-space:nowrap;transition:all .12s}
.tt-layer-add:hover{background:#b8763e;color:#1a1712;border-color:#b8763e}
.tt-blob-empty{font-size:11px;color:#5e544a;padding:7px 4px 3px;font-style:italic;line-height:1.45}
.tt-swatch-row{display:flex;align-items:center;gap:4px;width:100%;padding:5px 4px 5px 6px;border-radius:6px;background:transparent;border:1px solid transparent;text-align:left;font-family:inherit}
.tt-swatch-row-main{display:flex;align-items:center;gap:9px;flex:1;min-width:0;background:transparent;border:none;cursor:pointer;font-family:inherit;text-align:left;padding:0}
.tt-swatch-del{flex-shrink:0;background:transparent;border:none;color:#5e544a;font-size:15px;line-height:1;cursor:pointer;padding:2px 4px;border-radius:4px;font-family:inherit}
.tt-swatch-del:hover{color:#c84545;background:#3a2018}
.tt-swatch-row:hover{background:#25221c}
.tt-swatch-row.active{background:#2a2620;border-color:#4a443c}
.tt-swatch{width:22px;height:22px;border-radius:5px;border:1px solid #00000040;flex-shrink:0;box-shadow:inset 0 0 0 1px #ffffff14}
.tt-base-swatch{border-radius:50%}
.tt-swatch-name{flex:1;min-width:0;font-size:12px;color:#c8bca8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tt-swatch-val{font-size:9.5px;font-family:'JetBrains Mono',monospace;color:#5e544a;white-space:nowrap}
.tt-foot{padding:10px 14px;border-top:1px solid #34302a}

/* shared buttons */
.tt-export{width:100%;padding:9px;background:#b8763e;color:#1a1712;border:none;border-radius:5px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
.tt-export:hover{background:#c88450}
.tt-reset{padding:8px 14px;background:transparent;color:#8a7e70;border:1px solid #3a352e;border-radius:5px;font-size:12px;cursor:pointer;font-family:inherit}
.tt-reset:hover{color:#c8bca8;border-color:#4a443c}

/* stage */
.tt-stage{flex:1;overflow-y:auto;background:#12110e;padding:20px 24px 32px}
.tt-stage-label,.tt-demos-label{font-size:10px;color:#4a4038;letter-spacing:.08em;text-transform:uppercase;margin-bottom:10px}
.tt-stage-label{display:flex;align-items:center;justify-content:space-between;gap:10px}
.tt-stage-actions{display:flex;align-items:center;gap:6px}
.tt-drift-toggle{background:#25221c;border:1px solid #3a352e;color:#c8bca8;border-radius:5px;padding:4px 11px;font-size:11px;letter-spacing:0;text-transform:none;cursor:pointer;font-family:inherit;transition:all .12s}
.tt-drift-toggle:hover:not(:disabled),.tt-drift-toggle.active{border-color:#b8763e;color:#e2d6c2;background:#3a2a1d}
.tt-drift-toggle:disabled{opacity:.4;cursor:default}
.tt-demos-label{margin-top:26px}

/* preview window (themed by tokens) */
.tt-window{display:flex;height:760px;border-radius:10px;overflow:hidden;border:1px solid var(--border);box-shadow:0 24px 60px #00000066;background:var(--page-bg, var(--bg))}
/* Drift replicates the live lava animation: oversized background (180%) panned
   via background-position, so the blobs appear to float. Faithful to the
   theme's own @keyframes (*-lava-drift on body) but applied to the preview
   element with a generic name so it works for any theme that has blobs. */
.tt-window-drift{background-size:180% 180%;animation:tt-drift 20s ease-in-out infinite}
@keyframes tt-drift{0%,100%{background-position:0% 0%,100% 100%,50% 50%}50%{background-position:100% 50%,0% 50%,50% 0%}}
.tt-win-sidebar{width:188px;min-width:188px;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.tt-win-brand{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--border)}
.tt-win-logo{width:22px;height:22px;border-radius:5px;background:var(--accent);color:var(--on-accent);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700}
.tt-win-logo-name{font-size:13px;font-weight:600;color:var(--t1)}
.tt-win-section{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--t3);padding:10px 12px 3px}
.tt-win-list{padding:0 6px;flex:1;overflow-y:auto}
.tt-win-item{display:flex;align-items:center;gap:9px;padding:6px 10px;border-radius:6px;color:var(--t2);transition:background-color .1s,color .1s}
.tt-win-item:hover,.tt-window-show-states .tt-win-item.preview-hover{background:var(--s2);color:var(--t1)}
.tt-win-item.active,.tt-win-item.active:hover{background:var(--accent-dim);color:var(--accent-t)}
.tt-win-item-name{font-size:12px;color:inherit}
.tt-win-avatar{width:32px;height:32px;border-radius:50%;background:var(--s3);color:var(--t2);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;flex-shrink:0}
.tt-win-avatar-active{background:var(--accent);color:var(--on-accent)}
.tt-win-avatar-sm{width:20px;height:20px;border-radius:50%;background:var(--s3);color:var(--t2);display:inline-flex;align-items:center;justify-content:center;font-size:9px}
.tt-win-avatar-xs{width:16px;height:16px;border-radius:50%;background:var(--s3);color:var(--t2);display:inline-flex;align-items:center;justify-content:center;font-size:8px}
.tt-win-persona{padding:9px 12px;border-top:1px solid var(--border);display:flex;align-items:center;gap:7px}
.tt-win-persona-label{font-size:11px;color:var(--t3)}

.tt-win-main{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}
.tt-win-topbar{display:flex;height:60px;align-items:center;gap:9px;padding:0 14px;background:var(--surface);border-bottom:1px solid var(--border)}
.tt-win-top-avatar{width:44px;height:44px;border-radius:50%;background:var(--s3);color:var(--t2);display:flex;align-items:center;justify-content:center;font-size:12px;font-family:var(--font-body);font-style:italic;flex-shrink:0;border:1.5px solid transparent}
.tt-win-name{font-size:var(--ui-fs);font-weight:500;color:var(--t1);white-space:nowrap}
.tt-win-memory{display:flex;align-items:center;gap:5px;border:1px solid var(--border);background:var(--s2);color:var(--t2);border-radius:999px;padding:3px 8px;font-size:11px;white-space:nowrap;transition:border-color .15s,color .15s}
.tt-win-memory:hover,.tt-window-show-states .tt-win-memory.preview-hover{border-color:var(--accent);color:var(--accent-t)}
.tt-win-memory i,.tt-win-provider i{width:6px;height:6px;border-radius:50%;background:var(--success);flex-shrink:0}
.tt-win-provider{display:flex;align-items:center;gap:5px;border:1px solid transparent;background:transparent;color:var(--t2);border-radius:4px;padding:4px 7px;font-size:10.5px;white-space:nowrap;transition:background-color .15s,border-color .15s,color .15s}
.tt-win-provider b{color:var(--t3);font-weight:400}
.tt-win-provider:hover,.tt-window-show-states .tt-win-provider.preview-hover{border-color:var(--border);background:var(--s2);color:var(--t1)}
.tt-win-mode-switch{margin-left:auto;border:0;border-radius:999px;background:var(--mode-switch-bg,var(--accent-dim));color:var(--mode-switch-text,var(--accent-t));padding:4px 12px;font-size:13px;font-weight:500;cursor:pointer;transition:background-color .15s,color .15s}
.tt-win-mode-switch:hover,.tt-window-show-states .tt-win-mode-switch.preview-hover{background:var(--mode-switch-hover-bg,var(--accent-hover));color:var(--mode-switch-hover-text,var(--accent-t))}

.tt-win-messages{flex:1;overflow-y:auto;padding:20px 24px;display:flex;flex-direction:column;gap:18px}
.tt-msg{position:relative;padding:10px 0}
.tt-msg-head{display:flex;align-items:center;gap:10px;margin-bottom:12px;color:var(--accent-t);opacity:.85}
.tt-msg-avatar{width:44px;height:44px;border-radius:50%;background:var(--s3);color:var(--t3);display:flex;align-items:center;justify-content:center;font-family:var(--font-body);font-style:italic;font-size:calc(var(--ui-fs) + 1px);flex-shrink:0}
.tt-msg-author{font-size:calc(var(--ui-fs) - 2px);font-weight:600;letter-spacing:.04em;color:inherit}
.tt-msg-body{font-family:var(--font-body);font-size:calc(var(--mfs));line-height:1.65;color:var(--msg-t1)}
.tt-msg-meta{margin-top:4px;font-size:calc(var(--ui-fs) - 4px);color:color-mix(in srgb,var(--t3) 50%,transparent);display:flex;gap:8px}
.tt-msg-actions{display:flex;align-items:center;gap:1px;margin-top:6px;opacity:0;transition:opacity .15s;color:var(--t3);font-size:calc(var(--ui-fs) - 3px)}
.tt-msg-actions span{padding:3px 7px;border-radius:4px}
.tt-msg-actions span:hover{background:var(--s2);color:var(--t2)}
.tt-msg:hover .tt-msg-actions,.tt-window-show-states .tt-msg.preview-hover .tt-msg-actions{opacity:1}
.tt-msg-user-head{display:flex;align-items:center;justify-content:flex-start;flex-direction:row-reverse;gap:10px;margin-bottom:12px;color:var(--t3)}
.tt-msg-user-name{font-size:calc(var(--ui-fs) - 2px);font-weight:600;letter-spacing:.04em}
.tt-msg-user-body{background:var(--user-bg);border-radius:6px;padding:13px 16px;width:100%;font-family:var(--font-body);font-size:calc(var(--mfs));line-height:1.65;color:var(--msg-t1)}
.tt-msg-user-content{opacity:.88}
.tt-msg-user-meta{margin-top:4px;font-size:calc(var(--ui-fs) - 4px);color:color-mix(in srgb,var(--t3) 50%,transparent);text-align:right}

.tt-win-inputbar{border-top:1px solid var(--border);background:var(--surface);padding:10px 14px}
.tt-win-textarea{background:var(--input-bg,var(--bg));border:1px solid var(--border);border-radius:8px;padding:13px 16px;font-family:var(--font-body);font-size:15.5px;color:var(--t4);margin-bottom:7px}
.tt-win-inputbar-bottom{display:flex;align-items:center;justify-content:space-between}
.tt-win-speakas{font-size:11px;color:var(--t3);display:flex;align-items:center;gap:5px}
.tt-win-tokens{margin-left:10px;font-size:11px;color:var(--t4)}
.tt-win-send{background:var(--accent);color:var(--on-accent);border:none;border-radius:5px;padding:7px 16px;font-size:13px;font-weight:500;cursor:pointer}

/* demo strip */
.tt-demos{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.tt-demo-card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px}
.tt-demo-card-label{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--t3);margin-bottom:9px}
.tt-code{margin:0;font-size:12px;color:var(--msg-t2)}
.tt-badges{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:11px}
.tt-badge{font-size:11px;padding:3px 9px;border-radius:20px;border:1px solid;font-weight:500}
.tt-badge-success{color:var(--success-text);background:var(--success-dim);border-color:var(--success-dim)}
.tt-badge-info{color:var(--info-text);background:var(--info-dim);border-color:var(--info-dim)}
.tt-badge-warning{color:var(--warning-text);background:var(--warning-dim);border-color:var(--warning-dim)}
.tt-badge-danger{color:var(--danger-text);background:var(--danger-dim);border-color:var(--danger-dim)}
.tt-buttons{display:flex;gap:8px}
.tt-btn-accent{background:var(--accent);color:var(--on-accent);border:none;border-radius:5px;padding:7px 14px;font-size:12.5px;font-weight:500;cursor:pointer}
.tt-btn-danger{background:var(--danger);color:var(--on-danger);border:none;border-radius:5px;padding:7px 14px;font-size:12.5px;font-weight:500;cursor:pointer}
.tt-frost-bg{border-radius:8px;padding:18px;min-height:96px;display:flex;align-items:center}
.tt-frost-panel{background:var(--glass-bg,var(--surface));backdrop-filter:blur(var(--glass-blur,0px)) saturate(180%) brightness(110%);-webkit-backdrop-filter:blur(var(--glass-blur,0px)) saturate(180%) brightness(110%);border:1px solid var(--border);border-radius:8px;padding:10px 13px;font-size:12px;color:var(--t2);width:100%}
.tt-frost-panel code{font-family:'JetBrains Mono',monospace;color:var(--accent-t);font-size:11px}
.tt-frost-panel p{margin:5px 0 0;font-size:11px;color:var(--t3)}
.tt-selection-sample{display:inline-block;background:var(--sel-bg);color:var(--sel-text);padding:5px 8px;border-radius:4px;font-family:var(--font-body);font-size:14px;margin-bottom:10px}
.tt-token-samples{display:flex;flex-wrap:wrap;gap:7px;font-size:11px}
.tt-token-samples span{padding:4px 7px;border-radius:4px}
.tt-accent-mid-sample{background:var(--accent-mid);color:var(--on-accent)}
.tt-diff-remove{background:var(--danger-strong);color:var(--t1)}
.tt-diff-add{background:var(--success-strong);color:var(--t1)}

/* editor */
.tt-editor{width:332px;min-width:332px;background:#1e1c18;border-left:1px solid #34302a;overflow-y:auto}
.tt-editor-inner{padding:18px}
.tt-ed-name{font-size:15px;font-weight:600;color:#e2d6c2;font-family:'JetBrains Mono',monospace}
.tt-ed-hint{font-size:11.5px;color:#6f655b;margin-top:3px;margin-bottom:14px}
.tt-ed-preview{width:100%;height:54px;border-radius:7px;border:1px solid #00000040;margin-bottom:14px;box-shadow:inset 0 0 0 1px #ffffff14}
.tt-ed-native{display:flex;align-items:center;gap:9px;margin-bottom:16px}
.tt-ed-native input[type=color]{width:44px;height:36px;border:1px solid #3a352e;border-radius:6px;background:#25221c;cursor:pointer;padding:3px}
.tt-ed-native input[type=color]::-webkit-color-swatch{border:none;border-radius:3px}
.tt-ed-native input[type=color]::-webkit-color-swatch-wrapper{padding:0}
.tt-ed-hex{flex:1;background:#25221c;border:1px solid #3a352e;color:#e2d6c2;font-family:'JetBrains Mono',monospace;font-size:12.5px;border-radius:5px;padding:8px 10px;outline:none;text-transform:lowercase}
.tt-ed-hex:focus{border-color:#b8763e}
.tt-slider-row{margin-bottom:13px}
.tt-slider-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;font-size:11px;color:#8a7e70;font-weight:500}
.tt-slider-num{width:60px;background:#25221c;border:1px solid #3a352e;color:#e2d6c2;font-family:'JetBrains Mono',monospace;font-size:11.5px;border-radius:4px;padding:2px 6px;text-align:right;outline:none}
.tt-slider-num:focus{border-color:#b8763e}
.tt-slider{-webkit-appearance:none;appearance:none;width:100%;height:10px;border-radius:5px;outline:none;cursor:pointer;border:1px solid #2a2620}
.tt-slider::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:#fff;border:2px solid #3a352e;box-shadow:0 1px 4px #00000066;cursor:pointer}
.tt-slider::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:#fff;border:2px solid #3a352e;cursor:pointer}
.tt-ed-string{margin-top:6px;padding:8px 10px;background:#100f0b;border:1px solid #2a2620;border-radius:5px;font-family:'JetBrains Mono',monospace;font-size:11.5px;color:#c89a60;word-break:break-all}
.tt-ed-sep{height:1px;background:#2a2620;margin:14px 0}
.tt-gradient-kinds{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin:0 0 14px}
.tt-gradient-kinds button,.tt-gradient-stops button{background:#25221c;border:1px solid #3a352e;color:#8a7e70;border-radius:5px;padding:7px 5px;font-size:11px;cursor:pointer;font-family:inherit}
.tt-gradient-kinds button.active,.tt-gradient-stops button.active{background:#3a2a1d;border-color:#b8763e;color:#e2d6c2}
.tt-gradient-stops{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-bottom:14px}
.tt-gradient-stops button{display:flex;align-items:center;justify-content:center;gap:6px}
.tt-gradient-stops button span{width:14px;height:14px;border-radius:4px;border:1px solid #00000040}
.tt-gradient-solid-note{padding:12px;background:#25221c;border:1px solid #34302a;border-radius:6px;color:#8a7e70;font-size:12px;line-height:1.55}
.tt-gradient-solid-note code{color:#c89a60;font-family:'JetBrains Mono',monospace}
.tt-ed-reset{margin-top:12px;width:100%;padding:7px;background:transparent;color:#8a7e70;border:1px solid #3a352e;border-radius:5px;font-size:12px;cursor:pointer;font-family:inherit}
.tt-ed-reset:hover{color:#c8bca8;border-color:#4a443c}
.tt-comment{margin-top:12px}
.tt-comment-regen{background:transparent;border:1px solid #3a352e;color:#8a7e70;border-radius:4px;padding:2px 7px;font-size:10.5px;cursor:pointer;font-family:inherit}
.tt-comment-regen:hover{color:#c8bca8;border-color:#4a443c}
.tt-comment-input{width:100%;background:#25221c;border:1px solid #3a352e;color:#e2d6c2;font-size:12.5px;border-radius:5px;padding:8px 10px;outline:none;margin-top:5px}
.tt-comment-input:focus{border-color:#b8763e}
.tt-comment-input::placeholder{color:#5e544a;font-style:italic}
.tt-editor-empty{padding:40px 24px;text-align:center;color:#5e544a}
.tt-editor-empty-icon{font-size:30px;margin-bottom:14px;color:#3a352e}
.tt-editor-empty p{font-size:12.5px;color:#8a7e70;margin-bottom:10px}
.tt-editor-empty-sub{font-size:11px;color:#5e544a;line-height:1.7}

/* export modal */
.tt-modal-overlay{position:fixed;inset:0;background:#000000a8;z-index:9000;display:flex;align-items:center;justify-content:center;padding:24px}
.tt-modal{background:#1a1712;border:1px solid #3a302a;border-radius:9px;width:680px;max-width:100%;max-height:82vh;display:flex;flex-direction:column;overflow:hidden}
.tt-modal-head{padding:13px 16px;border-bottom:1px solid #3a302a;display:flex;align-items:center;justify-content:space-between}
.tt-modal-head span{font-size:13px;font-weight:600;color:#e2d6c2}
.tt-modal-x{background:transparent;border:none;color:#7a6e60;font-size:20px;cursor:pointer;line-height:1}
.tt-modal-x:hover{color:#c8bca8}
.tt-modal-text{flex:1;overflow-y:auto;padding:15px 16px;font-family:'JetBrains Mono',monospace;font-size:11.5px;color:#c8b89a;background:#100f0b;border:none;outline:none;line-height:1.6;resize:none;white-space:pre}
.tt-modal-foot{padding:11px 16px;border-top:1px solid #3a302a;display:flex;gap:9px;justify-content:flex-end}
.tt-modal-foot .tt-export{width:auto;padding:8px 18px}

/* scrollbars */
.tt-scroll::-webkit-scrollbar,.tt-stage::-webkit-scrollbar,.tt-editor::-webkit-scrollbar,.tt-win-messages::-webkit-scrollbar,.tt-win-list::-webkit-scrollbar,.tt-modal-text::-webkit-scrollbar{width:7px}
.tt-scroll::-webkit-scrollbar-track,.tt-stage::-webkit-scrollbar-track,.tt-editor::-webkit-scrollbar-track{background:transparent}
.tt-scroll::-webkit-scrollbar-thumb,.tt-stage::-webkit-scrollbar-thumb,.tt-editor::-webkit-scrollbar-thumb,.tt-modal-text::-webkit-scrollbar-thumb{background:#2e2a24;border-radius:4px}
.tt-win-messages::-webkit-scrollbar-thumb,.tt-win-list::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px}

@media (max-width:1180px){
  .tt-demos{grid-template-columns:1fr}
}
`;
