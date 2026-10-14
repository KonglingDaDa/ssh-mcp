import type { BucketDefinition } from '../config/types.js';

export const KEYWORD_LIMIT = 8;
export const TAG_LIMIT = 12;
export const BUCKET_LIMIT = 30;

export interface CatalogProfile {
  id: string;
  name: string;
  aliases: string[];
  host: string;
  port: number;
  user: string;
  note: string;
  tags: string[];
  authType: 'password' | 'key';
  elevatedViaSu: boolean;
  active: boolean;
}

export interface SearchCard {
  id: string;
  name: string;
  aliases: string[];
  host: string;
  port: number;
  user: string;
  note: string;
  tags: string[];
  auth: { type: 'password' | 'key' };
  active: boolean;
  elevatedViaSu: boolean;
  buckets: string[];
}

export interface CatalogSearchInput {
  query?: string;
  bucket?: string;
  limit?: number;
}

export interface CatalogSearchResult {
  query: string;
  bucket: { id: string; name: string } | null;
  tag: string | null;
  matches: SearchCard[];
  total: number;
  truncated: boolean;
}

function fold(value: string): string {
  return value.trim().toLowerCase();
}

function bucketKeys(bucket: BucketDefinition): string[] {
  return [bucket.id, bucket.name, ...bucket.aliases].map(fold).filter(Boolean);
}

export function profileBucketIds(profile: CatalogProfile, buckets: BucketDefinition[]): string[] {
  const tokens = new Set(profile.tags.map(fold).filter(Boolean));
  return buckets
    .filter((bucket) => bucketKeys(bucket).some((key) => tokens.has(key)))
    .map((bucket) => bucket.id);
}

export function toSearchCard(profile: CatalogProfile, buckets: BucketDefinition[]): SearchCard {
  return {
    id: profile.id,
    name: profile.name,
    aliases: profile.aliases,
    host: profile.host,
    port: profile.port,
    user: profile.user,
    note: profile.note,
    tags: profile.tags,
    auth: { type: profile.authType },
    active: profile.active,
    elevatedViaSu: profile.elevatedViaSu,
    buckets: profileBucketIds(profile, buckets),
  };
}

export function buildDirectory(profiles: CatalogProfile[], buckets: BucketDefinition[]): {
  buckets: Array<{ id: string; name: string; aliases: string[]; note: string; count: number }>;
  unbucketedCount: number;
} {
  const counts = new Map(buckets.map((bucket) => [bucket.id, 0]));
  let unbucketedCount = 0;
  for (const profile of profiles) {
    const ids = profileBucketIds(profile, buckets);
    if (ids.length === 0) {
      unbucketedCount += 1;
      continue;
    }
    for (const id of ids) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return {
    buckets: buckets.map((bucket) => ({
      id: bucket.id,
      name: bucket.name,
      aliases: bucket.aliases,
      note: bucket.note,
      count: counts.get(bucket.id) ?? 0,
    })),
    unbucketedCount,
  };
}

function allowsPartial(query: string): boolean {
  if (query.length >= 2) return true;
  return query.length === 1 && /[^\u0000-\u007f]/.test(query);
}

function matchBuckets(token: string, buckets: BucketDefinition[]): Array<{ bucket: BucketDefinition; kind: 'exact' | 'partial' }> {
  const query = fold(token);
  if (!query) return [];
  const hits: Array<{ bucket: BucketDefinition; kind: 'exact' | 'partial' }> = [];
  for (const bucket of buckets) {
    const keys = bucketKeys(bucket);
    if (keys.some((key) => key === query)) {
      hits.push({ bucket, kind: 'exact' });
    } else if (allowsPartial(query) && keys.some((key) => key.includes(query))) {
      hits.push({ bucket, kind: 'partial' });
    }
  }
  return hits;
}

export function resolveBucket(token: string, buckets: BucketDefinition[]): BucketDefinition {
  const hits = matchBuckets(token, buckets);
  const exact = hits.filter((hit) => hit.kind === 'exact');
  const chosen = exact.length > 0 ? exact : hits;
  if (chosen.length === 1) return chosen[0].bucket;
  if (chosen.length > 1) {
    throw new Error(`Ambiguous bucket "${token}": ${chosen.map((hit) => hit.bucket.id).join(', ')}`);
  }
  throw new Error(`Bucket "${token}" not found`);
}

function tryResolveBucket(token: string, buckets: BucketDefinition[]): BucketDefinition | null {
  try {
    return resolveBucket(token, buckets);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('Ambiguous bucket')) throw err;
    return null;
  }
}

function scoreCard(card: SearchCard, query: string, buckets: BucketDefinition[]): number {
  const normalized = fold(query);
  if (!normalized) return 0;
  const aliases = card.aliases.map(fold);
  const tags = card.tags.map(fold);
  const bucketLabels = card.buckets.flatMap((id) => {
    const bucket = buckets.find((item) => item.id === id);
    return bucket ? bucketKeys(bucket) : [];
  });
  let score = 0;
  if (fold(card.id) === normalized) score += 100;
  if (fold(card.id).includes(normalized)) score += 50;
  if (fold(card.host) === normalized) score += 40;
  if (fold(card.host).includes(normalized)) score += 20;
  if (fold(card.name).includes(normalized)) score += 15;
  if (aliases.some((alias) => alias === normalized)) score += 30;
  if (aliases.some((alias) => alias.includes(normalized))) score += 15;
  if (fold(card.user).includes(normalized)) score += 10;
  if (fold(card.note).includes(normalized)) score += 8;
  if (tags.some((tag) => tag.includes(normalized))) score += 12;
  if (bucketLabels.some((label) => label.includes(normalized))) score += 12;
  return score;
}

function byActiveThenName(a: SearchCard, b: SearchCard): number {
  if (a.active !== b.active) return a.active ? -1 : 1;
  return a.name.localeCompare(b.name, 'zh');
}

function sliceMatches(matches: SearchCard[], limit: number): Pick<CatalogSearchResult, 'matches' | 'total' | 'truncated'> {
  return {
    total: matches.length,
    truncated: matches.length > limit,
    matches: matches.slice(0, limit),
  };
}

export function searchCatalog(
  profiles: CatalogProfile[],
  buckets: BucketDefinition[],
  input: CatalogSearchInput,
): CatalogSearchResult {
  const query = input.query?.trim() ?? '';
  const bucketToken = input.bucket?.trim() ?? '';
  if (!query && !bucketToken) {
    throw new Error('bucket or query is required; refusing to return every profile');
  }

  const cards = profiles.map((profile) => toSearchCard(profile, buckets));

  if (bucketToken) {
    const resolved = tryResolveBucket(bucketToken, buckets);
    let members: SearchCard[];
    let bucket: { id: string; name: string } | null = null;
    let tag: string | null = null;
    let limit = input.limit ?? BUCKET_LIMIT;
    if (resolved) {
      bucket = { id: resolved.id, name: resolved.name };
      members = cards.filter((card) => card.buckets.includes(resolved.id));
    } else if (fold(bucketToken) === 'unbucketed' || bucketToken === '未分桶') {
      bucket = { id: 'unbucketed', name: '未分桶' };
      members = cards.filter((card) => card.buckets.length === 0);
      limit = input.limit ?? TAG_LIMIT;
    } else {
      tag = bucketToken;
      const needle = fold(bucketToken);
      members = cards.filter((card) => card.tags.some((item) => fold(item) === needle));
      limit = input.limit ?? TAG_LIMIT;
    }

    const filtered = query
      ? members
        .map((card) => ({ card, score: scoreCard(card, query, buckets) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || byActiveThenName(a.card, b.card))
        .map((item) => item.card)
      : [...members].sort(byActiveThenName);
    return {
      query,
      bucket,
      tag,
      ...sliceMatches(filtered, limit),
    };
  }

  const exactBuckets = matchBuckets(query, buckets).filter((hit) => hit.kind === 'exact');
  if (exactBuckets.length > 1) {
    throw new Error(`Ambiguous bucket "${query}": ${exactBuckets.map((hit) => hit.bucket.id).join(', ')}`);
  }
  if (exactBuckets.length === 1) {
    const resolved = exactBuckets[0].bucket;
    const members = cards
      .filter((card) => card.buckets.includes(resolved.id))
      .sort(byActiveThenName);
    return {
      query,
      bucket: { id: resolved.id, name: resolved.name },
      tag: null,
      ...sliceMatches(members, input.limit ?? BUCKET_LIMIT),
    };
  }

  const scored = cards
    .map((card) => ({ card, score: scoreCard(card, query, buckets) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || byActiveThenName(a.card, b.card))
    .map((item) => item.card);
  return {
    query,
    bucket: null,
    tag: null,
    ...sliceMatches(scored, input.limit ?? KEYWORD_LIMIT),
  };
}
