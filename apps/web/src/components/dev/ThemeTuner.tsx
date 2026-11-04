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
 *   - "edit": load a registered theme's CSS (imported as text via the
 *     `type: "text"` import attribute), tweak any color, export a
 *     surgically-patched copy (comments preserved).
 *   - "scratch": start from a neutral grayscale ramp and build a brand-new theme.
 *
 * The tool's own chrome uses a fixed dark palette (`.tt-*` classes) so it stays
 * legible no matter how unhinged the colors you experiment with get. Only the
 * preview pane is themed.
 */
import { useEffect, useMemo, useState } from "react";
import { Markdown } from "../../lib/markdown.js";
import { ScrollArea } from "../shared/scroll-area.js";
import { TT_CSS } from "./theme-tuner-css.js";
import { MessageReasoning } from "../chat/MessageReasoning.js";
import { THEMES, applyThemeClass, type ThemeId } from "../../themes/registry.js";
import coffeeRaw from "../../themes/coffee.css" with { type: "text" };
import milkCoffeeRaw from "../../themes/milk-coffee.css" with { type: "text" };
import mysticDawnRaw from "../../themes/mystic-dawn.css" with { type: "text" };
import mysticRaw from "../../themes/mystic-night.css" with { type: "text" };
import lavaRaw from "../../themes/light-lava.css" with { type: "text" };
import darkLavaRaw from "../../themes/dark-lava.css" with { type: "text" };
import {
  GROUPS,
  SCRATCH_VALUES,
  parseThemeCss,
  parseColor,
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
  upsertTokensInCss,
  type OkColor,
  type Blob,
  type PageGradient,
} from "./color-math.js";
import { LavaBackground } from "../layout/LavaBackground.js";
import {
  DEFAULT_LAMP_BALLS,
  LAMP_BALL_SIZE_MAX,
  LAMP_BALL_SIZE_MIN,
  LAMP_BALL_SPEED_MAX,
  LAMP_BALL_SPEED_MIN,
  LAMP_DEFAULTS,
  LAMP_LIGHT_DEFAULTS,
  MAX_LAMP_BALLS,
  MAX_LAMP_WAX_COLORS,
  MIN_LAMP_WAX_COLORS,
  parseLampBalls,
  splitCssList,
  type LampBallConfig,
} from "../layout/lava-shader.js";

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
  "--lamp-glass": "Стекло лампы (среда сосуда)",
  "--lamp-wax-thick": "Густой воск (ядра больших шаров)",
  "--lamp-wax-mid": "Средний воск",
  "--lamp-wax-orange": "Промежуточный воск (между средним и краем)",
  "--lamp-wax-thin": "Светлый воск (края / мелкие шары)",
};

type Mode = "edit" | "scratch";
type LavaPreviewMode = "css" | "webgl";

/** Tunable non-color lamp params exposed by the LavaParams panel. `light` is
 *  0 (dark vessel) or 1 (light tinted field); the rest are shader uniforms. */
interface LampScalars {
  light: number;
  tint: number;
  edge: number;
  core: number;
  ramp: number;
  speed: number;
  bulb: number;
  falloff: number;
}

/** Glass-field sliders (rendered under the "Стекло" sub-header, beside the
 *  Тёмный/Светлый mode buttons). `bulb` and `falloff` have light-mode-aware
 *  defaults, so their slider seed depends on the active glass mode. */
const LAMP_GLASS_FIELDS = [
  { name: "--lamp-tint", key: "tint", label: "Tint стекла (светл. режим)", min: 0, max: 2, step: 0.05 },
  { name: "--lamp-bulb", key: "bulb", label: "Лампочка (источник тепла)", min: 0, max: 1, step: 0.02 },
  { name: "--lamp-falloff", key: "falloff", label: "Затемнение воска (спад)", min: 0, max: 0.6, step: 0.01 },
] as const;

/** Ball-shape sliders (rendered under the "Общие параметры" sub-header). */
const LAMP_SHAPE_FIELDS = [
  { name: "--lamp-edge", key: "edge", label: "Размытие края шара", min: 0, max: 0.2, step: 0.005 },
  { name: "--lamp-core", key: "core", label: "Ширина затемнения ядра", min: 0.05, max: 1, step: 0.05 },
  { name: "--lamp-ramp", key: "ramp", label: "Границы цвета (разброс)", min: 0, max: 2, step: 0.05 },
  { name: "--lamp-speed", key: "speed", label: "Скорость дрейфа", min: 0, max: 3, step: 0.05 },
] as const;

/** Parse a numeric CSS token from theme source, defaulting when absent. */
function numToken(raw: string, name: string, dflt: number): number {
  const v = extractTokenValue(raw, name);
  if (!v) return dflt;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
}

const LEGACY_WAX_TOKENS = [
  "--lamp-wax-thick",
  "--lamp-wax-mid",
  "--lamp-wax-orange",
  "--lamp-wax-thin",
] as const;

const cloneBalls = (balls: readonly LampBallConfig[]): LampBallConfig[] =>
  balls.map((ball) => ({ ...ball }));
const cloneColors = (colors: readonly OkColor[]): OkColor[] =>
  colors.map((color) => ({ ...color }));

function serializeLampBalls(balls: readonly LampBallConfig[]): string {
  return balls.map((ball) => `${Number(ball.size.toFixed(3))} ${Number(ball.speed.toFixed(2))}`).join(", ");
}

function serializeWaxColors(colors: readonly OkColor[]): string {
  return colors.map(serialize).join(", ");
}

function loadWaxColors(raw: string, values: ReadonlyMap<string, OkColor>): OkColor[] {
  const legacy = LEGACY_WAX_TOKENS.flatMap((token) => {
    const color = values.get(token);
    return color ? [{ ...color }] : [];
  });
  const customRaw = extractTokenValue(raw, "--lamp-wax-colors");
  if (!customRaw) return legacy;
  const parsed: OkColor[] = [];
  for (const item of splitCssList(customRaw).slice(0, MAX_LAMP_WAX_COLORS)) {
    const color = parseColor(item);
    if (!color) return legacy;
    parsed.push(color);
  }
  return parsed.length >= MIN_LAMP_WAX_COLORS ? parsed : legacy;
}

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
  const [lavaPreviewMode, setLavaPreviewMode] = useState<LavaPreviewMode>("css");
  const [exportText, setExportText] = useState<string | null>(null);
  const [lamp, setLamp] = useState<LampScalars>({
    light: LAMP_DEFAULTS.light,
    tint: LAMP_DEFAULTS.tint,
    edge: LAMP_DEFAULTS.edge,
    core: LAMP_DEFAULTS.core,
    ramp: LAMP_DEFAULTS.ramp,
    speed: LAMP_DEFAULTS.speed,
    bulb: LAMP_DEFAULTS.bulb,
    falloff: LAMP_DEFAULTS.falloff,
  });
  const [lampBalls, setLampBalls] = useState<LampBallConfig[]>(() => cloneBalls(DEFAULT_LAMP_BALLS));
  const [lampBallOriginals, setLampBallOriginals] = useState<LampBallConfig[]>(() => cloneBalls(DEFAULT_LAMP_BALLS));
  const [waxColors, setWaxColors] = useState<OkColor[]>([]);
  const [waxColorOriginals, setWaxColorOriginals] = useState<OkColor[]>([]);
  const [selectedLampBall, setSelectedLampBall] = useState<number | null>(null);
  const [selectedWaxColor, setSelectedWaxColor] = useState<number | null>(null);

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
      setLamp({ light: LAMP_DEFAULTS.light, tint: LAMP_DEFAULTS.tint, edge: LAMP_DEFAULTS.edge, core: LAMP_DEFAULTS.core, ramp: LAMP_DEFAULTS.ramp, speed: LAMP_DEFAULTS.speed, bulb: LAMP_DEFAULTS.bulb, falloff: LAMP_DEFAULTS.falloff });
      setLampBalls(cloneBalls(DEFAULT_LAMP_BALLS));
      setLampBallOriginals(cloneBalls(DEFAULT_LAMP_BALLS));
      setWaxColors([]);
      setWaxColorOriginals([]);
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
      const llRaw = extractTokenValue(THEME_RAW[editId], "--lamp-light");
      const lightMode = llRaw && parseFloat(llRaw) >= 0.5 ? 1 : 0;
      setLamp({
        light: lightMode,
        tint: numToken(THEME_RAW[editId], "--lamp-tint", LAMP_DEFAULTS.tint),
        edge: numToken(THEME_RAW[editId], "--lamp-edge", LAMP_DEFAULTS.edge),
        core: numToken(THEME_RAW[editId], "--lamp-core", LAMP_DEFAULTS.core),
        ramp: numToken(THEME_RAW[editId], "--lamp-ramp", LAMP_DEFAULTS.ramp),
        speed: numToken(THEME_RAW[editId], "--lamp-speed", LAMP_DEFAULTS.speed),
        bulb: numToken(THEME_RAW[editId], "--lamp-bulb", lightMode ? LAMP_LIGHT_DEFAULTS.bulb : LAMP_DEFAULTS.bulb),
        falloff: numToken(THEME_RAW[editId], "--lamp-falloff", lightMode ? LAMP_LIGHT_DEFAULTS.falloff : LAMP_DEFAULTS.falloff),
      });
      const parsedBalls = parseLampBalls(extractTokenValue(THEME_RAW[editId], "--lamp-balls") ?? "")
        ?? cloneBalls(DEFAULT_LAMP_BALLS);
      const parsedWaxColors = loadWaxColors(THEME_RAW[editId], v);
      setLampBalls(cloneBalls(parsedBalls));
      setLampBallOriginals(cloneBalls(parsedBalls));
      setWaxColors(cloneColors(parsedWaxColors));
      setWaxColorOriginals(cloneColors(parsedWaxColors));
    }
    setSelected(null);
    setSelectedBlob(null);
    setSelectedLampBall(null);
    setSelectedWaxColor(null);
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

  // Push all editable lamp values to <html> so the scoped LavaBackground
  // re-reads them live via its style MutationObserver. Glass still flows
  // through the generic color-token effect; balls and wax colors use dynamic
  // comma-list tokens because their counts are user-editable.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--lamp-light", String(lamp.light));
    root.style.setProperty("--lamp-tint", String(lamp.tint));
    root.style.setProperty("--lamp-edge", String(lamp.edge));
    root.style.setProperty("--lamp-core", String(lamp.core));
    root.style.setProperty("--lamp-ramp", String(lamp.ramp));
    root.style.setProperty("--lamp-speed", String(lamp.speed));
    root.style.setProperty("--lamp-bulb", String(lamp.bulb));
    root.style.setProperty("--lamp-falloff", String(lamp.falloff));
    if (lampBalls.length > 0) root.style.setProperty("--lamp-balls", serializeLampBalls(lampBalls));
    if (waxColors.length >= MIN_LAMP_WAX_COLORS) {
      root.style.setProperty("--lamp-wax-colors", serializeWaxColors(waxColors));
    }
    return () => {
      root.style.removeProperty("--lamp-light");
      root.style.removeProperty("--lamp-tint");
      root.style.removeProperty("--lamp-edge");
      root.style.removeProperty("--lamp-core");
      root.style.removeProperty("--lamp-ramp");
      root.style.removeProperty("--lamp-speed");
      root.style.removeProperty("--lamp-bulb");
      root.style.removeProperty("--lamp-falloff");
      root.style.removeProperty("--lamp-balls");
      root.style.removeProperty("--lamp-wax-colors");
    };
  }, [lamp, lampBalls, waxColors]);

  const selectedCol = selected ? values.get(selected) ?? null : null;
  // The WebGL lamp preview is shown only when editing a lava theme (never in
  // scratch mode). Production viewport/reduced-motion gating is bypassed in
  // the tuner so the lamp is always visible while tuning.
  const isLavaTheme = mode === "edit" && (editId === "dark-lava" || editId === "light-lava");

  function switchLavaPreviewMode(next: LavaPreviewMode) {
    setLavaPreviewMode(next);
    setSelected(null);
    setSelectedBlob(null);
    setSelectedLampBall(null);
    setSelectedWaxColor(null);
    setEditingPageBase(false);
  }

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
    setSelectedLampBall(null);
    setSelectedWaxColor(null);
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

  /** Switch the glass field mode and snap the heat-source position + wax
   *  falloff to that mode's tuned defaults, so flipping Тёмный/Светлый gives
   *  the correct lamp look immediately. The user can still deviate with the
   *  sliders afterwards; this only fires on a real mode change. */
  function setGlassMode(mode: 0 | 1) {
    if (lamp.light === mode) return;
    setLamp((prev) => ({
      ...prev,
      light: mode,
      bulb: mode ? LAMP_LIGHT_DEFAULTS.bulb : LAMP_DEFAULTS.bulb,
      falloff: mode ? LAMP_LIGHT_DEFAULTS.falloff : LAMP_DEFAULTS.falloff,
    }));
  }

  function addLampBall() {
    if (lampBalls.length >= MAX_LAMP_BALLS) return;
    const source = lampBalls[lampBalls.length - 1] ?? { size: 0.14, speed: 1 };
    const next = [...lampBalls, { ...source }];
    setLampBalls(next);
    setSelectedLampBall(next.length - 1);
    setSelectedWaxColor(null);
    setSelected(null);
  }

  function removeLampBall(index: number) {
    if (lampBalls.length <= 1) return;
    const next = lampBalls.filter((_, current) => current !== index);
    setLampBalls(next);
    setSelectedLampBall((current) => {
      if (current == null) return null;
      if (current === index) return Math.min(index, next.length - 1);
      return current > index ? current - 1 : current;
    });
  }

  function updateLampBall(patch: Partial<LampBallConfig>) {
    if (selectedLampBall == null) return;
    setLampBalls((current) => current.map((ball, index) =>
      index === selectedLampBall ? { ...ball, ...patch } : ball,
    ));
  }

  function resetLampBall() {
    if (selectedLampBall == null) return;
    const original = lampBallOriginals[selectedLampBall];
    if (!original) return;
    updateLampBall(original);
  }

  function addWaxColor() {
    if (waxColors.length >= MAX_LAMP_WAX_COLORS) return;
    const source = waxColors[waxColors.length - 1] ?? { l: 0.8, c: 0.12, h: 60, a: null };
    const next = [...waxColors, { ...source }];
    setWaxColors(next);
    setSelectedWaxColor(next.length - 1);
    setSelectedLampBall(null);
    setSelected(null);
  }

  function removeWaxColor(index: number) {
    if (waxColors.length <= MIN_LAMP_WAX_COLORS) return;
    const next = waxColors.filter((_, current) => current !== index);
    setWaxColors(next);
    setSelectedWaxColor((current) => {
      if (current == null) return null;
      if (current === index) return Math.min(index, next.length - 1);
      return current > index ? current - 1 : current;
    });
  }

  function updateWaxColor(patch: Partial<OkColor>) {
    if (selectedWaxColor == null) return;
    setWaxColors((current) => current.map((color, index) =>
      index === selectedWaxColor ? { ...color, ...patch } : color,
    ));
  }

  function resetWaxColor() {
    if (selectedWaxColor == null) return;
    const original = waxColorOriginals[selectedWaxColor];
    if (!original) return;
    updateWaxColor(original);
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
    // Lamp scalar changes: tokens already authored in this theme are patched
    // by applyOverridesToCss (added to `overrides`); tokens absent from it are
    // inserted by upsertTokensInCss after. Only values the user actually
    // changed are exported, so a theme left at defaults stays clean. `bulb`
    // and `falloff` have glass-mode-aware defaults (the heat source flips and
    // the falloff softens on the light field), so their comparison baseline is
    // taken from the theme's own --lamp-light.
    const llSrcRaw = extractTokenValue(THEME_RAW[editId], "--lamp-light");
    const lightSrc = llSrcRaw && parseFloat(llSrcRaw) >= 0.5 ? 1 : 0;
    const bulbSrcDefault = lightSrc ? LAMP_LIGHT_DEFAULTS.bulb : LAMP_DEFAULTS.bulb;
    const falloffSrcDefault = lightSrc ? LAMP_LIGHT_DEFAULTS.falloff : LAMP_DEFAULTS.falloff;
    const lampDefaultsList: Array<[string, number]> = [
      ["--lamp-light", LAMP_DEFAULTS.light], ["--lamp-tint", LAMP_DEFAULTS.tint],
      ["--lamp-edge", LAMP_DEFAULTS.edge], ["--lamp-core", LAMP_DEFAULTS.core],
      ["--lamp-ramp", LAMP_DEFAULTS.ramp], ["--lamp-speed", LAMP_DEFAULTS.speed],
      ["--lamp-bulb", bulbSrcDefault], ["--lamp-falloff", falloffSrcDefault],
    ];
    const lampCurrentList: Array<[string, number]> = [
      ["--lamp-light", lamp.light], ["--lamp-tint", lamp.tint],
      ["--lamp-edge", lamp.edge], ["--lamp-core", lamp.core],
      ["--lamp-ramp", lamp.ramp], ["--lamp-speed", lamp.speed],
      ["--lamp-bulb", lamp.bulb], ["--lamp-falloff", lamp.falloff],
    ];
    const lampInserts: Array<{ name: string; value: string }> = [];
    for (let i = 0; i < lampCurrentList.length; i++) {
      const [name, cur] = lampCurrentList[i];
      const src = numToken(THEME_RAW[editId], name, lampDefaultsList[i][1]);
      if (Math.abs(cur - src) > 1e-6) {
        if (extractTokenValue(THEME_RAW[editId], name) !== null) overrides.set(name, String(cur));
        else lampInserts.push({ name, value: String(cur) });
      }
    }
    const dynamicLampValues: Array<[string, string, string]> = [
      ["--lamp-balls", serializeLampBalls(lampBalls), serializeLampBalls(lampBallOriginals)],
      ["--lamp-wax-colors", serializeWaxColors(waxColors), serializeWaxColors(waxColorOriginals)],
    ];
    for (const [name, current, original] of dynamicLampValues) {
      if (current === original) continue;
      if (extractTokenValue(THEME_RAW[editId], name) !== null) overrides.set(name, current);
      else lampInserts.push({ name, value: current });
    }

    let css = applyOverridesToCss(THEME_RAW[editId], overrides, comments);
    // Export the complete stack, including deletion of every blob or switching
    // a fixed gradient back to the linked solid --bg fallback.
    const currentPageBg = serializePageBg(blobs, pageGradient);
    const originalPageBg = serializePageBg(blobOriginals, gradientOriginal);
    if (currentPageBg !== originalPageBg) {
      css = upsertPageBgInCss(css, currentPageBg);
    }
    if (lampInserts.length > 0) css = upsertTokensInCss(css, lampInserts);
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

        {/* CNR-8r: the tool panes ride the app-wide thin lane (3px/5px) —
            the tuner's old baked 7px WebKit rules were the last baked native
            chrome in the shell. Padding moved onto the lane content so the
            overlay track hugs the pane edge. */}
        <ScrollArea scrollbarSize="thin" className="tt-scroll" contentClassName="tt-scroll-content">
          {(!isLavaTheme || lavaPreviewMode === "css") && (
            <div className="tt-group">
              <div className="tt-group-title">{isLavaTheme ? "CSS-блобы (--page-bg)" : "Фон страницы (--page-bg)"}</div>
              <div className="tt-layer-label">Основа</div>
              <PageBaseRow
                gradient={pageGradient}
                active={editingPageBase}
                onClick={() => {
                  setEditingPageBase(true);
                  setSelectedBlob(null);
                  setSelectedLampBall(null);
                  setSelectedWaxColor(null);
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
                    onClick={() => {
                      setSelectedBlob(i);
                      setSelectedLampBall(null);
                      setSelectedWaxColor(null);
                      setSelected(null);
                      setEditingPageBase(false);
                    }}
                    onRemove={() => removeBlob(i)}
                  />
                ))
              )}
            </div>
          )}
          {isLavaTheme && lavaPreviewMode === "webgl" && (
            <LavaWebGlControls
              glassColor={values.get("--lamp-glass") ?? null}
              glassSelected={selected === "--lamp-glass"}
              balls={lampBalls}
              selectedBall={selectedLampBall}
              waxColors={waxColors}
              selectedWaxColor={selectedWaxColor}
              lamp={lamp}
              onSelectGlass={() => {
                setSelected("--lamp-glass");
                setSelectedBlob(null);
                setSelectedLampBall(null);
                setSelectedWaxColor(null);
                setEditingPageBase(false);
              }}
              onSelectBall={(index) => {
                setSelectedLampBall(index);
                setSelectedWaxColor(null);
                setSelected(null);
                setEditingPageBase(false);
              }}
              onAddBall={addLampBall}
              onRemoveBall={removeLampBall}
              onSelectWaxColor={(index) => {
                setSelectedWaxColor(index);
                setSelectedLampBall(null);
                setSelected(null);
                setEditingPageBase(false);
              }}
              onAddWaxColor={addWaxColor}
              onRemoveWaxColor={removeWaxColor}
              onLampChange={(patch) => setLamp((prev) => ({ ...prev, ...patch }))}
              onGlassMode={setGlassMode}
            />
          )}
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
                    onClick={() => {
                      setSelected(tok);
                      setSelectedBlob(null);
                      setSelectedLampBall(null);
                      setSelectedWaxColor(null);
                      setEditingPageBase(false);
                    }}
                  />
                ))}
              </div>
            );
          })}
        </ScrollArea>

        <footer className="tt-foot">
          <button type="button" className="tt-export" onClick={handleExport}>
            Экспортировать .css
          </button>
        </footer>
      </aside>

      {/* ─── Center: live preview ─── */}
      <ScrollArea scrollbarSize="thin" className="tt-stage" contentClassName="tt-stage-content">
        <div className="tt-stage-label">
          <span>ПРЕВЬЮ {mode === "edit" ? `— ${editId}.css` : `— с нуля («${scratchName || "my-theme"}»)`}</span>
          <div className="tt-stage-actions">
            {isLavaTheme && (
              <div className="tt-lava-preview-modes" aria-label="Режим lava-превью">
                <button type="button" className={lavaPreviewMode === "css" ? "active" : ""} onClick={() => switchLavaPreviewMode("css")}>CSS-блобы</button>
                <button type="button" className={lavaPreviewMode === "webgl" ? "active" : ""} onClick={() => switchLavaPreviewMode("webgl")}>WebGL-шары</button>
              </div>
            )}
            <button
              type="button"
              className={showHoverStates ? "tt-drift-toggle active" : "tt-drift-toggle"}
              onClick={() => setShowHoverStates((visible) => !visible)}
              title="Зафиксировать hover-состояния в preview"
            >
              {showHoverStates ? "◆ Hover показан" : "◇ Показать hover"}
            </button>
            {(!isLavaTheme || lavaPreviewMode === "css") && (
              <button
                type="button"
                className="tt-drift-toggle"
                disabled={blobs.length === 0}
                onClick={() => setDrifting((d) => !d)}
                title={drifting ? "Остановить дрейф пятен" : "Запустить дрейф пятен"}
              >
                {drifting ? "⏸ Стоп" : "▶ Дрейф"}
              </button>
            )}
          </div>
        </div>
        <Preview
          drifting={drifting && blobs.length > 0 && (!isLavaTheme || lavaPreviewMode === "css")}
          showHoverStates={showHoverStates}
          lampActive={isLavaTheme && lavaPreviewMode === "webgl"}
        />

        <div className="tt-demos-label">ДОПОЛНИТЕЛЬНО: код, семантика, матовое стекло</div>
        <DemoStrip />
      </ScrollArea>

      {/* ─── Right: editor ─── */}
      <ScrollArea scrollbarSize="thin" className="tt-editor">
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
        ) : selectedLampBall != null && lampBalls[selectedLampBall] ? (
          <LampBallEditor
            index={selectedLampBall}
            ball={lampBalls[selectedLampBall]}
            canReset={
              lampBallOriginals[selectedLampBall] != null &&
              serializeLampBalls([lampBalls[selectedLampBall]]) !== serializeLampBalls([lampBallOriginals[selectedLampBall]])
            }
            onChange={updateLampBall}
            onReset={resetLampBall}
          />
        ) : selectedWaxColor != null && waxColors[selectedWaxColor] ? (
          <WaxColorEditor
            index={selectedWaxColor}
            color={waxColors[selectedWaxColor]}
            canReset={
              waxColorOriginals[selectedWaxColor] != null &&
              serialize(waxColors[selectedWaxColor]) !== serialize(waxColorOriginals[selectedWaxColor])
            }
            onChange={updateWaxColor}
            onReset={resetWaxColor}
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
      </ScrollArea>

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

function LampBallEditor({
  index, ball, canReset, onChange, onReset,
}: {
  index: number;
  ball: LampBallConfig;
  canReset: boolean;
  onChange: (patch: Partial<LampBallConfig>) => void;
  onReset: () => void;
}) {
  const track = "linear-gradient(to right, var(--border), var(--accent))";
  return (
    <div className="tt-editor-inner">
      <div className="tt-ed-name">WebGL-шар {index + 1}</div>
      <div className="tt-ed-hint">Индивидуальные размер и скорость. Общая скорость дрейфа ниже в левой панели умножает скорость всех шаров.</div>
      <Slider label="Размер" min={LAMP_BALL_SIZE_MIN} max={LAMP_BALL_SIZE_MAX} step={0.005}
        value={ball.size} track={track} onChange={(size) => onChange({ size })} />
      <Slider label="Скорость шара" min={LAMP_BALL_SPEED_MIN} max={LAMP_BALL_SPEED_MAX} step={0.05}
        value={ball.speed} track={track} onChange={(speed) => onChange({ speed })} />
      {canReset && (
        <button type="button" className="tt-ed-reset" onClick={onReset}>Сбросить к оригиналу</button>
      )}
    </div>
  );
}

function WaxColorEditor({
  index, color, canReset, onChange, onReset,
}: {
  index: number;
  color: OkColor;
  canReset: boolean;
  onChange: (patch: Partial<OkColor>) => void;
  onReset: () => void;
}) {
  return (
    <div className="tt-editor-inner">
      <div className="tt-ed-name">Цвет воска {index + 1}</div>
      <div className="tt-ed-hint">Общий gradient stop для всех WebGL-шаров: от плотного ядра к светлому краю.</div>
      <ColorFields color={color} onChange={onChange} />
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

// ─── WebGL lava controls (palette + scalar knobs; lava themes only) ─────

/** Dynamic WebGL configuration. Ball count/config and wax gradient colors
 * are independent lists; glass and global shader scalars remain single values. */
function LavaWebGlControls({
  glassColor, glassSelected,
  balls, selectedBall,
  waxColors, selectedWaxColor,
  lamp,
  onSelectGlass,
  onSelectBall, onAddBall, onRemoveBall,
  onSelectWaxColor, onAddWaxColor, onRemoveWaxColor,
  onLampChange, onGlassMode,
}: {
  glassColor: OkColor | null;
  glassSelected: boolean;
  balls: readonly LampBallConfig[];
  selectedBall: number | null;
  waxColors: readonly OkColor[];
  selectedWaxColor: number | null;
  lamp: LampScalars;
  onSelectGlass: () => void;
  onSelectBall: (index: number) => void;
  onAddBall: () => void;
  onRemoveBall: (index: number) => void;
  onSelectWaxColor: (index: number) => void;
  onAddWaxColor: () => void;
  onRemoveWaxColor: (index: number) => void;
  onLampChange: (patch: Partial<LampScalars>) => void;
  onGlassMode: (mode: 0 | 1) => void;
}) {
  const posTrack = "linear-gradient(to right, var(--border), var(--accent))";
  return (
    <div className="tt-group">
      <div className="tt-group-title">WebGL-лава</div>

      <div className="tt-layer-label">Стекло</div>
      {glassColor && (
        <SwatchRow name="--lamp-glass" color={glassColor} active={glassSelected} onClick={onSelectGlass} />
      )}

      <div className="tt-layer-head">
        <span className="tt-layer-label">Шары ({balls.length}/{MAX_LAMP_BALLS})</span>
        <button type="button" className="tt-layer-add" disabled={balls.length >= MAX_LAMP_BALLS} onClick={onAddBall}>+ Шар</button>
      </div>
      {balls.map((ball, index) => (
        <div key={index} className={selectedBall === index ? "tt-swatch-row active" : "tt-swatch-row"}>
          <button type="button" className="tt-swatch-row-main" onClick={() => onSelectBall(index)}>
            <span className="tt-ball-marker">{index + 1}</span>
            <span className="tt-swatch-name">Шар {index + 1}</span>
            <span className="tt-swatch-val">r {ball.size.toFixed(3)} · ×{ball.speed.toFixed(2)}</span>
          </button>
          <button type="button" className="tt-swatch-del" disabled={balls.length <= 1}
            onClick={() => onRemoveBall(index)} aria-label={`Удалить WebGL-шар ${index + 1}`}>×</button>
        </div>
      ))}

      <div className="tt-layer-head">
        <span className="tt-layer-label">Цвета воска ({waxColors.length}/{MAX_LAMP_WAX_COLORS})</span>
        <button type="button" className="tt-layer-add" disabled={waxColors.length >= MAX_LAMP_WAX_COLORS} onClick={onAddWaxColor}>+ Цвет</button>
      </div>
      {waxColors.map((color, index) => (
        <div key={index} className={selectedWaxColor === index ? "tt-swatch-row active" : "tt-swatch-row"}>
          <button type="button" className="tt-swatch-row-main" onClick={() => onSelectWaxColor(index)}>
            <span className="tt-swatch" style={{ background: serialize(color) }} />
            <span className="tt-swatch-name">Цвет {index + 1}</span>
            <span className="tt-swatch-val">{serialize(color)}</span>
          </button>
          <button type="button" className="tt-swatch-del" disabled={waxColors.length <= MIN_LAMP_WAX_COLORS}
            onClick={() => onRemoveWaxColor(index)} aria-label={`Удалить цвет воска ${index + 1}`}>×</button>
        </div>
      ))}

      <div className="tt-layer-head">
        <span className="tt-layer-label">Общие параметры</span>
      </div>
      <div className="tt-lamp-light">
        <span className="tt-layer-label" style={{ margin: 0 }}>Режим стекла</span>
        <div className="tt-gradient-kinds">
          <button type="button" className={lamp.light < 0.5 ? "active" : ""} onClick={() => onGlassMode(0)}>Тёмный</button>
          <button type="button" className={lamp.light >= 0.5 ? "active" : ""} onClick={() => onGlassMode(1)}>Светлый</button>
        </div>
      </div>
      {LAMP_GLASS_FIELDS.map((field) => (
        <Slider
          key={field.key}
          label={field.label}
          min={field.min}
          max={field.max}
          step={field.step}
          value={lamp[field.key]}
          track={posTrack}
          onChange={(value) => onLampChange({ [field.key]: value } as Partial<LampScalars>)}
        />
      ))}
      <div className="tt-layer-head">
        <span className="tt-layer-label">Общие параметры шаров</span>
      </div>
      {LAMP_SHAPE_FIELDS.map((field) => (
        <Slider
          key={field.key}
          label={field.label}
          min={field.min}
          max={field.max}
          step={field.step}
          value={lamp[field.key]}
          track={posTrack}
          onChange={(value) => onLampChange({ [field.key]: value } as Partial<LampScalars>)}
        />
      ))}
    </div>
  );
}

// ─── Preview (real components + chrome replica) ─────────────────────────

function Preview({
  drifting, showHoverStates, lampActive,
}: { drifting: boolean; showHoverStates: boolean; lampActive: boolean }) {
  // Capture the preview window element so the scoped LavaBackground can portal
  // its canvas into it (absolute, full-bleed) for a live WYSIWYG lamp.
  const [winEl, setWinEl] = useState<HTMLElement | null>(null);
  const windowClass = [
    "tt-window",
    // The opaque lamp canvas covers the CSS background, so the drift animation
    // is pointless (and wastes paint) while the lamp is painting.
    drifting && !lampActive ? "tt-window-drift" : "",
    showHoverStates ? "tt-window-show-states" : "",
  ].filter(Boolean).join(" ");
  return (
    <div className={windowClass} ref={setWinEl}>
      {lampActive && winEl && <LavaBackground active scopeEl={winEl} />}
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
        {/* CNR-8r: the demo mirrors production md-pre — a thin horizontal
            lane (the CNR-8c idiom), nested inside the stage scroller. */}
        <ScrollArea scrollbarSize="thin" orientation="horizontal">
          <pre className="md-pre tt-code">
            <SyntaxSnippet />
          </pre>
        </ScrollArea>
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
        {/* CNR-8r: the export textarea composes as the thin editor viewport
            (the 8n textarea seam) — native chrome hidden, thin lane over it. */}
        <ScrollArea scrollbarSize="thin" className="flex-1" viewportRender={
          <textarea className="tt-modal-text" value={text} readOnly spellCheck={false} />
        } />
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
