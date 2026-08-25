import {
  DESKTOP_CREDENTIAL_NAMESPACE,
  WindowsCredentialManager as SharedWindowsCredentialManager,
  credentialTargetFor as sharedCredentialTargetFor,
} from "@longhub/windows-credential";

export type {
  DeviceCredentials,
  DeviceCredentialVault,
} from "@longhub/windows-credential";

export function credentialTargetFor(baseUrl: string): string {
  return sharedCredentialTargetFor(baseUrl, DESKTOP_CREDENTIAL_NAMESPACE);
}

export class WindowsCredentialManager extends SharedWindowsCredentialManager {
  constructor() {
    super({ namespace: DESKTOP_CREDENTIAL_NAMESPACE });
  }
}
