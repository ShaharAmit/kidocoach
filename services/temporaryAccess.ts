let temporaryPaywallAccess = false;

export function grantTemporaryPaywallAccess(): void {
  temporaryPaywallAccess = true;
}

export function hasTemporaryPaywallAccess(): boolean {
  return temporaryPaywallAccess;
}

export function clearTemporaryPaywallAccess(): void {
  temporaryPaywallAccess = false;
}