import { describe, expect, test } from 'bun:test';

import {
  attachmentPromptTokens,
  classifyAttachment,
  filterPromptVisibleAttachments,
  isTextMime,
  TEXT_MIME_TO_EXT,
  textMimeForExtension,
  textMimeForFileName,
  resolveAttachmentUploadMime,
  composeVoiceTranscript,
  parseStoredAttachments,
  promptVisibleAttachmentsOf,
  splitVoiceTranscript,
  withImageGenPromptFallback,
  type Attachment,
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

describe('image-gen slot prompt textual fallback (IMAGE_GENERATION_PLAN IG-CF9)', () => {
  function slot(overrides: Partial<Attachment> = {}): Attachment {
    return {
      id: 'slot_att_1',
      assetId: 'asset_slot_1',
      type: 'image',
      name: 'slot1.png',
      mimeType: 'image/png',
      sizeBytes: 12,
      description: null,
      includeInPrompt: true,
      imageGen: { mode: 'portrait', profileId: 'prof1', prompt: 'a lighthouse at dusk', params: {} },
      ...overrides,
    };
  }

  test('(a) included slot with empty description + provenance.prompt → description backfilled with the prompt text', () => {
    const out = withImageGenPromptFallback([slot()]);
    expect(out).toHaveLength(1);
    expect(out[0]?.description).toBe('a lighthouse at dusk');
  });

  test('(b) slot WITH an existing description → untouched (same reference)', () => {
    const input = slot({ description: 'a vision description' });
    const out = withImageGenPromptFallback([input]);
    expect(out[0]).toBe(input);
    expect(out[0]?.description).toBe('a vision description');
  });

  test('(c) non-slot attachment with empty description → untouched (same reference)', () => {
    const plain: Attachment = {
      id: 'plain_1',
      assetId: 'asset_plain_1',
      type: 'image',
      name: 'plain1.png',
      mimeType: 'image/png',
      sizeBytes: 4,
      description: null,
    };
    const out = withImageGenPromptFallback([plain]);
    expect(out[0]).toBe(plain);
    expect(out[0]?.description).toBeNull();
  });

  test('(d) slot whose provenance has NO prompt (legacy) → untouched (same reference)', () => {
    const legacy = slot({ imageGen: { mode: 'portrait', profileId: 'prof1', params: {} } });
    const out = withImageGenPromptFallback([legacy]);
    expect(out[0]).toBe(legacy);
    expect(out[0]?.description).toBeNull();
  });

  test('(e) input array is not mutated', () => {
    const input = slot();
    const arr = [input];
    const out = withImageGenPromptFallback(arr);
    expect(out).not.toBe(arr);
    expect(input.description).toBeNull();
    expect(out[0]?.description).toBe('a lighthouse at dusk');
  });
});

describe('text attachment types (CA-1a)', () => {
  const TEXT_MIME_MATRIX = [
    'text/plain',
    'text/markdown',
    'application/json',
    'application/x-ndjson',
    'text/x-jsonl',
    'text/csv',
  ];

  test('isTextMime is true for each of the six text MIMEs', () => {
    for (const mime of TEXT_MIME_MATRIX) {
      expect(isTextMime(mime)).toBe(true);
    }
  });

  test('isTextMime is false for application/yaml (dropped), images and other types', () => {
    expect(isTextMime('application/yaml')).toBe(false);
    expect(isTextMime('image/png')).toBe(false);
    expect(isTextMime('audio/webm')).toBe(false);
    expect(isTextMime('application/octet-stream')).toBe(false);
    expect(isTextMime('')).toBe(false);
  });

  test('every text MIME still classifies as "file" (classifyAttachment unchanged)', () => {
    for (const mime of TEXT_MIME_MATRIX) {
      expect(classifyAttachment(mime)).toBe('file');
    }
  });

  test('TEXT_MIME_TO_EXT is the one source: its keys are exactly the text MIMEs', () => {
    expect(Object.keys(TEXT_MIME_TO_EXT).sort()).toEqual([...TEXT_MIME_MATRIX].sort());
    expect(TEXT_MIME_TO_EXT['text/x-jsonl']).toBe('jsonl');
    expect(TEXT_MIME_TO_EXT['application/x-ndjson']).toBe('jsonl');
  });

  test('textMimeForExtension maps each extension to its canonical MIME, case-insensitively', () => {
    expect(textMimeForExtension('txt')).toBe('text/plain');
    expect(textMimeForExtension('md')).toBe('text/markdown');
    expect(textMimeForExtension('json')).toBe('application/json');
    expect(textMimeForExtension('jsonl')).toBe('application/x-ndjson');
    expect(textMimeForExtension('csv')).toBe('text/csv');
    expect(textMimeForExtension('CSV')).toBe('text/csv');
    expect(textMimeForExtension('.Md')).toBe('text/markdown');
    expect(textMimeForExtension('png')).toBeNull();
    expect(textMimeForExtension('yaml')).toBeNull();
    expect(textMimeForExtension('')).toBeNull();
  });

  test('textMimeForFileName reads the last extension; no extension or unknown yields null', () => {
    expect(textMimeForFileName('notes.MD')).toBe('text/markdown');
    expect(textMimeForFileName('archive.tar.json')).toBe('application/json');
    expect(textMimeForFileName('log.jsonl')).toBe('application/x-ndjson');
    expect(textMimeForFileName('README')).toBeNull();
    expect(textMimeForFileName('photo.png')).toBeNull();
    expect(textMimeForFileName('')).toBeNull();
  });

  test('tokenCount / summaryTokenCount ride the Attachment and survive stored-JSON parsing', () => {
    const stored = [{
      id: 'att_1',
      assetId: 'asset_1',
      type: 'file',
      name: 'notes.md',
      mimeType: 'text/markdown',
      sizeBytes: 10,
      tokenCount: 1200,
      summaryTokenCount: 90,
    }];
    const parsed = parseStoredAttachments(JSON.stringify(stored));
    const att: Attachment | undefined = parsed?.[0];
    expect(att?.tokenCount).toBe(1200);
    expect(att?.summaryTokenCount).toBe(90);
  });
});

describe('shared attachment upload MIME resolution (CA-1d)', () => {
  for (const [reported, name, expected] of [
    ['', 'notes.md', 'text/markdown'],
    ['application/octet-stream', 'events.JSONL', 'application/x-ndjson'],
    ['application/vnd.ms-excel', 'a.csv', 'text/csv'],
    ['audio/webm;codecs=opus', 'note.webm', 'audio/webm'],
    [' IMAGE/PNG ; charset=binary', 'x.txt', 'image/png'],
    ['audio/mpeg', 'x.md', 'audio/mpeg'],
    ['video/mp4', 'x.json', 'video/mp4'],
    ['application/x-msdownload', 'a.exe', 'application/x-msdownload'],
    ['TEXT/PLAIN; charset=utf-8', 'README', 'text/plain'],
  ]) {
    test(`${reported || 'empty MIME'} + ${name} -> ${expected}`, () => {
      expect(resolveAttachmentUploadMime(reported!, name!)).toBe(expected);
    });
  }

  test('all audio types accepted by the existing RP picker classify as audio', () => {
    for (const mime of ['audio/mp4', 'audio/mpeg', 'audio/x-wav', 'audio/flac']) {
      expect(classifyAttachment(mime)).toBe('audio');
    }
  });
});

describe('prompt attachment visibility (CA-1b)', () => {
  const textFile: Attachment = {
    id: 'file_1', assetId: 'asset_file_1', type: 'file', name: 'notes.md',
    mimeType: 'text/markdown', sizeBytes: 10,
  };

  test('ordinary text file with explicit false is excluded', () => {
    expect(filterPromptVisibleAttachments([{ ...textFile, includeInPrompt: false }])).toEqual([]);
  });

  test('ordinary text file without the flag is included', () => {
    expect(filterPromptVisibleAttachments([textFile])).toEqual([textFile]);
  });

  test('ordinary image without the flag is included', () => {
    const image: Attachment = { ...textFile, type: 'image', name: 'photo.png', mimeType: 'image/png' };
    expect(filterPromptVisibleAttachments([image])).toEqual([image]);
  });

  test('every ordinary attachment kind obeys explicit false and true', () => {
    for (const type of ['file', 'image', 'video', 'audio'] as const) {
      const excluded: Attachment = { ...textFile, type, includeInPrompt: false };
      const included: Attachment = { ...excluded, includeInPrompt: true };
      expect(filterPromptVisibleAttachments([excluded, included])).toEqual([included]);
    }
  });

  test('image-gen slots stay opt-in: absent and false off, only true on', () => {
    const slot: Attachment = {
      ...textFile, type: 'image', mimeType: 'image/png',
      imageGen: { mode: 'portrait', profileId: 'profile_1', params: {} },
    };
    const included = { ...slot, includeInPrompt: true };
    expect(filterPromptVisibleAttachments([slot, { ...slot, includeInPrompt: false }, included])).toEqual([included]);
  });
});

describe('stored prompt visibility projection (CA-3a)', () => {
  const image: Attachment = { id: 'img', assetId: 'asset', type: 'image', name: 'a.png', mimeType: 'image/png', sizeBytes: 4 };
  test('empty columns omit the field; a present empty array preserves the RP shape', () => {
    for (const raw of [undefined, null, '']) expect(promptVisibleAttachmentsOf(raw)).toBeUndefined();
    expect(promptVisibleAttachmentsOf('[]')).toEqual([]);
  });
  test('excludes files and off image-gen slots, keeps ordinary images and backfills included slots', () => {
    const file: Attachment = { ...image, id: 'file', type: 'file', mimeType: 'text/markdown', includeInPrompt: false };
    const off: Attachment = { ...image, id: 'off', imageGen: { mode: 'portrait', profileId: 'p', prompt: 'Tower', params: {} } };
    const on = { ...off, id: 'on', includeInPrompt: true };
    expect(promptVisibleAttachmentsOf(JSON.stringify([file, off, image, on]))).toEqual([image, { ...on, description: 'Tower' }]);
  });
});

describe('attachment prompt token weights (CA-1c)', () => {
  function file(overrides: Partial<Attachment> = {}): Attachment {
    return {
      id: 'file_1', assetId: 'asset_file_1', type: 'file', name: 'notes.md',
      mimeType: 'text/markdown', sizeBytes: 10, tokenCount: 400_000, ...overrides,
    };
  }

  function unexpectedEstimate(): number {
    throw new Error('Stored counts and non-text attachments must not estimate text');
  }

  test('images, video, audio and non-text files weigh zero even with descriptions and counts', () => {
    for (const [type, mimeType] of [
      ['image', 'image/png'], ['video', 'video/mp4'], ['audio', 'audio/webm'], ['file', 'application/pdf'],
    ] as const) {
      expect(attachmentPromptTokens([file({ type, mimeType, description: 'Description', summaryTokenCount: 50 })], unexpectedEstimate)).toBe(0);
    }
  });

  test('every accepted text MIME weighs its stored full-text count', () => {
    for (const mimeType of Object.keys(TEXT_MIME_TO_EXT)) {
      expect(attachmentPromptTokens([file({ mimeType })], unexpectedEstimate)).toBe(400_000);
    }
  });

  test('a summarized text file uses its summary count instead of its full count', () => {
    expect(attachmentPromptTokens([file({ description: 'Summary', summaryTokenCount: 90 })], unexpectedEstimate)).toBe(90);
  });

  test('a summary without a stored count estimates the exact description, never the full file', () => {
    const descriptions: string[] = [];
    const description = '  Summary\n  ';
    expect(attachmentPromptTokens([file({ description })], (text) => {
      descriptions.push(text);
      return 17;
    })).toBe(17);
    expect(descriptions).toEqual([description]);
  });

  test('a legacy file without a full count weighs zero without reading or estimating assets', () => {
    expect(attachmentPromptTokens([file({ tokenCount: undefined })], unexpectedEstimate)).toBe(0);
  });

  test('null, absent, empty and whitespace-only descriptions use the full count, not a stale summary count', () => {
    for (const description of [null, undefined, '', ' \t\n']) {
      expect(attachmentPromptTokens([file({ description, summaryTokenCount: 90 })], unexpectedEstimate)).toBe(400_000);
    }
  });

  test('stored zero full-text and summary counts are honored without fallback', () => {
    expect(attachmentPromptTokens([file({ tokenCount: 0 })], unexpectedEstimate)).toBe(0);
    expect(attachmentPromptTokens([file({ description: 'Summary', summaryTokenCount: 0 })], unexpectedEstimate)).toBe(0);
  });

  test('absent and empty attachment lists weigh zero', () => {
    expect(attachmentPromptTokens(undefined, unexpectedEstimate)).toBe(0);
    expect(attachmentPromptTokens([], unexpectedEstimate)).toBe(0);
  });

  test('mixed weights sum without mutating the attachment list', () => {
    const attachments = [
      file({ tokenCount: 100 }),
      file({ description: 'Summary', summaryTokenCount: 20 }),
      file({ description: 'Fallback' }),
      file({ tokenCount: undefined }),
      file({ type: 'image', mimeType: 'image/png' }),
    ];
    const before = structuredClone(attachments);
    expect(attachmentPromptTokens(attachments, (text) => text.length)).toBe(128);
    expect(attachments).toEqual(before);
  });

  test('visibility is delegated to the existing filter, not re-derived by the weight helper', () => {
    const excluded = file({ includeInPrompt: false });
    expect(attachmentPromptTokens(filterPromptVisibleAttachments([excluded]), unexpectedEstimate)).toBe(0);
  });
});
