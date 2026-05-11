import React from 'react';
import { useT } from '../../i18n/context.js';
import { Icons } from '../shared/icons.js';
import { cn } from '../../lib/cn.js';

interface Capabilities {
  nonStreamGeneration: boolean;
  abortSignal: boolean;
  streaming: boolean;
  prefill: boolean;
  sdkSupport: string;
}

interface ProviderCapabilityPanelProps {
  capabilities: Capabilities | null;
}

export function ProviderCapabilityPanel({ capabilities }: ProviderCapabilityPanelProps) {
  const { t } = useT();
  if (!capabilities) return null;

  const items = [
    { label: t('cap_non_streaming'), on: capabilities.nonStreamGeneration },
    { label: t('cap_streaming'), on: capabilities.streaming },
    { label: t('cap_abort'), on: capabilities.abortSignal },
    { label: t('cap_prefill'), on: capabilities.prefill },
    { label: t('cap_sdk'), on: capabilities.sdkSupport !== 'unsupported' },
  ];

  return (
    <div className="my-6 rounded-lg border border-border2 bg-s2 p-4">
      <div
        className="font-ui text-[12px] font-medium uppercase tracking-wider text-t3 mb-3"
      >
        {t("capabilities")}
      </div>
      <div className="flex flex-wrap gap-2">
        {items.map((it) => (
          <span
            key={it.label}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 font-ui text-[11px] font-medium',
              it.on
                ? 'border-success/20 bg-success/10 text-success'
                : 'border-danger/20 bg-danger/10 text-danger'
            )}
            >
            {it.on ? <Icons.Check /> : <Icons.Close />}
            {it.label}
          </span>
        ))}
      </div>
    </div>
  );
}
