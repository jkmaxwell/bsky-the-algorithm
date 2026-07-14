# Tuning log

Weekly eval results and weight changes. The Monday tuning session appends here;
a knob suggestion should generally appear in two different weeks before acting.

## Watchlist (from foryou.club research, 2026-07-04)

foryou.club (top feed on Bluesky, pure like-based collaborative filtering — see
https://atproto.com/blog/serving-the-for-you-feed and https://blog.foryou.club/)
A/B-tested findings relevant to us:

- **6h fixed half-life decay**: their A/B landed exactly where our decay already
  is (−36.6% "show less" feedback). Treat 6h as well-validated; require strong
  evidence before moving it.
- **Stray-like protection**: their biggest user complaint was one accidental
  like hijacking the feed. Our affinity counts likes flatly over the last ~600;
  a single stray like gives an author affinity 1.6x. Watch evals for
  interest-author or affinity noise; if it appears, weight affinity toward
  accumulated/older taste (their fix: oldest like weighs 10x the newest) or
  raise interestAuthorMinLikes.
- **Negative signals beat positive ones for tuning**: their most sensitive
  quality metric was "show less like this" rate, not likes. We have no
  impression/feedback logging yet — see future work below.

Future work (not yet built): declare `acceptsInteractions` and log
`app.bsky.feed.sendInteractions` events (impressions, show-less) to give evals
a negative signal.

## 2026-07-13 — incident: ReDoS in laughter regex froze the service

- LAUGHTER_RE contained `l(?:o+){2,}l` — variable-length group under a
  repetition. A firehose post with a stretched word ("loooo...ong") sent the
  regex into exponential backtracking; scoreTone runs on every post in the
  same event loop as HTTP, so the whole service wedged (systemd "active",
  HTTP timing out). Boot prune of 1.23M aged posts confirms ~a day wedged.
- Fixed with fixed-length atoms only; 500-char regression test added.
- LESSON for future lexicon edits: every regex in the ingest path must be
  linear-time — no variable-length groups under quantifiers. Also: /health
  should be monitored externally; systemd "active" says nothing about the
  event loop.

## 2026-07-05 — tone system added ("still a little ragey")

- Justin reported the feed still felt ragey. Diagnosis: ratio guard catches
  dunks, but "agreement rage" (outrage with thousands of likes, e.g. political
  fury posts) rides like-based ranking untouched.
- Added src/tone.ts (lexicon classifier at ingest): fun +1 (×1.2), politics -1
  (×0.5), rage -2 (×0.2); discovery excludes tone < 0. Calibrated against
  Justin's real candidates: caps-excitement stays neutral, dunk-contempt
  language ("dumbest man on earth", "garbage trash") dampened.
- Tone only applies to posts ingested after deploy; full effect within 48h as
  the window turns over.
- WATCH: eval now diagnoses "tone-damped" misses. If ≥3 liked posts get
  tone-damped in a week, soften tonePoliticsDamp (0.5 → 0.7) — Justin may like
  some charged content. Also watch whether the feed feels *too* filtered
  (missing important news entirely).

## 2026-07-04 — baseline (pre-scheduled-tuning)

- Index too young for meaningful recall numbers (37/59 likes predated index).
- Discovery evidence: 6/7 out-of-network likes had 1–2 network likers →
  burstMinLikers lowered 3→2 (affinity-weighted) as part of the freshness
  overhaul, alongside seen-post memory, 2-per-author cap, interest-author lane,
  out-of-network cap 5/15.
