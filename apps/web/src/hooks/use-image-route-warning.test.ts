import { describe, expect, mock, test } from 'bun:test';
import type { Attachment, ImageRoute } from '@vibe-tavern/domain';
import { useDomEnv } from '../../test/dom-env.js';
import { useImageRouteWarning } from './use-image-route-warning.js';

useDomEnv({ failOnNetwork: true });
const { act, renderHook, waitFor } = await import('@testing-library/react');

// T1: fetchRoute is the explicit external seam. No globals, paths, timers,
// i18n initialization or DBs; deferred promises pin races deterministically.
const image: Attachment = { id: 'image', assetId: 'asset', type: 'image', name: 'a.png', mimeType: 'image/png', sizeBytes: 4 };
function parked() {
  let resolve!: (route: ImageRoute) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ImageRoute>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('shared image-route warning (CA-1h2)', () => {
  test('no image/video means no request, even when the key changes', () => {
    const fetchRoute = mock(async () => 'none' as const);
    const hook = renderHook(({ attachments, key }: { attachments: Attachment[]; key: string }) => useImageRouteWarning(attachments, key, fetchRoute), { initialProps: { attachments: [] as Attachment[], key: 'one' } });
    expect(hook.result.current).toBe(false);
    hook.rerender({ attachments: [{ ...image, type: 'file', mimeType: 'text/plain' }], key: 'two' });
    expect(fetchRoute).not.toHaveBeenCalled();
  });
  for (const route of ['none', 'native', 'describe'] as const) {
    test(`image with ${route}: warning=${route === 'none'}`, async () => {
      const fetchRoute = mock(async () => route);
      const hook = renderHook(() => useImageRouteWarning([image], 'key', fetchRoute));
      await waitFor(() => expect(fetchRoute).toHaveBeenCalledTimes(1));
      await act(async () => {});
      expect(hook.result.current).toBe(route === 'none');
    });
  }
  test('key changes refetch, hide while loading and ignore a late response from the old key', async () => {
    const old = parked();
    const fresh = parked();
    const fetchRoute = mock(() => old.promise);
    const hook = renderHook(({ key }) => useImageRouteWarning([image], key, fetchRoute), { initialProps: { key: 'old' } });
    expect(hook.result.current).toBe(false);
    fetchRoute.mockImplementation(() => fresh.promise);
    hook.rerender({ key: 'new' });
    expect(fetchRoute).toHaveBeenCalledTimes(2);
    await act(async () => fresh.resolve('native'));
    await act(async () => old.resolve('none'));
    expect(hook.result.current).toBe(false);
  });
  test('a visible warning disappears immediately on key change and errors stay unknown', async () => {
    const next = parked();
    const fetchRoute = mock<() => Promise<ImageRoute>>(async () => 'none');
    const hook = renderHook(({ key }) => useImageRouteWarning([image], key, fetchRoute), { initialProps: { key: 'one' } });
    await waitFor(() => expect(hook.result.current).toBe(true));
    fetchRoute.mockImplementation(() => next.promise);
    hook.rerender({ key: 'two' });
    expect(hook.result.current).toBe(false);
    await act(async () => next.reject(new Error('Unknown')));
    expect(hook.result.current).toBe(false);
  });
  test('removal cancels the result; reattaching video refetches and callback identity does not poll', async () => {
    const pending = parked();
    const fetchRoute = mock(() => pending.promise);
    const hook = renderHook(({ attachments }: { attachments: Attachment[] }) => useImageRouteWarning(attachments, 'key', () => fetchRoute()), { initialProps: { attachments: [image] } });
    hook.rerender({ attachments: [] });
    await act(async () => pending.resolve('none'));
    expect(hook.result.current).toBe(false);
    hook.rerender({ attachments: [{ ...image, type: 'video', mimeType: 'video/mp4' }] });
    await waitFor(() => expect(hook.result.current).toBe(true));
    hook.rerender({ attachments: [image] });
    expect(fetchRoute).toHaveBeenCalledTimes(2);
  });
  test('a rejected or synchronously throwing fetch hides the warning', async () => {
    for (const fetchRoute of [mock(async () => { throw new Error('Offline'); }), mock((): Promise<ImageRoute> => { throw new Error('Invalid target'); })]) {
      const hook = renderHook(() => useImageRouteWarning([image], 'key', fetchRoute));
      await act(async () => {});
      expect(hook.result.current).toBe(false);
      hook.unmount();
    }
  });
});
