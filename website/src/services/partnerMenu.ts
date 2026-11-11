import { onAuthStateChanged } from 'firebase/auth';
import { auth } from './firebase';
import { loadPartnerAccess, type PartnerAccess } from './partner';

const accessByUid = new Map<string, PartnerAccess>();

/**
 * What the signed-in account may see of the partner program (ADR-021), for menus. `null` while
 * signed out or anonymous, or when the server can't be asked. Checked once per account per page load.
 */
export function watchPartnerAccess(listener: (access: PartnerAccess | null) => void): () => void {
  let latest = 0;
  return onAuthStateChanged(auth, (user) => {
    const run = ++latest;
    if (!user || user.isAnonymous) {
      listener(null);
      return;
    }
    const known = accessByUid.get(user.uid);
    if (known) {
      listener(known);
      return;
    }
    loadPartnerAccess().then(({ access }) => {
      accessByUid.set(user.uid, access);
      if (run === latest) listener(access);
    }).catch(() => {
      if (run === latest) listener(null);
    });
  });
}
