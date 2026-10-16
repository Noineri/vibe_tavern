/** useStoredFirstListing pins (IMAGEGEN_CUSTOM_ENDPOINT_FILTER_REPORT step 11c):
 *  the open path asks for the stored list and fails quietly, the refresh path is
 *  live and loud, a re-run keeps the list inside one scope and starts blank in
 *  another, and a late answer never lands on a newer request or another
 *  profile. Requests are parked promises the test settles by hand; the debounce
 *  is shortened through the hook's own option. */
import { describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../test/dom-env.js";
import { useStoredFirstListing, type StoredFirstListingOptions } from "./use-stored-first-listing.js";

useDomEnv();

const { act, renderHook, waitFor } = await import("@testing-library/react");

type Source = "stored" | undefined;

interface Deferred {
  resolve: (value: string[]) => void;
  reject: (reason: unknown) => void;
}

/** A `load` whose every request is parked until the test settles it. */
function parkedLoad() {
  // "live" stands for the undefined source: toEqual cannot tell [undefined] from [].
  const sources: string[] = [];
  const parked: Deferred[] = [];
  const load = mock((source: Source): Promise<string[]> => {
    sources.push(source ?? "live");
    return new Promise<string[]>((resolve, reject) => {
      parked.push({ resolve, reject });
    });
  });
  return { load, sources, parked };
}

function options(
  load: (source: Source) => Promise<string[]>,
  overrides: Partial<StoredFirstListingOptions<string[]>> = {},
): StoredFirstListingOptions<string[]> {
  return { enabled: true, scope: "p1:backend", inputKey: "k1", storedFirst: true, load, debounceMs: 5, ...overrides };
}

function mountListing(initial: StoredFirstListingOptions<string[]>) {
  return renderHook((props: StoredFirstListingOptions<string[]>) => useStoredFirstListing<string[]>(props), {
    initialProps: initial,
  });
}

describe("useStoredFirstListing — open path", () => {
  it("a saved profile asks for the STORED list, shows the answer and reports it once", async () => {
    const park = parkedLoad();
    const onLoaded = mock((_data: string[]) => {});
    const { result } = mountListing(options(park.load, { onLoaded }));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(park.sources).toEqual(["stored"]));
    await act(async () => {
      park.parked[0].resolve(["a", "b"]);
    });
    expect(result.current.data).toEqual(["a", "b"]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(onLoaded).toHaveBeenCalledTimes(1);
  });

  it("a draft (nothing saved) lists live and fails loudly", async () => {
    const park = parkedLoad();
    const { result } = mountListing(options(park.load, { scope: null, storedFirst: false }));
    await waitFor(() => expect(park.sources).toEqual(["live"]));
    await act(async () => {
      park.parked[0].reject(new Error("upstream down"));
    });
    expect(result.current.error).toBe("upstream down");
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("a failed open path of a saved profile is QUIET: no list, no error, not loading", async () => {
    const park = parkedLoad();
    const { result } = mountListing(options(park.load));
    await waitFor(() => expect(park.sources).toEqual(["stored"]));
    await act(async () => {
      park.parked[0].reject(new Error("upstream down"));
    });
    expect(result.current.error).toBeNull();
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("nothing is requested while disabled; enabling lists; disabling again resets the state", async () => {
    const park = parkedLoad();
    const { result, rerender } = mountListing(options(park.load, { enabled: false }));
    await act(async () => {});
    expect(park.sources).toEqual([]);
    expect(result.current.loading).toBe(false);

    rerender(options(park.load, { enabled: true }));
    await waitFor(() => expect(park.sources).toEqual(["stored"]));
    await act(async () => {
      park.parked[0].resolve(["a"]);
    });
    expect(result.current.data).toEqual(["a"]);

    rerender(options(park.load, { enabled: false }));
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
  });
});

describe("useStoredFirstListing — keeping the list", () => {
  it("a re-run inside the same scope keeps the list on screen while it loads", async () => {
    const park = parkedLoad();
    const { result, rerender } = mountListing(options(park.load));
    await waitFor(() => expect(park.sources).toHaveLength(1));
    await act(async () => {
      park.parked[0].resolve(["a"]);
    });

    rerender(options(park.load, { inputKey: "k2" }));
    expect(result.current.data).toEqual(["a"]);
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(park.sources).toEqual(["stored", "stored"]));
    await act(async () => {
      park.parked[1].resolve(["a", "c"]);
    });
    expect(result.current.data).toEqual(["a", "c"]);
    expect(result.current.loading).toBe(false);
  });

  it("a new scope starts from an empty slate: one profile's list never shows under another", async () => {
    const park = parkedLoad();
    const { result, rerender } = mountListing(options(park.load));
    await waitFor(() => expect(park.sources).toHaveLength(1));
    await act(async () => {
      park.parked[0].resolve(["a"]);
    });

    rerender(options(park.load, { scope: "p2:backend" }));
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(true);
  });

  it("a draft has no scope to keep: every re-run starts blank", async () => {
    const park = parkedLoad();
    const { result, rerender } = mountListing(options(park.load, { scope: null, storedFirst: false }));
    await waitFor(() => expect(park.sources).toHaveLength(1));
    await act(async () => {
      park.parked[0].resolve(["a"]);
    });

    rerender(options(park.load, { scope: null, storedFirst: false, inputKey: "k2" }));
    expect(result.current.data).toBeNull();
  });
});

describe("useStoredFirstListing — refresh", () => {
  it("is LIVE, keeps the list on screen meanwhile and replaces it with the answer", async () => {
    const park = parkedLoad();
    const { result } = mountListing(options(park.load));
    await waitFor(() => expect(park.sources).toHaveLength(1));
    await act(async () => {
      park.parked[0].resolve(["a"]);
    });

    act(() => {
      result.current.refresh();
    });
    expect(park.sources).toEqual(["stored", "live"]);
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toEqual(["a"]);

    await act(async () => {
      park.parked[1].resolve(["a", "new"]);
    });
    expect(result.current.data).toEqual(["a", "new"]);
    expect(result.current.loading).toBe(false);
  });

  it("a failed refresh is LOUD and keeps the list it had", async () => {
    const park = parkedLoad();
    const { result } = mountListing(options(park.load));
    await waitFor(() => expect(park.sources).toHaveLength(1));
    await act(async () => {
      park.parked[0].resolve(["a"]);
    });

    act(() => {
      result.current.refresh();
    });
    await act(async () => {
      park.parked[1].reject(new Error("refresh failed: 502"));
    });
    expect(result.current.error).toBe("refresh failed: 502");
    expect(result.current.data).toEqual(["a"]);
    expect(result.current.loading).toBe(false);
  });

  it("pressed inside the debounce window it takes over: the pending open request never goes out", async () => {
    const park = parkedLoad();
    const { result } = mountListing(options(park.load, { debounceMs: 40 }));
    act(() => {
      result.current.refresh();
    });
    expect(park.sources).toEqual(["live"]);
    await act(async () => {
      park.parked[0].resolve(["live"]);
    });
    expect(result.current.data).toEqual(["live"]);
    // Past the debounce window: the retired open request must not fire.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(park.sources).toEqual(["live"]);
  });

  it("does nothing while disabled", async () => {
    const park = parkedLoad();
    const { result } = mountListing(options(park.load, { enabled: false }));
    act(() => {
      result.current.refresh();
    });
    expect(park.sources).toEqual([]);
    expect(result.current.loading).toBe(false);
  });
});

describe("useStoredFirstListing — request numbering", () => {
  it("a late answer from the previous profile never lands on the new one", async () => {
    const park = parkedLoad();
    const { result, rerender } = mountListing(options(park.load));
    await waitFor(() => expect(park.sources).toHaveLength(1));

    rerender(options(park.load, { scope: "p2:backend" }));
    await waitFor(() => expect(park.sources).toHaveLength(2));
    await act(async () => {
      park.parked[1].resolve(["of-p2"]);
    });
    await act(async () => {
      park.parked[0].resolve(["of-p1"]);
    });
    expect(result.current.data).toEqual(["of-p2"]);
  });

  it("a refresh answer that arrives after a profile switch is ignored", async () => {
    const park = parkedLoad();
    const { result, rerender } = mountListing(options(park.load));
    await waitFor(() => expect(park.sources).toHaveLength(1));
    await act(async () => {
      park.parked[0].resolve(["of-p1"]);
    });
    act(() => {
      result.current.refresh();
    });

    rerender(options(park.load, { scope: "p2:backend" }));
    await waitFor(() => expect(park.sources).toHaveLength(3));
    await act(async () => {
      park.parked[2].resolve(["of-p2"]);
    });
    await act(async () => {
      park.parked[1].resolve(["live-of-p1"]);
    });
    expect(result.current.data).toEqual(["of-p2"]);
    expect(result.current.error).toBeNull();
  });

  it("the newest request wins when answers arrive out of order", async () => {
    const park = parkedLoad();
    const { result } = mountListing(options(park.load));
    await waitFor(() => expect(park.sources).toHaveLength(1));
    act(() => {
      result.current.refresh();
    });
    act(() => {
      result.current.refresh();
    });
    expect(park.sources).toEqual(["stored", "live", "live"]);

    await act(async () => {
      park.parked[2].resolve(["newest"]);
    });
    await act(async () => {
      park.parked[1].resolve(["older"]);
    });
    await act(async () => {
      park.parked[0].resolve(["oldest"]);
    });
    expect(result.current.data).toEqual(["newest"]);
  });
});
