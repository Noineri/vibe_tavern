import { useEffect, useRef, useState } from 'react';
import type { Attachment, ImageRoute } from '@vibe-tavern/domain';

/** Surface-agnostic advisory only. The caller's key owns invalidation; callback
 * identity never starts requests. No polling, and no image means no request. */
export function useImageRouteWarning(
  attachments: readonly Attachment[],
  routeKey: string,
  fetchRoute: () => Promise<ImageRoute>,
): boolean {
  const hasImage = attachments.some((attachment) => attachment.type === 'image' || attachment.type === 'video');
  const fetchRef = useRef(fetchRoute);
  fetchRef.current = fetchRoute;
  const [result, setResult] = useState<{ key: string; warn: boolean } | null>(null);
  useEffect(() => {
    let active = true;
    setResult(null);
    if (!hasImage) return;
    const fetchCurrentRoute = fetchRef.current;
    void (async () => {
      try {
        const route = await fetchCurrentRoute();
        if (active) setResult({ key: routeKey, warn: route === 'none' });
      } catch {
        // Unknown/loading never warns; the send's server gate is authoritative.
        if (active) setResult(null);
      }
    })();
    return () => { active = false; };
  }, [hasImage, routeKey]);
  // Hide the old key immediately, before the new effect starts its request.
  return hasImage && result?.key === routeKey && result.warn;
}
