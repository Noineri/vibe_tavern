import { beforeAll, describe, expect, it } from "bun:test";
import { StrictMode } from "react";
import { useDomEnv } from "../../../test/dom-env.js";
import { strictTestDouble } from "../../../test/strict-test-double.js";

useDomEnv();

let ThemeTuner: typeof import("./ThemeTuner.js").ThemeTuner;
let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let waitFor: typeof import("@testing-library/react").waitFor;

beforeAll(async () => {
  ({ render, fireEvent, waitFor } = await import("@testing-library/react"));
  ({ ThemeTuner } = await import("./ThemeTuner.js"));
});

/** WebGL stub that behaves like a real context after WEBGL_lose_context:
 * shader creation fails once cleanup has explicitly killed the context. */
function installWebGlMock() {
  const original = HTMLCanvasElement.prototype.getContext;
  let lost = false;
  const shader = {} as WebGLShader;
  const program = {} as WebGLProgram;
  const buffer = {} as WebGLBuffer;
  const uniform = {} as WebGLUniformLocation;
  // Member-for-member WebGLRenderingContext double over the seam: every
  // member LavaBackground reads is provided explicitly (the old proxy's
  // noop-fallback members are now the typed inert noops below), so the
  // double's labeled-miss throw can only fire on a member the component
  // genuinely does not read. getExtension is composed on top typed by its
  // own name (lib.dom's literal-name overload set cannot be satisfied by
  // one plain signature); createProgram/createBuffer lose their old
  // `lost ? null : …` branches — the real lib types them NON-null and no
  // test drives a post-loss creation (the shaderSource guard fires first).
  const getExtension = (name: string): WEBGL_lose_context | null =>
    name === "WEBGL_lose_context"
      ? { loseContext: () => { lost = true; }, restoreContext: () => {} }
      : null;
  const gl = Object.assign(strictTestDouble<WebGLRenderingContext>({
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    FLOAT: 0x1406,
    TRIANGLES: 0x0004,
    createShader: () => lost ? null : shader,
    shaderSource: (value: WebGLShader | null) => {
      if (!value) throw new Error("shaderSource called after WebGL context loss");
    },
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => null,
    deleteShader: () => {},
    createProgram: () => program,
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => null,
    deleteProgram: () => {},
    useProgram: () => {},
    createBuffer: () => buffer,
    bindBuffer: () => {},
    bufferData: () => {},
    deleteBuffer: () => {},
    getAttribLocation: () => 0,
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    getUniformLocation: () => lost ? null : uniform,
    uniform1f: () => {},
    uniform1fv: () => {},
    uniform2f: () => {},
    uniform3fv: () => {},
    uniform4f: () => {},
    viewport: () => {},
    drawArrays: () => {},
  }, "WebGLRenderingContext (LavaBackground stub)"), { getExtension });

  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value(this: HTMLCanvasElement, type: string, ...args: unknown[]) {
      if (type === "webgl" || type === "experimental-webgl") return gl;
      return Reflect.apply(original, this, [type, ...args]);
    },
  });

  return {
    isLost: () => lost,
    restore: () => Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      writable: true,
      value: original,
    }),
  };
}

describe("ThemeTuner preview geometry", () => {
  it("pins each message to the production chat-column boundary", () => {
    const { container } = render(<ThemeTuner />);
    const message = container.querySelector<HTMLElement>(".tt-msg");
    expect(message).not.toBeNull();
    expect(getComputedStyle(message!).maxWidth).toBe(
      "min(calc(820px + 160px),calc(100% - 64px))",
    );
  });

  it("separates animated CSS blobs from the editable WebGL palette", async () => {
    const { container, getByRole, getByText, queryByText } = render(<ThemeTuner />);
    fireEvent.change(getByRole("combobox"), { target: { value: "dark-lava" } });

    await waitFor(() => expect(getByRole("button", { name: "CSS-блобы" }).classList.contains("active")).toBe(true));
    expect(getByText("Пятно 1")).not.toBeNull();
    expect(container.querySelector(".tt-window")?.classList.contains("tt-window-drift")).toBe(true);
    expect(queryByText("lamp-glass")).toBeNull();

    fireEvent.click(getByRole("button", { name: "WebGL-шары" }));
    await waitFor(() => expect(getByText("lamp-glass")).not.toBeNull());
    expect(queryByText("Пятно 1")).toBeNull();
    expect(container.querySelector(".tt-window")?.classList.contains("tt-window-drift")).toBe(false);

    fireEvent.click(getByRole("button", { name: /lamp-glass/ }));
    expect(getByText("--lamp-glass")).not.toBeNull();

    fireEvent.click(getByRole("button", { name: "+ Шар" }));
    expect(getByText("Шар 9")).not.toBeNull();
    expect(getByText("WebGL-шар 9")).not.toBeNull();
    const ballInputs = container.querySelectorAll<HTMLInputElement>(".tt-editor .tt-slider-num");
    fireEvent.change(ballInputs[0], { target: { value: "0.2" } });
    fireEvent.change(ballInputs[1], { target: { value: "1.5" } });
    expect(getByRole("button", { name: /Шар 9/ }).textContent).toContain("r 0.200 · ×1.50");

    fireEvent.click(getByRole("button", { name: "+ Цвет" }));
    expect(getByText("Цвет 5")).not.toBeNull();
    expect(getByText("Цвет воска 5")).not.toBeNull();

    fireEvent.click(getByRole("button", { name: "Экспортировать .css" }));
    const exported = container.querySelector<HTMLTextAreaElement>(".tt-modal-text")?.value ?? "";
    expect(exported).toContain("--lamp-balls:");
    expect(exported).toContain("0.2 1.5");
    expect(exported).toContain("--lamp-wax-colors:");
  });

  it("keeps the scoped WebGL canvas alive through StrictMode effect replay", async () => {
    const webgl = installWebGlMock();
    const view = render(<StrictMode><ThemeTuner /></StrictMode>);
    try {
      fireEvent.change(view.getByRole("combobox"), { target: { value: "dark-lava" } });
      fireEvent.click(await view.findByRole("button", { name: "WebGL-шары" }));
      await waitFor(() => expect(view.container.querySelector(".tt-window canvas")).not.toBeNull());
      expect(webgl.isLost()).toBe(false);
    } finally {
      view.unmount();
      webgl.restore();
    }
  });
});

describe("ThemeTuner scroll chrome (CNR-8r residual sweep)", () => {
  it("the three tool panes ride the shared thin lanes", () => {
    const { container } = render(<ThemeTuner />);
    // The truly-overflowing tool panes (token list, preview stage, editor)
    // ride the app-wide thin lane contract instead of the tuner's old baked
    // 7px WebKit rules — the host's global native fallback is gone, so baked
    // native chrome was the last native-looking scrollbar in the app shell.
    for (const cls of [".tt-scroll", ".tt-stage", ".tt-editor"]) {
      const pane = container.querySelector(cls);
      if (!pane) throw new Error(`${cls} not rendered`);
      expect(pane.getAttribute("data-scroll-area")).toBe("thin");
      expect(pane.querySelector("[data-scroll-viewport]")).not.toBeNull();
    }
    // The demo code card mirrors production md-pre: a thin HORIZONTAL lane
    // (the CNR-8c idiom), nested inside the stage scroller like message code
    // blocks nest inside their scrollers.
    const demoPre = container.querySelector(".tt-demo-card pre.md-pre");
    if (!demoPre) throw new Error("demo code block not rendered");
    const demoArea = demoPre.closest("[data-scroll-area]");
    if (!demoArea) throw new Error("demo code lane not rendered");
    expect(demoArea.getAttribute("data-scroll-area")).toBe("thin");
    // The baked preview-window replicas (fixed sample content) stay native
    // by design — the CNR-8a excluded-by-design row; their 7px baked chrome
    // is the sanctioned exception recorded in components.md.
    const win = container.querySelector(".tt-window");
    if (!win) throw new Error("preview window not rendered");
    expect(win.querySelectorAll("[data-scroll-area]").length).toBe(0);
  });

  it("the export modal textarea composes as the thin editor viewport", () => {
    const { container, getByRole } = render(<ThemeTuner />);
    fireEvent.click(getByRole("button", { name: "Экспортировать .css" }));
    const ta = container.querySelector<HTMLTextAreaElement>(".tt-modal-text");
    if (!ta) throw new Error("export textarea not rendered");
    // The textarea itself IS the ScrollArea viewport (the 8n textarea seam):
    // native chrome hidden, thin lane chrome over it, root marked as the
    // editor composition (kept visible under the phone policy).
    expect(ta.getAttribute("data-scroll-viewport")).not.toBeNull();
    const area = ta.closest("[data-scroll-area]");
    if (!area) throw new Error("export ScrollArea root not rendered");
    expect(area.getAttribute("data-scroll-area")).toBe("thin");
    expect(area.hasAttribute("data-scroll-editor")).toBe(true);
  });
});
