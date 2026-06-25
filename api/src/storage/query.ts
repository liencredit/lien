import type { ListScoresParams, Page, ScoreRecord } from "./types.js";

const STATUS_RANK: Record<ScoreRecord["status"], number> = {
  defaulted: 0,
  on_watch: 1,
  good_standing: 2,
};

function tieBreak(a: ScoreRecord, b: ScoreRecord): number {
  return a.agentId.localeCompare(b.agentId);
}

/** Deterministic ordering shared by every Store backend. */
export function compareScores(a: ScoreRecord, b: ScoreRecord, sort: ListScoresParams["sort"]): number {
  switch (sort) {
    case "volume": {
      // Proxy volume by the recommended limit amount (scales with volume).
      const av = a.limit?.amount ?? 0;
      const bv = b.limit?.amount ?? 0;
      return bv - av || tieBreak(a, b);
    }
    case "recent":
      return b.updatedAt.localeCompare(a.updatedAt) || tieBreak(a, b);
    case "score":
    default:
      return b.score - a.score || STATUS_RANK[b.status] - STATUS_RANK[a.status] || tieBreak(a, b);
  }
}

export function clampLimit(n: number | undefined, fallback = 25): number {
  if (n === undefined || !Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(1, Math.trunc(n)));
}

/**
 * Filter → sort → cursor-paginate a set of scores. Backends fetch the candidate
 * rows however they like, then defer to this for identical semantics.
 */
export function sortAndPaginate(rows: ScoreRecord[], params: ListScoresParams): Page<ScoreRecord> {
  const limit = clampLimit(params.limit);
  let filtered = params.status ? rows.filter((r) => r.status === params.status) : rows.slice();

  filtered.sort((a, b) => compareScores(a, b, params.sort ?? "score"));

  let start = 0;
  if (params.startingAfter) {
    const idx = filtered.findIndex((r) => r.agentId === params.startingAfter);
    start = idx >= 0 ? idx + 1 : 0;
  }

  const slice = filtered.slice(start, start + limit);
  const hasMore = start + limit < filtered.length;
  const last = slice.at(-1);

  return { data: slice, hasMore, nextCursor: hasMore && last ? last.agentId : null };
}
