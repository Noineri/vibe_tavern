import React from 'react';
import { Notice } from './Notice.js';

export type PrefillSupportState = 'supported' | 'unsupported' | 'unknown';

export function PrefillSupportNotice({
  state,
  t = (key: string) => key,
}: {
  state: PrefillSupportState;
  t?: (key: string) => string;
}) {
  if (state === 'supported') {
    return <Notice kind="success">{t('prefill_supported') || 'Assistant prefill is supported for this provider.'}</Notice>;
  }
  if (state === 'unsupported') {
    return <Notice kind="warning">{t('prefill_unsupported') || 'Assistant prefill is not supported by the active provider.'}</Notice>;
  }
  return <Notice kind="info">{t('prefill_unknown') || 'Prefill support is unknown until provider capabilities are loaded.'}</Notice>;
}
