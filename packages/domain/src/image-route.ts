/** The shared routing decision for image input (CA-1h1). */
export const IMAGE_ROUTE = { native: 'native', describe: 'describe', none: 'none' } as const;
export type ImageRoute = (typeof IMAGE_ROUTE)[keyof typeof IMAGE_ROUTE];

/** Structural cache view: domain never imports executor or store types. */
export function modelSeesImages(
  cachedModels: readonly { modelSlug: string; capabilities?: { vision?: boolean } }[] | undefined,
  modelSlug: string,
): boolean {
  const activeModel = cachedModels?.find((model) => model.modelSlug === modelSlug);
  return activeModel?.capabilities?.vision ?? false;
}

/** Mirror executor truthiness: an empty vision model is not configured. */
export function resolveImageRoute(input: { seesImages: boolean; visionModel?: string | null }): ImageRoute {
  if (input.seesImages) return IMAGE_ROUTE.native;
  return input.visionModel ? IMAGE_ROUTE.describe : IMAGE_ROUTE.none;
}
