import { z } from 'zod';
import { Person, samePerson } from './thread.js';

export const DEFAULT_CLAIM_HOURS = 8;

export const Claim = z.object({
  /** Repo-relative POSIX path. */
  file: z.string().min(1),
  reason: z.string().optional(),
  claimedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});
export type Claim = z.infer<typeof Claim>;

/**
 * One person's claims, stored as claims/<owner-key>.json. One file per person
 * means teammates never write the same file, so claims can't conflict.
 */
export const ClaimSet = z.object({
  schemaVersion: z.literal(1),
  owner: Person,
  claims: z.array(Claim).default([]),
});
export type ClaimSet = z.infer<typeof ClaimSet>;

export interface ActiveClaim extends Claim {
  owner: Person;
}

/** Stable, filename-safe key for a person. */
export function ownerKey(p: Person): string {
  return (p.email ?? p.name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
}

export function isActive(claim: Claim, now: Date): boolean {
  return Date.parse(claim.expiresAt) > now.getTime();
}

export function activeClaims(sets: ClaimSet[], now: Date): ActiveClaim[] {
  return sets.flatMap((s) => s.claims.filter((c) => isActive(c, now)).map((c) => ({ ...c, owner: s.owner })));
}

/** Claims on `file` by anyone other than `me`. */
export function claimsByOthers(sets: ClaimSet[], file: string, me: Person, now: Date): ActiveClaim[] {
  return activeClaims(sets, now).filter((c) => c.file === file && !samePerson(c.owner, me));
}

/** Add or refresh claims; drops expired ones. */
export function addClaims(set: ClaimSet, files: string[], opts: { reason?: string; hours?: number; now?: Date }): ClaimSet {
  const now = opts.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (opts.hours ?? DEFAULT_CLAIM_HOURS) * 3_600_000).toISOString();
  const kept = set.claims.filter((c) => isActive(c, now) && !files.includes(c.file));
  const added = files.map((file) => ({ file, claimedAt: now.toISOString(), expiresAt, ...(opts.reason && { reason: opts.reason }) }));
  return { ...set, claims: [...kept, ...added] };
}

/** Remove claims on `files`, or all claims if `files` is empty; drops expired ones. */
export function removeClaims(set: ClaimSet, files: string[], now = new Date()): ClaimSet {
  return { ...set, claims: set.claims.filter((c) => isActive(c, now) && files.length > 0 && !files.includes(c.file)) };
}

/** Merge two versions of one person's claims (same person on two machines): latest claim per file wins. */
export function mergeClaimSets(a: ClaimSet, b: ClaimSet): ClaimSet {
  const byFile = new Map<string, Claim>();
  for (const c of [...a.claims, ...b.claims]) {
    const prev = byFile.get(c.file);
    if (!prev || c.claimedAt > prev.claimedAt) byFile.set(c.file, c);
  }
  return { ...a, claims: [...byFile.values()].sort((x, y) => x.file.localeCompare(y.file)) };
}
