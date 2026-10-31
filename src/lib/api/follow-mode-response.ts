/**
 * HTTP side of follow mode (fleet.source = follow, task 57 / 3.6).
 *
 * A write that sidecarmaster owns answers 409 with
 * `{ error: "<what> is managed by sidecarmaster at <url>. Edit it there.", code: 'FOLLOWING_SIDECARMASTER', managedBy }`.
 * `error` stays a string: every admin client renders `body.error` directly.
 */
import { NextResponse } from 'next/server';
import { FollowModeError, getFleetSourceSettings, managedByFor } from '@/lib/db/fleet-source';

/** 409 when follow mode is on, else null. Call it before the body is parsed. */
export async function refuseWriteInFollowMode(what: string): Promise<NextResponse | null> {
  const s = await getFleetSourceSettings();
  if (s.source !== 'follow') return null;
  const err = new FollowModeError(what, s.linkUrl || s.masterUrl);
  return NextResponse.json({ error: err.message, code: err.code, managedBy: managedByFor(s) }, { status: 409 });
}

/** Maps a FollowModeError thrown deeper in the stack to 409; null for any other error. */
export function followModeResponse(err: unknown): NextResponse | null {
  if (!(err instanceof FollowModeError)) return null;
  return NextResponse.json({ error: err.message, code: err.code, managedBy: { url: err.masterUrl } }, { status: 409 });
}
