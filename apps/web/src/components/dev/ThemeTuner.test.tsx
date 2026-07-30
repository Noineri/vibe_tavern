import { beforeAll, describe, expect, it } from "bun:test";
import { StrictMode } from "react";
import { useDomEnv } from "../../../test/dom-env.js";

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
  const target = {
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
    getShaderParameter: () => true,
    createProgram: () => lost ? null : program,
    getProgramParameter: () => true,
    createBuffer: () => lost ? null : buffer,
    getAttribLocation: () => 0,
    getUniformLocation: () => lost ? null : uniform,
    getExtension: (name: string) => name === "WEBGL_lose_context"
      ? { loseContext: () => { lost = true; } }
      : null,
  };
  const gl = new Proxy(target, {
    get(object, property, receiver) {
      if (Reflect.has(object, property)) return Reflect.get(object, property, receiver);
      return () => {};
    },
  }) as unknown as WebGLRenderingContext;

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
