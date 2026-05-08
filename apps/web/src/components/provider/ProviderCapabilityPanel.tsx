import { cn } from "../../lib/cn.js";
import { Icons } from "../shared/icons.js";

interface ProviderCapabilities {
  nonStreamGeneration: boolean;
  abortSignal: boolean;
  streaming: boolean;
  prefill: boolean;
  sdkSupport: string;
}

interface ProviderCapabilityPanelProps {
  capabilities: ProviderCapabilities | null;
}

export function ProviderCapabilityPanel({ capabilities }: ProviderCapabilityPanelProps) {
  if (!capabilities) return null;

  const items = [
    { label: "SDK", on: capabilities.sdkSupport !== "unsupported" },
    { label: "Abort", on: capabilities.abortSignal },
    { label: "Streaming", on: capabilities.streaming },
    { label: "Non-streaming", on: capabilities.nonStreamGeneration },
    { label: "Prefill", on: capabilities.prefill },
  ];

  return (
    <div className="my-6 rounded-lg border border-border2 bg-s2" style={{ padding: 16 }}>
      <div className="font-ui text-[12px] font-medium uppercase tracking-wider text-t3" style={{ marginBottom: 12 }}>
        Capabilities
      </div>
      <div className="flex flex-wrap gap-2">
        {items.map((item) => (
          <span
            key={item.label}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border font-ui text-[11px] font-medium",
              item.on ? "border-success/20 bg-success/10 text-success" : "border-danger/20 bg-danger/10 text-danger",
            )}
            style={{ padding: "6px 10px" }}
          >
            {item.on ? <Icons.Check /> : <Icons.Close />}
            {item.label}
          </span>
        ))}
      </div>
    </div>
  );
}
