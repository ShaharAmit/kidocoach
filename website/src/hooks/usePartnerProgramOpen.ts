import { useEffect, useState } from 'react';
import { fetchPartnerProgramOpen } from '../services/siteConfig';

/** Public partner sign-up switch; `undefined` while loading. */
export function usePartnerProgramOpen(): boolean | undefined {
  const [open, setOpen] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void fetchPartnerProgramOpen().then((value) => {
      if (!cancelled) setOpen(value);
    });
    return () => { cancelled = true; };
  }, []);
  return open;
}
