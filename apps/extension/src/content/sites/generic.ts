/**
 * The fallback profile for hosts without a dedicated profile or framework marker: the full ladder
 * (execCommand → beforeinput → paste → splice), context from the host map when known, else "other".
 */
import type { WritingContext } from '@jammarly/shared/types';
import type { SiteProfile } from '../field-adapter';
import { defineProfile, GENERIC_LADDER, genericDocHint, withContext } from './base';

export const generic: SiteProfile = defineProfile({
  id: 'generic',
  matches: () => true,
  context: 'other',
  ladder: GENERIC_LADDER,
  protectedSelectors: [],
  bodySelectors: [],
  docHint: (location) => genericDocHint(location),
});

const byContext = new Map<WritingContext, SiteProfile>([['other', generic]]);

/** The generic profile with the given context (cached, stable identity per context). */
export function genericFor(context: WritingContext): SiteProfile {
  let p = byContext.get(context);
  if (!p) {
    p = withContext(generic, context);
    byContext.set(context, p);
  }
  return p;
}
