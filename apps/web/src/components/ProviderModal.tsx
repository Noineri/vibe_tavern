import type { ProviderProfileRecord } from "../app-client.js";
import { ConnectionSettingsForm } from "./ConnectionSettingsForm.js";
import type { ConnectionState } from "./app-shell-types.js";
import { Icons } from "./shared/icons.js";

interface ProviderModalProps {
  isOpen: boolean;
  connection: ConnectionState;
  connectionHint: string;
  connectionStatus: string;
  providerProfiles: ProviderProfileRecord[];
  selectedProviderProfileId: string;
  canConnect: boolean;
  canRefreshModels: boolean;
  onClose: () => void;
  onSelectedProviderProfileChange: (providerProfileId: string) => void;
  onLoadProviderProfile: () => void;
  onConnectSavedProfile: () => void;
  onDeleteProviderProfile: () => void;
  onPatchConnection: (patch: Partial<ConnectionState>) => void;
  onConnect: () => void;
  onRefreshModels: () => void;
  onSaveProviderProfile: () => void;
}

export function ProviderModal(input: ProviderModalProps) {
  if (!input.isOpen) {
    return null;
  }

  return (
    <div className="provider-modal-overlay" onClick={input.onClose}>
      <div className="provider-modal" onClick={(event) => event.stopPropagation()}>
        <div className="provider-modal-head">
          <div>
            <div className="sidebar-label">Provider</div>
            <div className="provider-modal-title">API connection</div>
            <div className="provider-modal-copy">Saved profiles, model list, and active chat connection.</div>
          </div>
          <button className="icon-btn" aria-label="Close provider settings" title="Close provider settings" onClick={input.onClose}>
            <Icons.Close />
          </button>
        </div>
        <div className="provider-modal-body">
          <ConnectionSettingsForm
            connection={input.connection}
            connectionHint={input.connectionHint}
            connectionStatus={input.connectionStatus}
            providerProfiles={input.providerProfiles}
            selectedProviderProfileId={input.selectedProviderProfileId}
            canConnect={input.canConnect}
            canRefreshModels={input.canRefreshModels}
            onSelectedProviderProfileChange={input.onSelectedProviderProfileChange}
            onLoadProviderProfile={input.onLoadProviderProfile}
            onConnectSavedProfile={input.onConnectSavedProfile}
            onDeleteProviderProfile={input.onDeleteProviderProfile}
            onPatchConnection={input.onPatchConnection}
            onConnect={input.onConnect}
            onRefreshModels={input.onRefreshModels}
            onSaveProviderProfile={input.onSaveProviderProfile}
          />
        </div>
      </div>
    </div>
  );
}
