export function getAccessRoute(isPaid: boolean, hasProfile: boolean) {
  if (hasProfile) return isPaid ? '/' : '/paywall';
  return isPaid ? '/onboarding/questionnaire' : '/onboarding/welcome';
}
