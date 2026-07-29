/**
 * lava-shader.ts — GLSL + palette plumbing shared by the production
 * {@link LavaBackground} overlay and the Theme Tuner's scoped live preview.
 *
 * Why a shared module: the shader and palette are identical between production
 * (body portal, chat-gutter confinement) and the tuner workbench (scoped into
 * the preview window, full-bleed). Extracting keeps the two surfaces from
 * drifting, and lets the tuner tune the EXACT shader the app ships.
 *
 * Palette source: `--lamp-*` CSS custom properties on :root (theme files).
 * {@link readLampPalette} reads them via getComputedStyle and accepts both
 * authored #hex and the Theme Tuner's oklch() output. OKLCH is converted
 * directly to sRGB floats (the WebGL uniform format); other CSS forms fall
 * back to a canvas fillStyle round-trip. Both source formats therefore reach
 * the shader without collapsing to the default dark-lamp palette.
 *
 * Tunable uniforms (all default to values that reproduce the original shader
 * bit-for-bit, so production visuals are unchanged unless a theme overrides):
 *   u_tint  — light-mode glass tint strength multiplier (default 1.0)
 *   u_edge  — blob silhouette edge softness (default 0.02)
 *   u_core  — core-darkening ramp width (default 0.4)
 *   u_ramp  — wax color-stop spread around the midpoint (default 1.0)
 *   u_speed — metaball drift speed multiplier (default 1.0)
 *   u_light — 0 dark vessel / 1 light tinted field (default 0)
 */

export type RGB01 = readonly [number, number, number];

// ── Default palette (prototype "purple": her real lamp) ──────────────────
export const DEFAULT_GLASS: RGB01 = [0.06, 0.02, 0.11];
export const DEFAULT_THIN: RGB01 = [0.98, 0.73, 0.0];
export const DEFAULT_MID: RGB01 = [1.0, 0.07, 0.0];
export const DEFAULT_ORANGE: RGB01 = [1.0, 0.478, 0.0];
export const DEFAULT_THICK: RGB01 = [0.94, 0.0, 0.19];

// ── Scalar defaults ──────────────────────────────────────────────────
// Dark-vessel baseline (reproduces the original shader exactly when a theme
// has no --lamp-* overrides). `bulb` and `falloff` have SEPARATE light-mode
// defaults (see LAMP_LIGHT_DEFAULTS) applied by readLampPalette when the
// token is absent — the heat source flips to the top and the wax-brightness
// falloff softens so pastel wax stays readable on light glass.
export const LAMP_DEFAULTS = {
  light: 0,
  tint: 1.0,
  edge: 0.02,
  core: 0.4,
  ramp: 1.0,
  speed: 1.0,
  bulb: 0,        // 0 = bottom bulb (dark default)
  falloff: 0.30,  // steep falloff (dark default)
} as const;

/** Auto-defaults for the light glass field (u_light=1). Applied by
 *  readLampPalette only when the theme omits the token, so a theme that
 *  pins a value keeps it; the tuner starts the slider here for light themes. */
export const LAMP_LIGHT_DEFAULTS = {
  bulb: 1,        // 1 = top bulb (light glass is brightest at the top)
  falloff: 0.10,  // soft falloff so wax does not read as dark stains
} as const;

/** Lamp color tokens (hex/oklch in theme CSS), in ramp order core → rim. */
export const LAMP_COLOR_TOKENS = [
  "--lamp-glass",
  "--lamp-wax-thick",
  "--lamp-wax-mid",
  "--lamp-wax-orange",
  "--lamp-wax-thin",
] as const;

/** Lamp scalar tokens (non-color), in the order the tuner panel shows them. */
export const LAMP_SCALAR_TOKENS = [
  "--lamp-light",
  "--lamp-tint",
  "--lamp-edge",
  "--lamp-core",
  "--lamp-ramp",
  "--lamp-speed",
  "--lamp-bulb",
  "--lamp-falloff",
] as const;

export const MAX_LAMP_BALLS = 16;
export const MAX_LAMP_WAX_COLORS = 8;
export const MIN_LAMP_WAX_COLORS = 2;
export const LAMP_BALL_SIZE_MIN = 0.05;
export const LAMP_BALL_SIZE_MAX = 0.3;
export const LAMP_BALL_SPEED_MIN = 0;
export const LAMP_BALL_SPEED_MAX = 3;

export interface LampBallConfig {
  size: number;
  speed: number;
}

const fract = (value: number): number => value - Math.floor(value);

/** The original eight procedural balls, expressed as editable values. Themes
 * without --lamp-balls still use the shader's original formula directly; this
 * list lets the tuner show and clone those same starting sizes. */
export const DEFAULT_LAMP_BALLS: readonly LampBallConfig[] = Array.from(
  { length: 8 },
  (_, index) => ({
    size: 0.10 + 0.08 * fract(Math.sin(index * 43.13) * 78.77),
    speed: 1,
  }),
);

/** Split a CSS comma-list without splitting commas nested inside rgb(),
 * color(), etc. Used by the dynamic WebGL wax palette. */
export function splitCssList(value: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === "(") depth++;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === "," && depth === 0) {
      const item = value.slice(start, i).trim();
      if (item) items.push(item);
      start = i + 1;
    }
  }
  const tail = value.slice(start).trim();
  if (tail) items.push(tail);
  return items;
}

/** Parse --lamp-balls: comma-separated `size speed` pairs. */
export function parseLampBalls(value: string): LampBallConfig[] | null {
  if (!value.trim()) return null;
  const balls: LampBallConfig[] = [];
  for (const item of splitCssList(value).slice(0, MAX_LAMP_BALLS)) {
    const parts = item.trim().split(/\s+/);
    if (parts.length !== 2) return null;
    const size = Number.parseFloat(parts[0]);
    const speed = Number.parseFloat(parts[1]);
    if (!Number.isFinite(size) || !Number.isFinite(speed)) return null;
    balls.push({
      size: Math.max(LAMP_BALL_SIZE_MIN, Math.min(LAMP_BALL_SIZE_MAX, size)),
      speed: Math.max(LAMP_BALL_SPEED_MIN, Math.min(LAMP_BALL_SPEED_MAX, speed)),
    });
  }
  return balls.length > 0 ? balls : null;
}

// ── GLSL ─────────────────────────────────────────────────────────────────

export const VERTEX_SHADER = `attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

export const FRAGMENT_SHADER = `precision highp float;
varying vec2 v_uv;
uniform float u_time;
uniform vec2  u_resolution;
// Two safe horizontal gutters as viewport-x fractions in [0,1]:
//   x = leftLo..leftHi  (between the sidebar and the chat column)
//   z = rightLo..rightHi (between the chat column and the right edge)
#define MAX_BALLS 16
#define MAX_WAX_COLORS 8

uniform vec4  u_gutters;
uniform vec3  u_glass;
uniform vec3  u_waxColors[MAX_WAX_COLORS];
uniform float u_waxColorCount;
uniform float u_ballCount;
uniform float u_customBalls;
uniform float u_ballSizes[MAX_BALLS];
uniform float u_ballSpeeds[MAX_BALLS];
uniform float u_light;   // 0 = dark vessel (dark-lava), 1 = light tinted field (light-lava)
uniform float u_tint;    // light-mode glass tint strength multiplier (default 1.0)
uniform float u_edge;    // blob silhouette edge softness (default 0.02)
uniform float u_core;    // core-darkening ramp width (default 0.4)
uniform float u_ramp;    // wax color-stop spread around the midpoint (default 1.0)
uniform float u_speed;   // master metaball drift speed multiplier (default 1.0)
uniform float u_bulb;    // heat-source vertical position 0=bottom..1=top (dark default 0, light 1)
uniform float u_falloff; // wax brightness distance falloff (dark default 0.30, light 0.10)

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// Fraction -> aspect-corrected uv-x (uv.x spans [-aspect, +aspect]).
float fracToUv(float f, float aspect) {
  return aspect * (2.0 * f - 1.0);
}

// 2D Gaussian Metaball Field — blobs confined to the two gutters.
float getField(vec2 uv) {
    float t = u_time * 0.4 * u_speed;
    float aspect = u_resolution.x / u_resolution.y;

    float leftLo  = fracToUv(u_gutters.x, aspect);
    float leftHi  = fracToUv(u_gutters.y, aspect);
    float rightLo = fracToUv(u_gutters.z, aspect);
    float rightHi = fracToUv(u_gutters.w, aspect);
    float leftW = leftHi - leftLo;
    float rightW = rightHi - rightLo;

    float field = 0.0;

    // Up to 16 moving metaballs. Themes without --lamp-balls stay on the
    // original procedural size/speed formula (u_customBalls=0), preserving the
    // shipped 8-ball lamp. Custom themes upload one size + speed per ball.
    for (int i = 0; i < MAX_BALLS; i++) {
        if (float(i) >= u_ballCount) continue;
        float fi = float(i);
        float ph  = fi * 2.399963;

        float proceduralR = 0.10 + 0.08 * fract(sin(fi * 43.13) * 78.77);
        float baseR = mix(proceduralR, u_ballSizes[i], u_customBalls);
        float individualSpeed = mix(1.0, u_ballSpeeds[i], u_customBalls);
        float r = baseR + 0.015 * sin(t * 0.5 * individualSpeed + ph);
        float v  = 0.40 * (0.10 / baseR) * individualSpeed; // small -> fast, then per-ball multiplier
        float tt = t * v + ph;

        // Pick a gutter per blob; if the chosen one is too thin, collapse to
        // the other so no blob is stranded off-screen.
        bool goRight = fract(sin(fi * 7.7) * 43.3) > 0.5;
        if (leftW < 0.05 && !goRight) goRight = true;
        if (rightW < 0.05 && goRight) goRight = false;
        float lo = goRight ? rightLo : leftLo;
        float hi = goRight ? rightHi : leftHi;
        float within = fract(sin(fi * 12.99) * 78.33);   // position inside [lo,hi]
        float x = mix(lo, hi, within) + 0.10 * sin(tt * 0.8 + ph * 1.3);
        float y = 0.55 * sin(tt + ph);                   // calm vertical rise/fall

        float d = dot(uv - vec2(x, y), uv - vec2(x, y));
        field += 0.35 * exp(-d / (r * r * 1.2));
    }

    return field;
}

vec3 lastWaxColor() {
    vec3 color = u_waxColors[0];
    for (int i = 1; i < MAX_WAX_COLORS; i++) {
        if (float(i) < u_waxColorCount) color = u_waxColors[i];
    }
    return color;
}

vec3 sampleWaxPalette(float value) {
    if (u_waxColorCount < 1.5) return u_waxColors[0];

    // Preserve the original four-stop positions exactly for legacy themes.
    if (u_waxColorCount > 3.5 && u_waxColorCount < 4.5) {
        float p1 = 0.5 - 0.17 * u_ramp;
        float p2 = 0.5 + 0.17 * u_ramp;
        vec3 legacy = mix(u_waxColors[0], u_waxColors[1], smoothstep(0.0, p1, value));
        legacy = mix(legacy, u_waxColors[2], smoothstep(p1, p2, value));
        return mix(legacy, u_waxColors[3], smoothstep(p2, 1.0, value));
    }

    // Dynamic palettes distribute stops evenly. u_ramp expands/contracts the
    // internal positions around the midpoint while endpoints remain stable at
    // the default value 1.0.
    float denominator = max(u_waxColorCount - 1.0, 1.0);
    vec3 color = u_waxColors[0];
    for (int i = 1; i < MAX_WAX_COLORS; i++) {
        if (float(i) < u_waxColorCount) {
            float previousBase = float(i - 1) / denominator;
            float currentBase = float(i) / denominator;
            float previousStop = clamp(0.5 + (previousBase - 0.5) * u_ramp, 0.0, 1.0);
            float currentStop = clamp(0.5 + (currentBase - 0.5) * u_ramp, 0.0, 1.0);
            currentStop = max(currentStop, previousStop + 0.0001);
            color = mix(color, u_waxColors[i], smoothstep(previousStop, currentStop, value));
        }
    }
    return color;
}

void main() {
    vec2 uv = (v_uv - 0.5) * 2.0;
    float aspect = u_resolution.x / u_resolution.y;
    uv.x *= aspect;

    float field = getField(uv);

    // Gutter confinement for the WAX. The glass medium still fills the whole
    // screen; only crawling wax is clipped to the gutters so the chat column
    // stays clean. Soft edges straddle the column boundary (~within the
    // column's internal padding, so text is never touched).
    float leftHi  = fracToUv(u_gutters.y, aspect);
    float rightLo = fracToUv(u_gutters.z, aspect);
    float soft = 0.04 * aspect;
    float gLeft  = 1.0 - smoothstep(leftHi - soft, leftHi + soft, uv.x);
    float gRight = smoothstep(rightLo - soft, rightLo + soft, uv.x);
    float gutter = max(gLeft, gRight);

    // Background — tinted glass, brighter near the bottom bulb.
    float bgLight = exp(-max(0.0, uv.y + 1.0) * 1.5);
    // Dark vessel (u_light=0): glass is a dark tinted medium, dim at the top
    // and glowing toward the bottom bulb. Light field (u_light=1): a near-white
    // cool base tinted toward the glass (u_tint scales the tint strength), so a
    // dark-text palette stays readable; the glass token is a TINT here, not a
    // dark fill. At the defaults (u_light=0, u_tint=1.0) both branches are
    // bit-identical to the original shader.
    vec3 colDark  = u_glass * (0.4 + bgLight * 1.5);
    vec3 colLight = mix(vec3(0.96, 0.965, 0.965), u_glass, (0.22 + bgLight * 0.28) * u_tint);
    vec3 col = mix(colDark, colLight, u_light);

    float waxMask = smoothstep(0.2, 0.2 + u_edge, field) * gutter;
    if (waxMask > 0.001) {
        // Fake 3D normal from the field gradient (finite differences).
        vec2 e = vec2(0.02, 0.0);
        float dx = getField(uv + e.xy) - getField(uv - e.xy);
        float dy = getField(uv + e.yx) - getField(uv - e.yx);
        vec3 n = normalize(vec3(-dx * 15.0, -dy * 15.0, 1.0));

        vec3 lightDir = normalize(vec3(0.0, -1.0, 0.2));
        float wrap = dot(lightDir, n) * 0.5 + 0.5;
        float sss = smoothstep(0.0, 0.9, wrap);
        // Shared dynamic wax palette: dense core -> user-defined intermediate
        // stops -> bright rim. Color count is independent from ball count.
        vec3 coreColor = u_waxColors[0];
        vec3 rimColor = lastWaxColor();
        vec3 wax = sampleWaxPalette(sss);

        float thickness = smoothstep(0.2, 0.2 + u_core, field);
        wax = mix(wax, coreColor, thickness * 0.6);

        // Heat source tracks the glass gradient: bottom bulb for the dark
        // vessel (u_light=0 — bit-identical to the original), top for the
        // light field (u_light=1) so the wax brightens toward the lighter
        // glass band at the top instead of being inverted against it.
        // Heat-source position is a tunable uniform (u_bulb): 0 = bottom
        // bulb (dark vessel default), 1 = top (light field default). Distance
        // falloff (u_falloff) is likewise tunable: steep (0.30) for the dark
        // vessel so wax glows toward the bulb, soft (0.10) for light glass so
        // pastel wax stays bright across the field instead of darkening into
        // stains. Both auto-default via JS to match the glass mode when a
        // theme omits the token (readLampPalette).
        float bulbY = mix(-1.8, 1.8, clamp(u_bulb, 0.0, 1.0));
        float distToBulb = length(vec2(0.0, bulbY) - uv);
        float atten = 1.0 / (1.0 + max(u_falloff, 0.0) * distToBulb * distToBulb);
        wax *= atten * 1.8;

        float rim = 1.0 - max(n.z, 0.0);
        rim = smoothstep(0.5, 1.0, rim);
        wax += rimColor * rim * 0.4 * atten;

        col = mix(col, wax, waxMask);
    }

    // Dither to kill banding.
    col += (hash(gl_FragCoord.xy) - 0.5) / 255.0;

    gl_FragColor = vec4(col, 1.0);
}`;

// ── Color parsing ────────────────────────────────────────────────────────

let _cctx: CanvasRenderingContext2D | null | undefined;
function canvasCtx(): CanvasRenderingContext2D | null {
  if (_cctx !== undefined) return _cctx;
  try {
    _cctx = document.createElement("canvas").getContext("2d");
  } catch {
    _cctx = null;
  }
  return _cctx;
}

function hexToRgb01(n: number): [number, number, number] {
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const clampRgb = (value: number): number => Math.max(0, Math.min(1, value));

/** Convert one linear-sRGB channel to the gamma-encoded sRGB value expected by
 * CSS colors and by the shader's palette uniforms. */
function linearToGamma(value: number): number {
  return value <= 0.0031308
    ? 12.92 * value
    : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
}

/** Parse CSS OKLCH and convert it directly to gamut-clamped sRGB floats.
 * Matrices are Björn Ottosson's reference OKLab conversion, matching the
 * Theme Tuner's color math. CSS percentage chroma maps 100% to 0.4. Alpha is
 * intentionally ignored because lamp uniforms are opaque RGB. */
function oklchToRgb01(css: string): [number, number, number] | null {
  const number = "([+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+))";
  const match = new RegExp(
    `^oklch\\(\\s*${number}(%)?\\s+${number}(%)?\\s+${number}(?:deg)?(?:\\s*\\/\\s*(?:${number}%?|none))?\\s*\\)$`,
    "i",
  ).exec(css);
  if (!match) return null;

  const lightness = Number.parseFloat(match[1]) / (match[2] ? 100 : 1);
  const chroma = Number.parseFloat(match[3]) * (match[4] ? 0.004 : 1);
  const hue = Number.parseFloat(match[5]) * Math.PI / 180;
  if (![lightness, chroma, hue].every(Number.isFinite)) return null;

  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const lRoot = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lRoot * lRoot * lRoot;
  const m = mRoot * mRoot * mRoot;
  const s = sRoot * sRoot * sRoot;

  const red = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const green = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const blue = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return [
    clampRgb(linearToGamma(red)),
    clampRgb(linearToGamma(green)),
    clampRgb(linearToGamma(blue)),
  ];
}

/**
 * Parse a CSS color into gamma-encoded [0,1] sRGB. `#hex` and `oklch()` have
 * direct paths; rgb/hsl/named colors use a canvas 2d fillStyle round-trip.
 * Returns `fallback` if the value is absent or unparseable. The sentinel
 * (`#fefefe`) detects unsupported formats without confusing them with black.
 */
export function cssColorToRgb01(css: string, fallback: RGB01): [number, number, number] {
  const s = css.trim();
  const hexM = /^#?([0-9a-f]{6})$/i.exec(s);
  if (hexM) return hexToRgb01(parseInt(hexM[1], 16));
  const oklch = oklchToRgb01(s);
  if (oklch) return oklch;
  const ctx = canvasCtx();
  if (ctx) {
    ctx.fillStyle = "#fefefe";
    ctx.fillStyle = s;
    const out = ctx.fillStyle;
    if (out !== "#fefefe") {
      const m6 = /^#([0-9a-f]{6})$/i.exec(out);
      if (m6) return hexToRgb01(parseInt(m6[1], 16));
      const ma = /^rgba?\(([^)]+)\)$/i.exec(out);
      if (ma) {
        const p = ma[1].split(",").map((x) => parseFloat(x));
        if (p.length >= 3 && !p.some(Number.isNaN)) return [p[0] / 255, p[1] / 255, p[2] / 255];
      }
    }
  }
  return [fallback[0], fallback[1], fallback[2]];
}

export interface LampPalette {
  glass: [number, number, number];
  /** Shared wax gradient, ordered dense core → bright rim. */
  waxColors: Array<[number, number, number]>;
  balls: LampBallConfig[];
  /** 0 keeps the shader's original procedural ball formula; 1 uses arrays. */
  customBalls: number;
  light: number;
  tint: number;
  edge: number;
  core: number;
  ramp: number;
  speed: number;
  bulb: number;
  falloff: number;
}

/** Read the full lamp palette (colors + scalars) from a root element's computed
 *  style. Absent tokens fall back to the prototype defaults. */
export function readLampPalette(root: HTMLElement = document.documentElement): LampPalette {
  const cs = getComputedStyle(root);
  const color = (name: string, fb: RGB01): [number, number, number] =>
    cssColorToRgb01(cs.getPropertyValue(name), fb);
  const num = (name: string, dflt: number): number => {
    const raw = cs.getPropertyValue(name).trim();
    if (!raw) return dflt;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : dflt;
  };
  const legacyWax: Array<[number, number, number]> = [
    color("--lamp-wax-thick", DEFAULT_THICK),
    color("--lamp-wax-mid", DEFAULT_MID),
    color("--lamp-wax-orange", DEFAULT_ORANGE),
    color("--lamp-wax-thin", DEFAULT_THIN),
  ];
  const waxItems = splitCssList(cs.getPropertyValue("--lamp-wax-colors"));
  const waxColors = waxItems.length >= MIN_LAMP_WAX_COLORS
    ? waxItems.slice(0, MAX_LAMP_WAX_COLORS).map((item, index) =>
        cssColorToRgb01(item, legacyWax[Math.min(index, legacyWax.length - 1)]),
      )
    : legacyWax;
  const customBalls = parseLampBalls(cs.getPropertyValue("--lamp-balls"));
  const light = num("--lamp-light", LAMP_DEFAULTS.light) >= 0.5 ? 1 : 0;
  // bulb / falloff auto-default to the glass mode when the theme omits them,
  // so the heat source tracks the glass gradient without requiring every theme
  // to pin both tokens.
  const bulbDefault = light ? LAMP_LIGHT_DEFAULTS.bulb : LAMP_DEFAULTS.bulb;
  const falloffDefault = light ? LAMP_LIGHT_DEFAULTS.falloff : LAMP_DEFAULTS.falloff;

  return {
    glass: color("--lamp-glass", DEFAULT_GLASS),
    waxColors,
    balls: customBalls ?? DEFAULT_LAMP_BALLS.map((ball) => ({ ...ball })),
    customBalls: customBalls ? 1 : 0,
    light,
    tint: num("--lamp-tint", LAMP_DEFAULTS.tint),
    edge: num("--lamp-edge", LAMP_DEFAULTS.edge),
    core: num("--lamp-core", LAMP_DEFAULTS.core),
    ramp: num("--lamp-ramp", LAMP_DEFAULTS.ramp),
    speed: num("--lamp-speed", LAMP_DEFAULTS.speed),
    bulb: num("--lamp-bulb", bulbDefault),
    falloff: num("--lamp-falloff", falloffDefault),
  };
}
