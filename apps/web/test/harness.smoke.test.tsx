import { test, expect, describe } from "bun:test";
import { Profiler, useReducer, type ProfilerOnRenderCallback } from "react";
import { render, act } from "@testing-library/react";
import { useDomEnv } from "./dom-env.js";

// Register a global happy-dom window for THIS file only (unregisters in
// afterAll) so DOM-averse tests elsewhere keep their no-window environment.
useDomEnv();

// Stable dispatcher: useReducer with an identity reducer returns the next
// value and keeps the setter referentially stable across renders.
function useNext<T>(initial: T): [T, (next: T) => void] {
  return useReducer((_: T, next: T) => next, initial);
}

/**
 * Harness smoke test — verifies the bun:test + happy-dom + @testing-library/react
 * + jest-dom matchers stack is wired correctly before relying on it for
 * component isolation tests. If this breaks, the isolation test cannot be
 * trusted, so this is the first thing to fix.
 */
describe("render-test harness", () => {
  test("renders and matches DOM", () => {
    const { getByTestId } = render(<div data-testid="t">hello</div>);
    // Use the queries bound to render's container (created after happy-dom is
    // registered in beforeAll), NOT the global `screen`, whose queries bind to
    // document.body at import time — before the DOM exists.
    expect(getByTestId("t")).toBeInTheDocument();
    expect(getByTestId("t")).toHaveTextContent("hello");
  });

  test("React.Profiler onRender counts a re-render when state changes", () => {
    let commits = 0;
    const onRender: ProfilerOnRenderCallback = () => { commits++; };

    let setX!: (v: number) => void;
    function Probe() {
      const [x, set] = useNext(0);
      setX = set;
      return <div data-testid="probe">{x}</div>;
    }

    render(
      <Profiler id="probe" onRender={onRender}>
        <Probe />
      </Profiler>,
    );
    expect(commits).toBe(1); // mount commit

    act(() => setX(1));
    expect(commits).toBe(2); // exactly one re-render
  });

  test("React.Profiler does NOT fire when an unrelated component re-renders", () => {
    let aCommits = 0;
    let bCommits = 0;

    let setB!: (v: number) => void;
    function B() {
      const [x, set] = useNext(0);
      setB = set;
      return <div data-testid="b">{x}</div>;
    }
    function A() {
      return <div data-testid="a">static</div>;
    }

    const onRenderA: ProfilerOnRenderCallback = () => { aCommits++; };
    const onRenderB: ProfilerOnRenderCallback = () => { bCommits++; };

    render(
      <>
        <Profiler id="a" onRender={onRenderA}><A /></Profiler>
        <Profiler id="b" onRender={onRenderB}><B /></Profiler>
      </>,
    );
    expect(aCommits).toBe(1);
    expect(bCommits).toBe(1);

    act(() => setB(42));
    expect(bCommits).toBe(2);
    expect(aCommits).toBe(1); // A must NOT re-render when B changes
  });
});
