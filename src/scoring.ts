/**
 * Ranking weights modeled on mid-2010s Twitter:
 *
 * - Engagement weights (like=30, repost=20, reply=1) mirror the open-sourced
 *   legacy "Earlybird" light ranker. Replies are deliberately near-worthless:
 *   the 2019+ ranker that made a reply worth 13.5-27x a like is what produced
 *   dunk/argument culture, and we invert that on purpose.
 * - Engagement is normalized by the author's typical engagement (documented
 *   2016 signal), so a small account's great post outranks a celebrity's
 *   average one.
 * - Affinity (how often the viewer likes this author) multiplies everything:
 *   friends first.
 * - The ratio guard suppresses posts whose replies dwarf their likes — the
 *   signature of a pile-on or engagement bait.
 */
export const WEIGHTS = {
  like: 30,
  repost: 20,
  reply: 1,

  mediaBoost: 1.15,
  threadRootBoost: 1.25,

  // Tone multipliers (see src/tone.ts). The ratio guard catches dunks;
  // these catch "agreement rage" — outrage that gets liked, not ratio'd.
  toneFunBoost: 1.2,
  tonePoliticsDamp: 0.5,
  toneRageDamp: 0.2,

  ratioMinReplies: 10,
  ratioReplyToLike: 2,
  ratioPenalty: 0.15,

  decayHalfLifeHours: 6,
  candidateWindowHours: 48,

  authorNormSmoothing: 5,

  affinityLikeWeight: 0.6,
  affinityCap: 4,

  burstMinLikers: 2,
  burstWindowHours: 6,

  rankedBlockSize: 15,
  maxBurstsInBlock: 3,
  maxOutOfNetworkInBlock: 5,
  maxPerAuthorInBlock: 2,

  // Out-of-network authors the viewer has liked at least this many times
  // become ranking candidates ("posts from your interests, people you
  // haven't met").
  interestAuthorMinLikes: 2,

  // "While you were away": the ranked block never repeats a post the viewer
  // was already shown, except within a short grace window so an immediate
  // pull-to-refresh stays stable.
  seenExcludeHours: 48,
  seenGraceMinutes: 10,
} as const

export interface PostSignals {
  likes: number
  reposts: number
  replies: number
  hasMedia: boolean
  isThreadRoot: boolean
  ageHours: number
  authorAvgEngagement: number
  viewerLikesOfAuthor: number
  /** -2 rage, -1 political/news-charged, 0 neutral, +1 fun (src/tone.ts) */
  tone: number
}

export function toneMultiplier(tone: number): number {
  if (tone <= -2) return WEIGHTS.toneRageDamp
  if (tone === -1) return WEIGHTS.tonePoliticsDamp
  if (tone >= 1) return WEIGHTS.toneFunBoost
  return 1
}

export function engagementRaw(likes: number, reposts: number, replies: number): number {
  return WEIGHTS.like * likes + WEIGHTS.repost * reposts + WEIGHTS.reply * replies
}

export function timeDecay(ageHours: number): number {
  return Math.pow(0.5, Math.max(0, ageHours) / WEIGHTS.decayHalfLifeHours)
}

export function affinity(viewerLikesOfAuthor: number): number {
  const a = 1 + WEIGHTS.affinityLikeWeight * Math.log2(1 + Math.max(0, viewerLikesOfAuthor))
  return Math.min(a, WEIGHTS.affinityCap)
}

export function ratioGuard(likes: number, replies: number): number {
  if (replies >= WEIGHTS.ratioMinReplies && replies > WEIGHTS.ratioReplyToLike * likes) {
    return WEIGHTS.ratioPenalty
  }
  return 1
}

export function scorePost(s: PostSignals): number {
  const raw = engagementRaw(s.likes, s.reposts, s.replies)
  const normalized = raw / (s.authorAvgEngagement + WEIGHTS.authorNormSmoothing)
  let score = affinity(s.viewerLikesOfAuthor) * (1 + normalized)
  if (s.hasMedia) score *= WEIGHTS.mediaBoost
  if (s.isThreadRoot) score *= WEIGHTS.threadRootBoost
  score *= toneMultiplier(s.tone)
  score *= ratioGuard(s.likes, s.replies)
  score *= timeDecay(s.ageHours)
  return score
}

/**
 * MagicRecs-style burst score for out-of-network injections: driven purely by
 * how much of the viewer's network converged on the post, decayed like
 * everything else. Global popularity is irrelevant by construction.
 *
 * `weightedLikers` is the sum of affinity(viewer, liker) over distinct likers
 * the viewer follows — two likes from accounts the viewer loves outweigh
 * three from accounts they barely notice.
 */
export function burstScore(weightedLikers: number, ageHours: number): number {
  return Math.log2(1 + weightedLikers) * timeDecay(ageHours)
}
