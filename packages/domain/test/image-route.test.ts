import { describe, expect, test } from 'bun:test';
import { IMAGE_ROUTE, modelSeesImages, resolveImageRoute } from '../src/image-route.js';

// T0: pure functions, no doubles, global state, paths, waits or DB setup.
describe('image route (CA-1h1)', () => {
  test('native vision takes precedence over a configured fallback', () => {
    for (const visionModel of [undefined, null, '', 'fallback']) expect(resolveImageRoute({ seesImages: true, visionModel })).toBe(IMAGE_ROUTE.native);
  });
  test('non-vision with a fallback describes', () => {
    expect(resolveImageRoute({ seesImages: false, visionModel: 'fallback' })).toBe(IMAGE_ROUTE.describe);
  });
  test('non-vision without a fallback cannot take images', () => {
    expect(resolveImageRoute({ seesImages: false })).toBe(IMAGE_ROUTE.none);
    expect(resolveImageRoute({ seesImages: false, visionModel: null })).toBe(IMAGE_ROUTE.none);
  });
  test('an empty-string vision model is unconfigured; whitespace retains executor truthiness', () => {
    expect(resolveImageRoute({ seesImages: false, visionModel: '' })).toBe(IMAGE_ROUTE.none);
    expect(resolveImageRoute({ seesImages: false, visionModel: ' ' })).toBe(IMAGE_ROUTE.describe);
  });
  test('only the matching model vision capability decides', () => {
    const models = [{ modelSlug: 'vision', capabilities: { vision: true } }, { modelSlug: 'text', capabilities: { vision: false } }];
    expect(modelSeesImages(models, 'vision')).toBe(true);
    expect(modelSeesImages(models, 'text')).toBe(false);
    expect(modelSeesImages(models, 'missing')).toBe(false);
  });
  test('missing cache and missing vision capability both mean false', () => {
    expect(modelSeesImages(undefined, 'model')).toBe(false);
    expect(modelSeesImages([], 'model')).toBe(false);
    expect(modelSeesImages([{ modelSlug: 'model' }], 'model')).toBe(false);
    expect(modelSeesImages([{ modelSlug: 'model', capabilities: {} }], 'model')).toBe(false);
  });
});
