import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  FRAGMENT_SHADER,
  MAX_LAMP_BALLS,
  MAX_LAMP_WAX_COLORS,
  VERTEX_SHADER,
  readLampPalette,
} from "./lava-shader.js";

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
 *   - only for lava themes (dark-lava + light-lava),
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
 * Two mount modes share the shader/palette in {@link ./lava-shader.ts}:
 *   - production (default): the canvas portals to document.body, is
 *     viewport-fixed, confines wax to chat gutters, and toggles the
 *     `lava-webgl-active` class to stop the body repaint.
 *   - scoped (`scopeEl` prop): the canvas portals INTO that element (absolute,
 *     full-size), paints full-bleed wax (no gutter confinement — so the whole
 *     frame is lamp), and never touches the `<html>` class. The Theme Tuner
 *     uses this to render a live, WYSIWYG lamp inside its preview window.
 *
 * The shader is adapted from the standalone prototype
 * (N:/janitor_characters/lava-prototype/index.html). Palette + tunable scalars
 * come from theme tokens (see lava-shader.ts); absent tokens fall back to the
 * prototype's "purple glass + yellow wax" defaults.
 */

// ── Viewport gate ────────────────────────────────────────────────────────
/** Minimum viewport width (px) for the lamp to activate. Below this the legacy
 * CSS gradient is used (cheaper on small screens, no room for blobs). Tune. */
const LAMP_MIN_VIEWPORT = 1500;

/** Themes that opt into the WebGL lamp. Each theme supplies its own
 * --lamp-* palette tokens in its theme file; absent tokens fall back to
 * the prototype's "purple glass + yellow wax" defaults. */
const LAMP_THEMES = new Set(["dark-lava", "light-lava"]);

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
  scopeEl,
}: {
  active: boolean;
  /** Current chat-column width setting — when it changes the gutter geometry is
   * recomputed (the column max-width derives from --mw, which this selects).
   * Unused in scoped mode. */
  messageWidth?: string;
  /** Scoped mount target (Theme Tuner preview). When set, the canvas portals
   * into this element (absolute, full-size), wax paints full-bleed, and the
   * `<html>` class / viewport gate are bypassed. */
  scopeEl?: HTMLElement | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Flips false if the canvas's own WebGL context can't be created (paranoid
  // guard on top of the memoised probe — some machines expose WebGL globally
  // but fail on the real canvas).
  const [contextFailed, setContextFailed] = useState(false);
  // Latest gutter-update fn from the init effect; invoked when messageWidth
  // changes (without re-initialising WebGL).
  const updateGuttersRef = useRef<() => void>(() => {});
  // Latest palette-upload fn from the init effect; invoked when <html>'s theme
  // class changes while the canvas stays mounted (see MutationObserver below).
  const updatePaletteRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const scoped = !!scopeEl;

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
    const uWaxColors = gl.getUniformLocation(prog, "u_waxColors[0]");
    const uWaxColorCount = gl.getUniformLocation(prog, "u_waxColorCount");
    const uBallCount = gl.getUniformLocation(prog, "u_ballCount");
    const uCustomBalls = gl.getUniformLocation(prog, "u_customBalls");
    const uBallSizes = gl.getUniformLocation(prog, "u_ballSizes[0]");
    const uBallSpeeds = gl.getUniformLocation(prog, "u_ballSpeeds[0]");
    const uLight = gl.getUniformLocation(prog, "u_light");
    const uTint = gl.getUniformLocation(prog, "u_tint");
    const uEdge = gl.getUniformLocation(prog, "u_edge");
    const uCore = gl.getUniformLocation(prog, "u_core");
    const uRamp = gl.getUniformLocation(prog, "u_ramp");
    const uSpeed = gl.getUniformLocation(prog, "u_speed");
    const uBulb = gl.getUniformLocation(prog, "u_bulb");
    const uFalloff = gl.getUniformLocation(prog, "u_falloff");

    // Upload the lamp palette + tunable scalars from theme tokens. Re-run when
    // the theme class on <html> changes (a theme switch while `active` stays
    // true — the gate does not flip, so this init effect does not otherwise
    // re-run, and the uniform colours would stay from the previous theme), and
    // — in scoped (tuner) mode — when inline --lamp-* styles change too. Wired
    // to a MutationObserver below, independent of React effect ordering.
    function updatePalette() {
      const p = readLampPalette();
      const lastWax = p.waxColors[p.waxColors.length - 1] ?? [1, 1, 1];
      const waxData = new Float32Array(MAX_LAMP_WAX_COLORS * 3);
      for (let i = 0; i < MAX_LAMP_WAX_COLORS; i++) {
        const color = p.waxColors[i] ?? lastWax;
        waxData.set(color, i * 3);
      }
      const lastBall = p.balls[p.balls.length - 1] ?? { size: 0.1, speed: 1 };
      const ballSizes = new Float32Array(MAX_LAMP_BALLS);
      const ballSpeeds = new Float32Array(MAX_LAMP_BALLS);
      for (let i = 0; i < MAX_LAMP_BALLS; i++) {
        const ball = p.balls[i] ?? lastBall;
        ballSizes[i] = ball.size;
        ballSpeeds[i] = ball.speed;
      }

      if (uGlass) gl!.uniform3fv(uGlass, p.glass);
      if (uWaxColors) gl!.uniform3fv(uWaxColors, waxData);
      if (uWaxColorCount) gl!.uniform1f(uWaxColorCount, p.waxColors.length);
      if (uBallCount) gl!.uniform1f(uBallCount, p.balls.length);
      if (uCustomBalls) gl!.uniform1f(uCustomBalls, p.customBalls);
      if (uBallSizes) gl!.uniform1fv(uBallSizes, ballSizes);
      if (uBallSpeeds) gl!.uniform1fv(uBallSpeeds, ballSpeeds);
      if (uLight) gl!.uniform1f(uLight, p.light);
      if (uTint) gl!.uniform1f(uTint, p.tint);
      if (uEdge) gl!.uniform1f(uEdge, p.edge);
      if (uCore) gl!.uniform1f(uCore, p.core);
      if (uRamp) gl!.uniform1f(uRamp, p.ramp);
      if (uSpeed) gl!.uniform1f(uSpeed, p.speed);
      if (uBulb) gl!.uniform1f(uBulb, p.bulb);
      if (uFalloff) gl!.uniform1f(uFalloff, p.falloff);
    }
    updatePaletteRef.current = updatePalette;
    updatePalette();

    // Measure the chat column and upload the two safe gutters (viewport-x
    // fractions). Scoped mode paints full-bleed (no <main>, no confinement) so
    // the tuner shows the whole lamp. Production measures <main> (centred with
    // max-width --mw + 160px) so the gutters track sidebar collapse, rail mode,
    // viewport resize, and the user's message-width setting.
    function updateGutters() {
      if (scoped) {
        if (uGutters) gl!.uniform4f(uGutters, 0, 1, 1, 1);
        return;
      }
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
      const cw = scopeEl ? scopeEl.clientWidth : window.innerWidth;
      const ch = scopeEl ? scopeEl.clientHeight : window.innerHeight;
      const w = Math.max(1, Math.floor(cw * dpr));
      const h = Math.max(1, Math.floor(ch * dpr));
      if (canvas!.width !== w || canvas!.height !== h) {
        canvas!.width = w;
        canvas!.height = h;
        gl!.viewport(0, 0, w, h);
      }
      updateGutters();
    }
    resize();
    window.addEventListener("resize", resize);

    // Sidebar collapse / rail toggle (production) or scopeEl size changes
    // (tuner) happen without a window resize — observe the relevant element.
    const observedEl = scopeEl ?? document.querySelector("main");
    let ro: ResizeObserver | null = null;
    if (observedEl && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => resize());
      ro.observe(observedEl);
    }

    // React to theme/token changes on <html>:
    //  - `class` (both modes): applyThemeClass swaps theme classes here on a
    //    theme switch while `active` stays true — re-upload so blob/glass
    //    colours match the now-active theme.
    //  - `style` (scoped only): the Theme Tuner writes --lamp-* overrides as
    //    inline styles here while tuning — re-upload so the preview is live.
    // Throttled to one read per animation frame so a slider drag storm does
    // not thrash getComputedStyle. (Also fires when this component toggles
    // `lava-webgl-active` in production; harmless no-op.)
    let paletteRaf = 0;
    const schedulePalette = () => {
      if (paletteRaf) return;
      paletteRaf = requestAnimationFrame(() => {
        paletteRaf = 0;
        updatePaletteRef.current();
      });
    };
    const themeObserver = new MutationObserver(schedulePalette);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: scoped ? ["class", "style"] : ["class"],
    });

    if (!scoped) document.documentElement.classList.add("lava-webgl-active");

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
      tAccum += dt; // drift speed is driven by the u_speed uniform (no JS knob)
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
      if (!scoped) document.documentElement.classList.remove("lava-webgl-active");
    };
    canvas.addEventListener("webglcontextlost", onContextLost);

    if (running) raf = requestAnimationFrame(loop);
    else frame(0);

    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(paletteRaf);
      running = false;
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      ro?.disconnect();
      themeObserver.disconnect();
      if (!scoped) document.documentElement.classList.remove("lava-webgl-active");
      updateGuttersRef.current = () => {};
      updatePaletteRef.current = () => {};
      // React StrictMode replays passive effects in development as
      // setup → cleanup → setup while keeping the SAME canvas connected. A
      // synchronous loseContext() here permanently kills that canvas before
      // the real setup runs, so the Theme Tuner drops into contextFailed and
      // removes its preview canvas. Defer the destructive release until after
      // React has committed DOM removal; a replayed/updated effect keeps the
      // canvas connected and must be allowed to initialise a fresh program.
      const lose = gl.getExtension("WEBGL_lose_context");
      if (lose) {
        setTimeout(() => {
          if (!canvas.isConnected) lose.loseContext();
        }, 0);
      }
      if (buf) gl.deleteBuffer(buf);
      if (prog) gl.deleteProgram(prog);
    };
  }, [active, scopeEl]);

  // Recompute gutters when the user changes chat-column width (no WebGL re-init).
  useEffect(() => {
    updateGuttersRef.current();
  }, [messageWidth, active]);

  if (!active || contextFailed) return null;

  const target = scopeEl ?? document.body;
  return createPortal(
    // Production: z-index:0 sits the canvas above <body>'s own background and
    // below #root (positioned z-index:1 — see styles.css) so app content shines
    // over the lamp; opaque (alpha:false) so it fully covers the static legacy
    // gradient. Scoped: absolute, fills the host element; the host's content
    // stacks above via its own z-index:1 (see ThemeTuner TT_CSS).
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={
        scopeEl
          ? { position: "absolute", inset: "0", width: "100%", height: "100%", zIndex: 0, pointerEvents: "none", display: "block" }
          : { position: "fixed", inset: "0", width: "100vw", height: "100vh", zIndex: 0, pointerEvents: "none", display: "block" }
      }
    />,
    target,
  );
}
