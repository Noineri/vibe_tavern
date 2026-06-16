/**
 * Pure color math + CSS theme parsing for the dev ThemeTuner.
 *
 * No React, no DOM — easily unit-testable. The tuner component imports these
 * helpers to parse a theme CSS file into editable color tokens, let the user
 * nudge them in OKLCH space, apply overrides to `<html>`, and export the
 * result back to a valid theme CSS string.
 *
 * ## Why a separate parser instead of reading computed styles
 *
 * `getComputedStyle(document.documentElement).getPropertyValue('--surface')`
 * would give us the resolved value, but it loses the original authoring format
 * (oklch vs hex, alpha-as-percent, surrounding comments). We instead parse the
 * raw CSS source (imported via Vite `?raw`) so export can do surgical,
 * comment-preserving replacements.
 *
 * ## Parsing safety
 *
 * Color regexes are ANCHORED (`^…$`) so that a shadow like
 * `0 4px 16px oklch(0 0 0 / 8%)` is NOT mistaken for a color token — its value
 * contains an oklch() but is not itself one. Only values that are exactly one
 * oklch() or one hex literal are treated as editable colors.
 */

// ─── Types ──────────────────────────────────────────────────────────────

/** A parsed OKLCH color. `a` is 0–1 fraction, or null when fully opaque. */
export interface OkColor {
  l: number;
  c: number;
  h: number;
  a: number | null;
}

/** A single CSS custom property parsed from a theme file. */
export interface ParsedToken {
  name: string;
  /** Editable color, or null when the value isn't a bare color literal. */
  color: OkColor | null;
  /** The raw value text exactly as authored (trimmed). */
  raw: string;
}

// ─── Forward: OKLCH → sRGB hex ──────────────────────────────────────────
// Björn Ottosson's OKLab matrices. Used by the legacy tuner; kept verbatim.

function oklchToLinearSrgb(L: number, C: number, H: number): [number, number, number] {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function linearToGamma(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function toByte(c: number): number {
  return Math.max(0, Math.min(255, Math.round(linearToGamma(c) * 255)));
}

/** Convert OKLCH to an sRGB hex string (gamut-clamped). */
export function oklchToHex(L: number, C: number, H: number): string {
  const [lr, lg, lb] = oklchToLinearSrgb(L, C, H);
  const r = toByte(lr);
  const g = toByte(lg);
  const b = toByte(lb);
  return (
    "#" +
    r.toString(16).padStart(2, "0") +
    g.toString(16).padStart(2, "0") +
    b.toString(16).padStart(2, "0")
  );
}

// ─── Inverse: sRGB hex → OKLCH ──────────────────────────────────────────
// Used to import a color picked in the native OS color input.

function hexToSrgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  const num = parseInt(h, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function srgbToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** Convert an sRGB hex literal to OKLCH [L, C, H]. */
export function hexToOklch(hex: string): [number, number, number] {
  const [r, g, b] = hexToSrgb(hex);
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const b_ = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const C = Math.sqrt(a * a + b_ * b_);
  let H = (Math.atan2(b_, a) * 180) / Math.PI;
  if (H < 0) H += 360;
  return [L, C, H];
}

// ─── Serialization ──────────────────────────────────────────────────────

function round(n: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

/** Render an OKLCH color back to a CSS string, matching the theme authoring style. */
export function serialize(col: OkColor): string {
  const l = round(col.l, 3);
  const c = round(col.c, 3);
  const h = round(col.h, 1);
  if (col.a == null) return `oklch(${l} ${c} ${h})`;
  return `oklch(${l} ${c} ${h} / ${Math.round(col.a * 100)}%)`;
}

// ─── Value parsing ──────────────────────────────────────────────────────

/**
 * Parse a single CSS value into an editable color, or null.
 * Anchored regexes: only a bare `oklch(...)` or `#hex` qualifies, so shadow
 * declarations (which contain an inner oklch) are correctly treated as non-color.
 */
export function parseColor(raw: string): OkColor | null {
  const s = raw.trim();

  let m = s.match(
    /^oklch\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*(?:\/\s*([\d.]+)\s*%)?\s*\)$/i,
  );
  if (m) {
    const aRaw = m[4];
    // When the `%` suffix is present the number is 0–100; otherwise a 0–1 fraction.
    const a = aRaw != null ? (aRaw.includes(".") && parseFloat(aRaw) <= 1 ? parseFloat(aRaw) : parseFloat(aRaw) / 100) : null;
    return { l: parseFloat(m[1]), c: parseFloat(m[2]), h: parseFloat(m[3]), a };
  }

  m = s.match(/^#([0-9a-f]{6}|[0-9a-f]{3})$/i);
  if (m) {
    const [l, c, h] = hexToOklch(s);
    return { l, c, h, a: null };
  }

  return null;
}

/** Parse an entire theme CSS source into an ordered list of tokens. */
export function parseThemeCss(raw: string): ParsedToken[] {
  const re = /(--[\w-]+)\s*:\s*([^;]+);/g;
  const out: ParsedToken[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const name = m[1];
    const valRaw = m[2].trim();
    out.push({ name, color: parseColor(valRaw), raw: valRaw });
  }
  return out;
}

// ─── Export: surgical, comment-preserving replacement ───────────────────

/**
 * For "edit existing" mode: take the original CSS source and replace only the
 * tokens the user changed, preserving every comment and untouched line.
 *
 * The replacement targets `<name>:` … `;` and rewrites only the value span,
 * so inline comments after the value survive untouched.
 */
export function applyOverridesToCss(raw: string, overrides: Map<string, string>): string {
  let out = raw;
  for (const [name, value] of overrides) {
    const re = new RegExp(`(${escapeRe(name)}\\s*:\\s*)([^;]+)(;)`);
    out = out.replace(re, `$1${value}$3`);
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Token groups (left-panel swatch list) ──────────────────────────────

export interface TokenGroup {
  title: string;
  tokens: string[];
}

export const GROUPS: readonly TokenGroup[] = [
  { title: "Фоны", tokens: ["--bg", "--surface", "--s2", "--s3", "--user-bg", "--page-bg"] },
  { title: "Границы", tokens: ["--border", "--border2"] },
  { title: "Текст UI", tokens: ["--t1", "--t2", "--t3", "--t4"] },
  { title: "Текст сообщений", tokens: ["--msg-t1", "--msg-t2"] },
  { title: "Markdown", tokens: ["--md-italic", "--md-bold", "--md-bold-italic", "--md-quoted"] },
  { title: "Акцент", tokens: ["--accent", "--accent-t", "--accent-dim", "--accent-hover"] },
  { title: "Выделение", tokens: ["--sel-bg"] },
  {
    title: "Семантика",
    tokens: [
      "--danger", "--danger-dim", "--danger-text",
      "--success", "--success-dim", "--success-text",
      "--info", "--info-dim", "--info-text",
      "--warning", "--warning-dim", "--warning-text",
    ],
  },
  { title: "Текст на цвете", tokens: ["--on-accent", "--on-danger"] },
  {
    title: "Синтаксис (код)",
    tokens: [
      "--syn-keyword", "--syn-string", "--syn-number", "--syn-comment",
      "--syn-property", "--syn-operator", "--syn-punctuation",
      "--syn-bool", "--syn-null", "--syn-function",
    ],
  },
];

// ─── "From scratch" neutral template ────────────────────────────────────
// A grayscale ramp + one blue accent. Structurally valid; the user colors it.

const SCRATCH_DEFAULTS: Array<[string, OkColor]> = [
  ["--bg", { l: 0.5, c: 0, h: 0, a: null }],
  ["--surface", { l: 0.55, c: 0, h: 0, a: null }],
  ["--s2", { l: 0.6, c: 0, h: 0, a: null }],
  ["--s3", { l: 0.66, c: 0, h: 0, a: null }],
  ["--user-bg", { l: 0.58, c: 0, h: 0, a: null }],
  ["--border", { l: 0.6, c: 0, h: 0, a: null }],
  ["--border2", { l: 0.54, c: 0, h: 0, a: null }],
  ["--t1", { l: 0.2, c: 0, h: 0, a: null }],
  ["--t2", { l: 0.4, c: 0, h: 0, a: null }],
  ["--t3", { l: 0.55, c: 0, h: 0, a: null }],
  ["--t4", { l: 0.66, c: 0, h: 0, a: null }],
  ["--msg-t1", { l: 0.22, c: 0, h: 0, a: null }],
  ["--msg-t2", { l: 0.42, c: 0, h: 0, a: null }],
  ["--md-italic", { l: 0.4, c: 0, h: 0, a: null }],
  ["--md-bold", { l: 0.18, c: 0, h: 0, a: null }],
  ["--md-bold-italic", { l: 0.3, c: 0.05, h: 250, a: null }],
  ["--md-quoted", { l: 0.45, c: 0.08, h: 250, a: null }],
  ["--accent", { l: 0.62, c: 0.12, h: 250, a: null }],
  ["--accent-t", { l: 0.55, c: 0.13, h: 250, a: null }],
  ["--accent-dim", { l: 0.62, c: 0.12, h: 250, a: 0.1 }],
  ["--accent-hover", { l: 0.62, c: 0.12, h: 250, a: 0.16 }],
  ["--sel-bg", { l: 0.62, c: 0.12, h: 250, a: 0.22 }],
  ["--danger", { l: 0.52, c: 0.16, h: 18, a: null }],
  ["--danger-dim", { l: 0.92, c: 0.03, h: 18, a: null }],
  ["--danger-text", { l: 0.42, c: 0.14, h: 18, a: null }],
  ["--success", { l: 0.5, c: 0.1, h: 155, a: null }],
  ["--success-dim", { l: 0.92, c: 0.03, h: 155, a: null }],
  ["--success-text", { l: 0.4, c: 0.09, h: 155, a: null }],
  ["--info", { l: 0.52, c: 0.15, h: 250, a: null }],
  ["--info-dim", { l: 0.92, c: 0.03, h: 250, a: null }],
  ["--info-text", { l: 0.42, c: 0.13, h: 250, a: null }],
  ["--warning", { l: 0.52, c: 0.11, h: 65, a: null }],
  ["--warning-dim", { l: 0.92, c: 0.03, h: 65, a: null }],
  ["--warning-text", { l: 0.42, c: 0.09, h: 65, a: null }],
  ["--on-accent", { l: 0.98, c: 0, h: 0, a: null }],
  ["--on-danger", { l: 0.98, c: 0, h: 0, a: null }],
  ["--syn-keyword", { l: 0.55, c: 0.12, h: 280, a: null }],
  ["--syn-string", { l: 0.6, c: 0.1, h: 140, a: null }],
  ["--syn-number", { l: 0.6, c: 0.13, h: 350, a: null }],
  ["--syn-comment", { l: 0.55, c: 0.02, h: 120, a: null }],
  ["--syn-property", { l: 0.6, c: 0.11, h: 90, a: null }],
  ["--syn-operator", { l: 0.55, c: 0.12, h: 20, a: null }],
  ["--syn-punctuation", { l: 0.55, c: 0.01, h: 200, a: null }],
  ["--syn-bool", { l: 0.65, c: 0.14, h: 55, a: null }],
  ["--syn-null", { l: 0.65, c: 0.14, h: 55, a: null }],
  ["--syn-function", { l: 0.6, c: 0.1, h: 240, a: null }],
];

/**
 * Initial color values for "from scratch" mode — derived from {@link SCRATCH_DEFAULTS}.
 * The tuner clones this map so the user starts from a neutral grayscale ramp.
 */
export const SCRATCH_VALUES: ReadonlyMap<string, OkColor> = new Map(SCRATCH_DEFAULTS);

/**
 * Build a complete, ready-to-register theme CSS for "from scratch" mode, using
 * the user's current color values for editable tokens and sensible defaults
 * for non-color tokens (shadows, sizes, linked syntax values).
 */
export function buildScratchCss(
  className: string,
  values: Map<string, OkColor>,
): string {
  const lines: string[] = [];
  lines.push(`/* ══════════════════════════════════════════════════════════════`);
  lines.push(`   ${className} theme — generated by ThemeTuner (from scratch).`);
  lines.push(`   Every color is oklch for consistency. Register in registry.ts`);
  lines.push(`   and @import this file in styles.css to enable.`);
  lines.push(`   ══════════════════════════════════════════════════════════════ */`);
  lines.push(`:root.${className} {`);

  // Editable tokens in group order.
  for (const g of GROUPS) {
    lines.push(`  /* ─── ${g.title} ─── */`);
    for (const tok of g.tokens) {
      const col = values.get(tok);
      if (!col) continue;
      lines.push(`  ${tok.padEnd(16)} ${serialize(col)};`);
    }
    lines.push("");
  }

  // Non-color boilerplate (not slider-tunable; sane defaults).
  lines.push(`  /* ─── Тени ─── */`);
  lines.push(`  --shadow-sm: 0 4px 16px oklch(0 0 0 / 8%);`);
  lines.push(`  --shadow-md: 0 12px 28px oklch(0 0 0 / 10%);`);
  lines.push(`  --shadow-lg: 0 24px 60px oklch(0 0 0 / 12%);`);
  lines.push(`  --shadow-xl: 0 8px 40px oklch(0 0 0 / 10%);`);
  lines.push("");
  lines.push(`  /* ─── Подсветка синтаксиса (служебные) ─── */`);
  lines.push(`  --syn-bg:         var(--bg);`);
  lines.push(`  --syn-variable:   var(--t1);`);
  lines.push("");
  lines.push(`  /* ─── Размеры markdown ─── */`);
  lines.push(`  --md-fs-italic:       calc(var(--mfs) + 1px);`);
  lines.push(`  --md-fs-bold-italic:  calc(var(--mfs) + 1px);`);
  lines.push(`}`);

  return lines.join("\n");
}
