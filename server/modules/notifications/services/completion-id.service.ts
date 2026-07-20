import { createHash } from 'node:crypto';

/** Stable opaque identifier for one completed assistant turn. */
export function createCompletionId(turnIdentity: string, lastSeq: number): string {
  return createHash('sha256').update(`${turnIdentity}:${lastSeq}`).digest('hex');
}
