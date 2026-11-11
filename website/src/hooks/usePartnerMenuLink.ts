import { useEffect, useState } from 'react';
import type { PartnerAccess } from '../services/partner';
import { usePartnerProgramOpen } from './usePartnerProgramOpen';

/**
 * Menu label for /partners, or `null` to hide it: shown to everyone while the program is open,
 * otherwise only to partners and invited emails (ADR-021). Auth loads lazily, off the home bundle.
 */
export function usePartnerMenuLink(): string | null {
  const programOpen = usePartnerProgramOpen() === true;
  const [access, setAccess] = useState<PartnerAccess | null>(null);

  useEffect(() => {
    let cancelled = false;
    let stop = () => {};
    void import('../services/partnerMenu').then(({ watchPartnerAccess }) => {
      if (!cancelled) stop = watchPartnerAccess(setAccess);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  if (access === 'partner') return 'Partner dashboard';
  if (programOpen || access === 'join' || access === 'verify_email') return 'Become a partner';
  return null;
}
