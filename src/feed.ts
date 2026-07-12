import type { Db } from './db.js'
import type { ViewerStore, ViewerState } from './viewer.js'
import { WEIGHTS, scorePost, burstScore, engagementRaw, affinity, type PostSignals } from './scoring.js'

export interface ScoredCandidate {
  uri: string
  author: string
  createdAt: number
  score: number
  signals: PostSignals
  /** false = interest-author candidate (viewer likes them but doesn't follow) */
  inNetwork: boolean
}

/**
 * Pick ranked-block posts from the scored list under the block's constraints:
 * never repeat a seen post, at most maxPerAuthorInBlock per author, and at
 * most maxOutOfNetwork interest-author posts (friends first). Pure; exported
 * for tests.
 */
export function selectRankedPosts(
  scored: ScoredCandidate[],
  seen: Set<string>,
  slots: number,
  maxOutOfNetwork: number,
): ScoredCandidate[] {
  const perAuthor = new Map<string, number>()
  const picked: ScoredCandidate[] = []
  let outOfNetwork = 0
  for (const c of scored) {
    if (picked.length >= slots) break
    if (seen.has(c.uri)) continue
    if ((perAuthor.get(c.author) ?? 0) >= WEIGHTS.maxPerAuthorInBlock) continue
    if (!c.inNetwork && outOfNetwork >= maxOutOfNetwork) continue
    picked.push(c)
    perAuthor.set(c.author, (perAuthor.get(c.author) ?? 0) + 1)
    if (!c.inNetwork) outOfNetwork++
  }
  return picked
}

export interface SkeletonItem {
  post: string
  reason?: { $type: 'app.bsky.feed.defs#skeletonReasonRepost'; repost: string }
}

export interface Skeleton {
  feed: SkeletonItem[]
  cursor?: string
}

interface PostRow {
  uri: string
  author: string
  created_at: number
  is_reply: number
  has_media: number
  has_self_reply: number
  like_count: number
  repost_count: number
  reply_count: number
  tone: number
}

interface ChronRow {
  item_uri: string
  post_uri: string
  repost_uri: string | null
  created_at: number
}

function encodeCursor(ts: number, uri: string): string {
  return Buffer.from(`${ts}::${uri}`).toString('base64url')
}

function decodeCursor(cursor: string): { ts: number; uri: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString()
    const idx = raw.indexOf('::')
    if (idx < 0) return null
    const ts = Number(raw.slice(0, idx))
    if (!Number.isFinite(ts)) return null
    return { ts, uri: raw.slice(idx + 2) }
  } catch {
    return null
  }
}

/**
 * The timeline shape is the era's defining UX: a bounded ranked "while you
 * were away" block at the top of page 1, then plain reverse-chronological
 * posts (including follows' reposts) below and on every subsequent page.
 */
export class FeedAlgo {
  // URIs shown in a viewer's most recent ranked block, so chronological pages
  // don't repeat them. Single-process memory is fine at this scale.
  private shownRanked = new Map<string, { uris: Set<string>; expires: number }>()

  constructor(
    private db: Db,
    private viewers: ViewerStore,
  ) {}

  async getSkeleton(
    viewerDid: string | null,
    limit: number,
    cursor?: string,
    opts: { recordSeen?: boolean } = {},
  ): Promise<Skeleton> {
    limit = Math.max(1, Math.min(limit || 50, 100))

    if (!viewerDid) return this.genericFeed(limit, cursor)

    const viewer = await this.viewers.getViewer(viewerDid)
    if (viewer.followsArr.length === 0) return this.genericFeed(limit, cursor)

    if (cursor) {
      const c = decodeCursor(cursor)
      if (!c) return { feed: [] }
      return this.chronPage(viewer, limit, c)
    }

    return this.firstPage(viewer, limit, opts.recordSeen ?? true)
  }

  private firstPage(viewer: ViewerState, limit: number, recordSeen: boolean): Skeleton {
    const now = Date.now()
    const ranked = this.rankedBlock(viewer, now, recordSeen)

    const shown = new Set(ranked.map((i) => i.post))
    this.shownRanked.set(viewer.did, { uris: shown, expires: now + 3600_000 })
    this.gcShownRanked(now)

    const feed: SkeletonItem[] = [...ranked]
    let pageCursor: string | undefined
    if (feed.length < limit) {
      const chron = this.chronItems(viewer, limit - feed.length, { ts: now, uri: '' }, shown)
      feed.push(...chron.items)
      pageCursor = chron.cursor
    } else {
      pageCursor = encodeCursor(now, '')
    }
    return { feed, cursor: pageCursor }
  }

  private chronPage(viewer: ViewerState, limit: number, c: { ts: number; uri: string }): Skeleton {
    const shown = this.shownRanked.get(viewer.did)
    const exclude = shown && shown.expires > Date.now() ? shown.uris : new Set<string>()
    const { items, cursor } = this.chronItems(viewer, limit, c, exclude)
    return { feed: items, cursor }
  }

  /**
   * Score every in-network candidate exactly as the live ranker does.
   * Public so offline evaluation (scripts/eval.ts) measures the real thing.
   */
  scoreCandidates(viewer: ViewerState, now: number): ScoredCandidate[] {
    const since = now - WEIGHTS.candidateWindowHours * 3600_000
    const authorsJson = JSON.stringify([...viewer.followsArr, ...viewer.interestAuthors])

    const candidates = this.db
      .prepare(
        `SELECT uri, author, created_at, is_reply, has_media, has_self_reply,
                like_count, repost_count, reply_count, tone
         FROM post
         WHERE author IN (SELECT value FROM json_each(?))
           AND is_reply = 0
           AND created_at > ?
         ORDER BY created_at DESC
         LIMIT 4000`,
      )
      .all(authorsJson, since) as PostRow[]

    const baselines = this.db
      .prepare(
        `SELECT author, AVG(like_count * ${WEIGHTS.like} + repost_count * ${WEIGHTS.repost} + reply_count * ${WEIGHTS.reply}) AS avg_eng
         FROM post
         WHERE author IN (SELECT value FROM json_each(?)) AND created_at > ?
         GROUP BY author`,
      )
      .all(authorsJson, since) as { author: string; avg_eng: number }[]
    const baselineMap = new Map(baselines.map((b) => [b.author, b.avg_eng]))

    return candidates
      .map((p) => {
        const signals: PostSignals = {
          likes: p.like_count,
          reposts: p.repost_count,
          replies: p.reply_count,
          hasMedia: p.has_media === 1,
          isThreadRoot: p.has_self_reply === 1,
          ageHours: (now - p.created_at) / 3600_000,
          authorAvgEngagement: baselineMap.get(p.author) ?? 0,
          viewerLikesOfAuthor: viewer.affinity[p.author] ?? 0,
          tone: p.tone,
        }
        return {
          uri: p.uri,
          author: p.author,
          createdAt: p.created_at,
          score: scorePost(signals),
          signals,
          inNetwork: viewer.follows.has(p.author),
        }
      })
      .sort((a, b) => b.score - a.score)
  }

  private getSeen(viewerDid: string, now: number): Set<string> {
    const rows = this.db
      .prepare('SELECT uri FROM seen WHERE viewer = ? AND seen_at BETWEEN ? AND ?')
      .all(viewerDid, now - WEIGHTS.seenExcludeHours * 3600_000, now - WEIGHTS.seenGraceMinutes * 60_000) as {
      uri: string
    }[]
    return new Set(rows.map((r) => r.uri))
  }

  private markSeen(viewerDid: string, uris: string[], now: number): void {
    const stmt = this.db.prepare('INSERT OR IGNORE INTO seen (viewer, uri, seen_at) VALUES (?, ?, ?)')
    for (const uri of uris) stmt.run(viewerDid, uri, now)
  }

  /** Top-of-page-1 ranked highlights: in-network scored posts + MagicRecs bursts. */
  private rankedBlock(viewer: ViewerState, now: number, recordSeen: boolean): SkeletonItem[] {
    const seen = this.getSeen(viewer.did, now)
    const scored = this.scoreCandidates(viewer, now)

    const bursts = this.magicRecs(viewer, now, seen)
    const inNetworkSlots = WEIGHTS.rankedBlockSize - bursts.length
    const picked = selectRankedPosts(scored, seen, inNetworkSlots, WEIGHTS.maxOutOfNetworkInBlock - bursts.length)
    const block: SkeletonItem[] = picked.map((s) => ({ post: s.uri }))

    // Interleave discoveries into the block rather than clumping them
    const positions = [3, 8, 13]
    bursts.forEach((uri, i) => {
      const pos = Math.min(positions[i] ?? block.length, block.length)
      block.splice(pos, 0, { post: uri })
    })
    const final = block.slice(0, WEIGHTS.rankedBlockSize)
    if (recordSeen) this.markSeen(viewer.did, final.map((i) => i.post), now)
    return final
  }

  /**
   * MagicRecs: out-of-network posts that >= burstMinLikers of the viewer's
   * follows liked within the burst window. Network coincidence, not global
   * trending.
   */
  private magicRecs(viewer: ViewerState, now: number, seen: Set<string>): string[] {
    const since = now - WEIGHTS.burstWindowHours * 3600_000
    const rows = this.db
      .prepare(
        `SELECT l.subject_uri AS uri, l.subject_author AS author,
                GROUP_CONCAT(DISTINCT l.liker) AS likers, MIN(l.created_at) AS first_like
         FROM network_like l
         WHERE l.liker IN (SELECT value FROM json_each(?))
           AND l.created_at > ?
         GROUP BY l.subject_uri
         HAVING COUNT(DISTINCT l.liker) >= ?
         ORDER BY COUNT(DISTINCT l.liker) DESC
         LIMIT 200`,
      )
      .all(JSON.stringify(viewer.followsArr), since, WEIGHTS.burstMinLikers) as {
      uri: string
      author: string
      likers: string
      first_like: number
    }[]

    const getPost = this.db.prepare('SELECT is_reply, like_count, reply_count, tone FROM post WHERE uri = ?')
    const picks: { uri: string; score: number }[] = []
    for (const r of rows) {
      if (viewer.follows.has(r.author) || r.author === viewer.did || seen.has(r.uri)) continue
      const post = getPost.get(r.uri) as
        | { is_reply: number; like_count: number; reply_count: number; tone: number }
        | undefined
      if (!post || post.is_reply === 1) continue
      // Don't "discover" a pile-on or a rage post for the viewer — the
      // discovery lane is strictly for delight
      if (post.reply_count >= WEIGHTS.ratioMinReplies && post.reply_count > WEIGHTS.ratioReplyToLike * post.like_count) continue
      if (post.tone < 0) continue
      // Weight each liker by how much the viewer likes *them*
      const weighted = r.likers
        .split(',')
        .reduce((sum, liker) => sum + affinity(viewer.affinity[liker] ?? 0), 0)
      picks.push({ uri: r.uri, score: burstScore(weighted, (now - r.first_like) / 3600_000) })
    }
    return picks
      .sort((a, b) => b.score - a.score)
      .slice(0, WEIGHTS.maxBurstsInBlock)
      .map((p) => p.uri)
  }

  /** Reverse-chronological follows' posts + follows' reposts. */
  private chronItems(
    viewer: ViewerState,
    limit: number,
    c: { ts: number; uri: string },
    exclude: Set<string>,
  ): { items: SkeletonItem[]; cursor?: string } {
    const followsJson = JSON.stringify(viewer.followsArr)
    // Fetch extra rows to survive exclusions, then trim
    const rows = this.db
      .prepare(
        `SELECT uri AS item_uri, uri AS post_uri, NULL AS repost_uri, created_at
         FROM post
         WHERE author IN (SELECT value FROM json_each(:follows))
           AND is_reply = 0
           AND (created_at < :ts OR (created_at = :ts AND uri < :uri))
         UNION ALL
         SELECT r.uri AS item_uri, r.subject_uri AS post_uri, r.uri AS repost_uri, r.created_at
         FROM network_repost r
         WHERE r.reposter IN (SELECT value FROM json_each(:follows))
           AND (r.created_at < :ts OR (r.created_at = :ts AND r.uri < :uri))
         ORDER BY created_at DESC, item_uri DESC
         LIMIT :lim`,
      )
      .all({ follows: followsJson, ts: c.ts, uri: c.uri || '￿', lim: limit + exclude.size + 10 }) as ChronRow[]

    const items: SkeletonItem[] = []
    let last: ChronRow | undefined
    const seenPosts = new Set<string>()
    for (const row of rows) {
      if (items.length >= limit) break
      last = row
      if (exclude.has(row.post_uri) || seenPosts.has(row.post_uri)) continue
      seenPosts.add(row.post_uri)
      items.push(
        row.repost_uri
          ? { post: row.post_uri, reason: { $type: 'app.bsky.feed.defs#skeletonReasonRepost', repost: row.repost_uri } }
          : { post: row.post_uri },
      )
    }
    const cursor = last && rows.length > 0 ? encodeCursor(last.created_at, last.item_uri) : undefined
    return { items, cursor }
  }

  /** Fallback for logged-out preview / viewers who follow nobody. */
  private genericFeed(limit: number, cursor?: string): Skeleton {
    const now = Date.now()
    const since = now - 24 * 3600_000
    const offset = cursor ? Number(Buffer.from(cursor, 'base64url').toString()) || 0 : 0
    const rows = this.db
      .prepare(
        `SELECT uri, like_count, repost_count, reply_count, created_at
         FROM post
         WHERE is_reply = 0 AND created_at > ? AND like_count >= 5
         ORDER BY created_at DESC
         LIMIT 2000`,
      )
      .all(since) as PostRow[]
    const scored = rows
      .map((p) => ({
        uri: p.uri,
        score:
          (engagementRaw(p.like_count, p.repost_count, p.reply_count) *
            (p.reply_count >= WEIGHTS.ratioMinReplies && p.reply_count > WEIGHTS.ratioReplyToLike * p.like_count
              ? WEIGHTS.ratioPenalty
              : 1)) *
          Math.pow(0.5, (now - p.created_at) / 3600_000 / WEIGHTS.decayHalfLifeHours),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(offset, offset + limit)
    return {
      feed: scored.map((s) => ({ post: s.uri })),
      cursor: scored.length === limit ? Buffer.from(String(offset + limit)).toString('base64url') : undefined,
    }
  }

  private gcShownRanked(now: number): void {
    for (const [did, entry] of this.shownRanked) {
      if (entry.expires < now) this.shownRanked.delete(did)
    }
  }
}
