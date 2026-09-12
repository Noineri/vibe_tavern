import { describe, expect, test } from 'bun:test';

import {
  classifyAttachment,
  composeVoiceTranscript,
  parseStoredAttachments,
  splitVoiceTranscript,
} from '../src/attachment.js';

// STT_PLAN ST-1: audio attachments. `classifyAttachment` is the MIME → type
// gate the pipeline consumes; `parseStoredAttachments` is the stored-JSON
// boundary through which audio purpose/durationMs round-trip. Both are pinned
// here (extend-only — the pre-ST-1 image/video/file behavior must not move).

const AUDIO_MIMES = ['audio/webm', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/x-m4a', 'audio/m4a'];

function storedAudio(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `att_${Math.random().toString(36).slice(2)}`,
    assetId: 'asset_1',
    type: 'audio',
    name: 'note.webm',
    mimeType: 'audio/webm',
    sizeBytes: 2048,
    ...overrides,
  };
}

describe('classifyAttachment — audio (STT_PLAN ST-1)', () => {
  test('the audio MIME matrix classifies as "audio"', () => {
    for (const mime of AUDIO_MIMES) {
      expect(classifyAttachment(mime)).toBe('audio');
    }
  });

  test('existing image/video/file classification is unchanged (extend-only)', () => {
    expect(classifyAttachment('image/png')).toBe('image');
    expect(classifyAttachment('video/webm')).toBe('video');
    expect(classifyAttachment('application/json')).toBe('file');
  });

  test('a non-audio mime is never audio-classified', () => {
    for (const mime of ['application/octet-stream', 'text/plain', 'image/jpeg', 'video/mp4']) {
      expect(classifyAttachment(mime)).not.toBe('audio');
    }
  });
});

describe('audio attachment purpose / durationMs (STT_PLAN ST-1)', () => {
  test('music and ambient purposes plus durationMs survive the stored round-trip', () => {
    const raw = JSON.stringify([
      storedAudio({ name: 'song.mp3', mimeType: 'audio/mp3', purpose: 'music', durationMs: 5210 }),
      storedAudio({ name: 'rain.ogg', mimeType: 'audio/ogg', purpose: 'ambient', durationMs: 900 }),
    ]);
    const parsed = parseStoredAttachments(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed?.[0]).toMatchObject({ purpose: 'music', durationMs: 5210 });
    expect(parsed?.[1]).toMatchObject({ purpose: 'ambient', durationMs: 900 });
  });

  test('a stored voice note without purpose defaults to undefined — the voice default', () => {
    const raw = JSON.stringify([storedAudio({ name: 'note.webm' })]);
    const parsed = parseStoredAttachments(raw);
    expect(parsed?.[0]?.purpose).toBeUndefined();
    expect(parsed?.[0]?.durationMs).toBeUndefined();
  });
});
describe('voice transcript + tone line (STT_PLAN ST-7)', () => {
  test('compose: transcript only when no annotation', () => {
    expect(composeVoiceTranscript('  hello  ')).toBe('hello');
  });

  test('compose: annotation appends the bracketed tone line', () => {
    expect(composeVoiceTranscript(' hello ', 'дрожит, сбивчиво ')).toBe(
      'hello\n[Voice tone: дрожит, сбивчиво]',
    );
  });

  test('compose: empty transcript stays empty even with an annotation', () => {
    expect(composeVoiceTranscript('   ', 'trembling')).toBe('');
  });

  test('compose: whitespace-only annotation is dropped', () => {
    expect(composeVoiceTranscript('hello', '   ')).toBe('hello');
  });

  test('split: inverse of compose', () => {
    const composed = composeVoiceTranscript('hello', 'calm');
    expect(splitVoiceTranscript(composed)).toEqual({ transcript: 'hello', tone: 'calm' });
  });

  test('split: description without a tone line', () => {
    expect(splitVoiceTranscript('just words')).toEqual({ transcript: 'just words', tone: null });
  });

  test('split: an empty tone payload degrades to null', () => {
    expect(splitVoiceTranscript('words\n[Voice tone: ]')).toEqual({ transcript: 'words', tone: null });
  });
});
