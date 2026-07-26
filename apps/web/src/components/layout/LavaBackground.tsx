import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * LavaBackground — a WebGL lava-lamp rendered behind the app as progressive
 * enhancement over the legacy CSS gradient that lives on <body>.
 *
 * Why this exists (see reports/EDITOR_PERFORMANCE.md, fix-step 5 "Path
 * forward"): the dark-lava theme animates `background-position` on <body>,
 * which is NOT a compositor-only property — Chrome re-rasterizes the whole
 * multi-layer gradient every frame, starving video decode in other tabs. A
 * WebGL fragment shader paints the same lava-lamp look on the 3D engine
 * (separate from the raster/decode pipeline) at a fraction of the cost, and
 * looks better (metaball wax, backlit, physically shaded).
 *
 * Gating (hybrid progressive enhancement):
 *   - only for lava themes (dark-lava for now; light-lava keeps its CSS gradient),
 *   - only when the viewport is wide enough ({@link LAMP_MIN_VIEWPORT}px — there
 *     must be room for the lamp to breathe; narrow/mobile falls back),
 *   - only when WebGL is available,
 *   - never under `prefers-reduced-motion`.
 * When ANY condition fails the canvas is not mounted and the legacy CSS
 * gradient on <body> shows through unchanged — one universal fallback.
 *
 * While the canvas is actually painting, `lava-webgl-active` is added to
 * <html>; the theme CSS uses that to stop the `*-lava-drift` animation (so the
 * expensive body repaint stops — that is the perf win, not the canvas itself).
 *
 * Gutter confinement: wax blobs live ONLY in the gutters left/right of the
 * chat column, never over the text. The column geometry is measured from the
 * <main> element + the --mw token (so it tracks sidebar collapse, rail mode,
 * viewport resize, and the user's message-width setting) and uploaded as the
 * `u_gutters` uniform (two safe x-ranges). Blobs are distributed into those
 * ranges, and a soft mask clips any wax bleed across the column boundary — so
 * the text area shows only the calm glass medium, not crawling wax.
 *
 * The shader is adapted from the standalone prototype
 * (N:/janitor_characters/lava-prototype/index.html). Palette comes from theme
 * tokens (--lamp-glass / --lamp-wax-thin|mid|thick); absent tokens fall back to
 * the prototype's "purple glass + yellow wax" defaults.
 */

// ── Viewport gate ────────────────────────────────────────────────────────
/** Minimum viewport width (px) for the lamp to activate. Below this the legacy
 * CSS gradient is used (cheaper on small screens, no room for blobs). Tune. */
const LAMP_MIN_VIEWPORT = 1500;

/** Themes that opt into the WebGL lamp. light-lava is intentionally excluded
 * for now — a light glass breaks the backlit-wax physical model; revisit later. */
const LAMP_THEMES = new Set(["dark-lava"]);

// ── Default palette (prototype "purple": her real lamp) ──────────────────
const DEFAULT_GLASS: readonly [number, number, number] = [0.06, 0.02, 0.11];
const DEFAULT_THIN: readonly [number, number, number] = [0.98, 0.73, 0.0];
const DEFAULT_MID: readonly [number, number, number] = [1.0, 0.07, 0.0];
const DEFAULT_ORANGE: readonly [number, number, number] = [1.0, 0.478, 0.0];
const DEFAULT_THICK: readonly [number, number, number] = [0.94, 0.0, 0.19];

// ── GLSL ─────────────────────────────────────────────────────────────────
const VERTEX_SHADER = `attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `precision highp float;
varying vec2 v_uv;
uniform float u_time;
uniform vec2  u_resolution;
// Two safe horizontal gutters as viewport-x fractions in [0,1]:
//   x = leftLo..leftHi  (between the sidebar and the chat column)
//   z = rightLo..rightHi (between the chat column and the right edge)
uniform vec4  u_gutters;
uniform vec3  u_glass;
uniform vec3  u_waxThin;
uniform vec3  u_waxMid;
uniform vec3  u_waxOrange;
uniform vec3  u_waxThick;

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
    float t = u_time * 0.4;
    float aspect = u_resolution.x / u_resolution.y;

    float leftLo  = fracToUv(u_gutters.x, aspect);
    float leftHi  = fracToUv(u_gutters.y, aspect);
    float rightLo = fracToUv(u_gutters.z, aspect);
    float rightHi = fracToUv(u_gutters.w, aspect);
    float leftW = leftHi - leftLo;
    float rightW = rightHi - rightLo;

    float field = 0.0;

    // 8 moving metaballs. Per-blob base size varies (mix of small and big);
    // PHYSICS: small blobs move faster than big ones (v ~ 1/r), like real wax.
    for (int i = 0; i < 8; i++) {
        float fi = float(i);
        float ph  = fi * 2.399963;

        float baseR = 0.10 + 0.08 * fract(sin(fi * 43.13) * 78.77);
        float r = baseR + 0.015 * sin(t * 0.5 + ph);
        float v  = 0.40 * (0.10 / baseR);   // small -> fast, big -> slow
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
    vec3 col = u_glass * (0.4 + bgLight * 1.5);

    float waxMask = smoothstep(0.2, 0.22, field) * gutter;
    if (waxMask > 0.001) {
        // Fake 3D normal from the field gradient (finite differences).
        vec2 e = vec2(0.02, 0.0);
        float dx = getField(uv + e.xy) - getField(uv - e.xy);
        float dy = getField(uv + e.yx) - getField(uv - e.yx);
        vec3 n = normalize(vec3(-dx * 15.0, -dy * 15.0, 1.0));

        vec3 lightDir = normalize(vec3(0.0, -1.0, 0.2));
        float wrap = dot(lightDir, n) * 0.5 + 0.5;
        float sss = smoothstep(0.0, 0.9, wrap);
        // 4-stop wax ramp: dense core (red) -> mid -> orange -> bright rim (yellow).
        vec3 wax = mix(u_waxThick, u_waxMid, smoothstep(0.0, 0.33, sss));
        wax = mix(wax, u_waxOrange, smoothstep(0.33, 0.66, sss));
        wax = mix(wax, u_waxThin, smoothstep(0.66, 1.0, sss));

        float thickness = smoothstep(0.2, 0.6, field);
        wax = mix(wax, u_waxThick, thickness * 0.6);

        float distToBulb = length(vec2(0.0, -1.8) - uv);
        float atten = 1.0 / (1.0 + 0.3 * distToBulb * distToBulb);
        wax *= atten * 1.8;

        float rim = 1.0 - max(n.z, 0.0);
        rim = smoothstep(0.5, 1.0, rim);
        wax += u_waxThin * rim * 0.4 * atten;

        col = mix(col, wax, waxMask);
    }

    // Dither to kill banding.
    col += (hash(gl_FragCoord.xy) - 0.5) / 255.0;

    gl_FragColor = vec4(col, 1.0);
}`;

// ── WebGL availability probe (memoised) ──────────────────────────────────
let _hasWebGL: boolean | null = null;
function webglAvailable(): boolean {
  if (_hasWebGL !== null) return _hasWebGL;
  try {
    const c = document.createElement("canvas");
    const ctx = c.getContext("webgl") || c.getContext("experimental-webgl");
    _hasWebGL = !!ctx;
  } catch {
    _hasWebGL = false;
  }
  return _hasWebGL;
}

// ── Palette helpers ──────────────────────────────────────────────────────
function hexToRgb01(hex: string, fallback: readonly [number, number, number]): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [fallback[0], fallback[1], fallback[2]];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function readPalette() {
  const cs = getComputedStyle(document.documentElement);
  const pick = (varName: string, fb: readonly [number, number, number]): [number, number, number] =>
    hexToRgb01(cs.getPropertyValue(varName), fb);
  return {
    glass: pick("--lamp-glass", DEFAULT_GLASS),
    thin: pick("--lamp-wax-thin", DEFAULT_THIN),
    mid: pick("--lamp-wax-mid", DEFAULT_MID),
    orange: pick("--lamp-wax-orange", DEFAULT_ORANGE),
    thick: pick("--lamp-wax-thick", DEFAULT_THICK),
  };
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

// ── Hook: should the lamp be active right now? ───────────────────────────
/**
 * Reactive gate for {@link LavaBackground}. Recomputes on theme change, the
 * user's lava-blobs tweak (`enabled`), viewport crossing {@link
 * LAMP_MIN_VIEWPORT}, and the reduced-motion toggle. WebGL availability is
 * probed once (memoised) and folded in so we never mount the canvas at all
 * when the context can't be created.
 */
export function useLavaBackgroundActive(theme: string | undefined, enabled: boolean): boolean {
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (!enabled || !theme || !LAMP_THEMES.has(theme) || !webglAvailable()) {
      setActive(false);
      return;
    }
    const widthMq = window.matchMedia(`(min-width: ${LAMP_MIN_VIEWPORT}px)`);
    const motionMq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const recompute = () => setActive(widthMq.matches && !motionMq.matches);
    recompute();
    widthMq.addEventListener("change", recompute);
    motionMq.addEventListener("change", recompute);
    return () => {
      widthMq.removeEventListener("change", recompute);
      motionMq.removeEventListener("change", recompute);
    };
  }, [theme, enabled]);
  return active;
}

// ── Component ────────────────────────────────────────────────────────────
export function LavaBackground({
  active,
  messageWidth,
}: {
  active: boolean;
  /** Current chat-column width setting — when it changes the gutter geometry is
   * recomputed (the column max-width derives from --mw, which this selects). */
  messageWidth: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Flips false if the canvas's own WebGL context can't be created (paranoid
  // guard on top of the memoised probe — some machines expose WebGL globally
  // but fail on the real canvas).
  const [contextFailed, setContextFailed] = useState(false);
  // Latest gutter-update fn from the init effect; invoked when messageWidth
  // changes (without re-initialising WebGL).
  const updateGuttersRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = (canvas.getContext("webgl", { antialias: false, alpha: false, depth: false, stencil: false })
      || canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;
    if (!gl) {
      setContextFailed(true);
      return;
    }

    function compile(type: number, src: string): WebGLShader {
      const s = gl!.createShader(type)!;
      gl!.shaderSource(s, src);
      gl!.compileShader(s);
      if (!gl!.getShaderParameter(s, gl!.COMPILE_STATUS)) {
        const log = gl!.getShaderInfoLog(s);
        gl!.deleteShader(s);
        throw new Error(`LavaBackground shader compile failed: ${log ?? "(no log)"}`);
      }
      return s;
    }

    let prog: WebGLProgram | null;
    try {
      const vs = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
      const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
      prog = gl.createProgram();
      if (!prog) throw new Error("createProgram returned null");
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error(`LavaBackground program link failed: ${gl.getProgramInfoLog(prog) ?? "(no log)"}`);
      }
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    } catch (err) {
      console.error(err);
      setContextFailed(true);
      return;
    }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, "a_pos");
    if (aPos >= 0) {
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    }

    const uTime = gl.getUniformLocation(prog, "u_time");
    const uRes = gl.getUniformLocation(prog, "u_resolution");
    const uGutters = gl.getUniformLocation(prog, "u_gutters");
    const uGlass = gl.getUniformLocation(prog, "u_glass");
    const uThin = gl.getUniformLocation(prog, "u_waxThin");
    const uMid = gl.getUniformLocation(prog, "u_waxMid");
    const uOrange = gl.getUniformLocation(prog, "u_waxOrange");
    const uThick = gl.getUniformLocation(prog, "u_waxThick");

    const pal = readPalette();
    if (uGlass) gl.uniform3fv(uGlass, pal.glass);
    if (uThin) gl.uniform3fv(uThin, pal.thin);
    if (uMid) gl.uniform3fv(uMid, pal.mid);
    if (uOrange) gl.uniform3fv(uOrange, pal.orange);
    if (uThick) gl.uniform3fv(uThick, pal.thick);

    // Measure the chat column and upload the two safe gutters (viewport-x
    // fractions). The column is centred in <main> with max-width --mw + 160px,
    // so measuring <main>'s rect tracks sidebar collapse, rail mode, and
    // viewport resize; --mw tracks the user's message-width setting.
    function updateGutters() {
      const vw = window.innerWidth || 1;
      let leftLo = 0;
      let leftHi = 0;
      let rightLo = 0;
      let rightHi = 1;
      const main = document.querySelector("main");
      if (main) {
        const rect = (main as HTMLElement).getBoundingClientRect();
        const mwCss = getComputedStyle(document.documentElement).getPropertyValue("--mw").trim();
        const mw = parseFloat(mwCss) || 820;
        const column = mw + 160;
        const mainL = rect.left;
        const mainW = rect.width;
        const colL = mainL + Math.max(0, (mainW - column) / 2);
        const colR = colL + Math.min(mainW, column);
        leftLo = clamp01(mainL / vw);          // gutter starts at the sidebar's right edge
        leftHi = clamp01(colL / vw);           // ...and ends at the chat column
        rightLo = clamp01(colR / vw);          // right gutter starts at the column's right edge
        rightHi = 1;                           // ...and runs to the viewport edge
      }
      if (uGutters) gl!.uniform4f(uGutters, leftLo, leftHi, rightLo, rightHi);
    }
    updateGuttersRef.current = updateGutters;

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.floor(window.innerWidth * dpr));
      const h = Math.max(1, Math.floor(window.innerHeight * dpr));
      if (canvas!.width !== w || canvas!.height !== h) {
        canvas!.width = w;
        canvas!.height = h;
        gl!.viewport(0, 0, w, h);
      }
      updateGutters();
    }
    resize();
    window.addEventListener("resize", resize);

    // Sidebar collapse / rail toggle / layout shifts resize <main> without a
    // window resize — observe it and refresh the gutters.
    const mainEl = document.querySelector("main");
    let ro: ResizeObserver | null = null;
    if (mainEl && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => updateGutters());
      ro.observe(mainEl);
    }

    document.documentElement.classList.add("lava-webgl-active");

    let raf = 0;
    let tAccum = 0;
    let last = performance.now();
    let running = !document.hidden;

    function frame(time: number) {
      if (uTime) gl!.uniform1f(uTime, time);
      if (uRes) gl!.uniform2f(uRes, canvas!.width, canvas!.height);
      gl!.drawArrays(gl!.TRIANGLES, 0, 6);
    }
    function loop(now: number) {
      if (!running) return;
      const dt = (now - last) / 1000;
      last = now;
      tAccum += dt; // speed fixed at 1.0 (no keyboard control in-app)
      frame(tAccum);
      raf = requestAnimationFrame(loop);
    }

    const onVisibility = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(raf);
      } else if (!running) {
        running = true;
        last = performance.now();
        raf = requestAnimationFrame(loop);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    const onContextLost = (e: Event) => {
      e.preventDefault();
      running = false;
      cancelAnimationFrame(raf);
      document.documentElement.classList.remove("lava-webgl-active");
    };
    canvas.addEventListener("webglcontextlost", onContextLost);

    if (running) raf = requestAnimationFrame(loop);
    else frame(0);

    return () => {
      cancelAnimationFrame(raf);
      running = false;
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      ro?.disconnect();
      document.documentElement.classList.remove("lava-webgl-active");
      updateGuttersRef.current = () => {};
      const lose = gl.getExtension("WEBGL_lose_context");
      if (lose) lose.loseContext();
      if (buf) gl.deleteBuffer(buf);
      if (prog) gl.deleteProgram(prog);
    };
  }, [active]);

  // Recompute gutters when the user changes chat-column width (no WebGL re-init).
  useEffect(() => {
    updateGuttersRef.current();
  }, [messageWidth, active]);

  if (!active || contextFailed) return null;

  return createPortal(
    // z-index:0 sits the canvas above <body>'s own background and below #root
    // (positioned z-index:1 — see styles.css) so app content shines over the
    // lamp. Opaque (alpha:false) so it fully covers the static legacy gradient.
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: "0",
        width: "100vw",
        height: "100vh",
        zIndex: 0,
        pointerEvents: "none",
        display: "block",
      }}
    />,
    document.body,
  );
}
