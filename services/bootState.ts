// In-memory flag scoped to the JS runtime: resets on every cold start / reload, so the
// boot sequence in app/loading.tsx always runs before any main-app screen renders.
let bootComplete = false;

export function isBootComplete(): boolean {
  return bootComplete;
}

export function markBootComplete(): void {
  bootComplete = true;
}
