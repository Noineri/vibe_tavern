import React from 'react';
import { Notice } from './Notice.js';
import { useT } from '../../i18n/context.js';

export type PrefillSupportState = 'supported' | 'unsupported' | 'unknown';

export function PrefillSupportNotice({
  state,
}: {
  state: PrefillSupportState;
}) {
  const { t } = useT();
  if (state === 'supported') {
    return <Notice kind="success">{t('prefill_supported')}</Notice>;
  }
  if (state === 'unsupported') {
    return <Notice kind="warning">{t('prefill_unsupported')}</Notice>;
  }
  return <Notice kind="info">{t('prefill_unknown')}</Notice>;
}
