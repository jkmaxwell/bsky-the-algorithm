/**
 * Lexicon-based tone scoring, computed once per post at ingest.
 *
 * The ratio guard catches dunks (replies >> likes), but it cannot catch
 * "agreement rage": outrage posts that thousands of people like angrily.
 * Like-based ranking amplifies those unless tone is a signal. This is a
 * deliberately simple, fully inspectable word-list approach — no ML, no
 * black box, tunable by editing the lists.
 *
 * Tone values:
 *   +1  fun/positive (laughter, delight, warmth)
 *    0  neutral
 *   -1  political/news-charged (dampened, not buried)
 *   -2  rage/outrage affect (strongly dampened, excluded from discovery)
 */

const RAGE = [
  'disgusting', 'disgrace', 'disgraceful', 'shameful', 'sickening', 'vile',
  'evil', 'traitor', 'treason', 'corrupt', 'corruption', 'fascist', 'fascism',
  'nazi', 'scum', 'furious', 'fury', 'enraged', 'appalling', 'despicable',
  'monstrous', 'atrocity', 'horrifying', 'complicit', 'grifter', 'liar',
  'lying', 'fraud', 'cruel', 'cruelty', 'authoritarian', 'dictator', 'regime',
  'coup', 'insurrection', 'outrage', 'outrageous', 'infuriating', 'seething',
  'how dare', 'wake up', 'unforgivable', 'shame on',
]

const POLITICS = [
  'trump', 'maga', 'gop', 'republican', 'republicans', 'democrat', 'democrats',
  'congress', 'senate', 'senator', 'scotus', 'supreme court', 'election',
  'ballot', 'white house', 'president', 'deportation', 'tariff', 'tariffs',
  'impeach', 'impeachment', 'biden', 'vance', 'legislation', 'executive order',
  'administration', 'far-right', 'far right', 'leftist', 'liberals',
]

// Slang decays — refresh this list periodically (scripts/mine-fun.ts mines
// the network's actual vocabulary; the weekly tuner watches for staleness).
// Mix of evergreen delight signals, current slang, and terms observed in
// this network's own voice (Bluesky skews tumblr-inflected: little guys,
// creatures, beloveds — not TikTok-speak).
const FUN_WORDS = [
  // evergreen
  'lol', 'lmao', 'lmfao', 'funny', 'hilarious', 'silly', 'joke', 'cute',
  'adorable', 'delightful', 'love this', 'obsessed', 'banger', 'iconic',
  'goofy', 'unhinged', 'hell yeah', 'incredible',
  // laughter idioms
  'screaming', 'crying', 'wheezing', 'sobbing', 'losing it', 'took me out',
  'sent me', "i'm dying", 'im dying',
  // current-ish
  'no notes', 'goated', 'so real', 'diabolical', 'menace', 'feral',
  'chaotic', 'gremlin', 'committed to the bit', 'the bit', 'ate that',
  'let him cook', 'let them cook', 'aura farming', 'brainrot', 'delulu',
  'crashing out', 'crash out', 'is peak', 'shitpost',
  // this network's voice
  'little guy', 'little guys', 'lil guy', 'creature', 'critter', 'critters',
  'beloved', 'eepy',
]

const FUN_EMOJI = ['😂', '🤣', '😭', '💀', '✨', '🎉', '🥰', '😍', '🥹', '🫠', '🫶', '😹', '🐱', '🐶', '🦆', '🧡', '💖']

// Everyday contempt/dunk language: not full outrage, but not fun either.
// One point each vs two for RAGE terms.
const CONTEMPT = [
  'dumbest', 'idiot', 'idiots', 'moron', 'morons', 'clown', 'clowns',
  'garbage', 'trash', 'pathetic', 'gross', 'embarrassing', 'worst',
  'piece of shit', 'pos', 'scumbag', 'loser', 'losers', 'ghoul', 'ghouls',
  'villain', 'villains', 'death threats', 'sucks',
]

const ALARM_EMOJI = ['🚨', '‼️', '⚠️']

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Word-boundary matching, precompiled: substring matching is a trap
// ('maga' is inside 'damage', 'gop' is inside 'gopher', 'pos' inside 'post').
function compile(terms: string[]): RegExp {
  return new RegExp(`\\b(?:${terms.map(escapeRegex).join('|')})\\b`, 'g')
}

const RAGE_RE = compile(RAGE)
const CONTEMPT_RE = compile(CONTEMPT)
const POLITICS_RE = compile(POLITICS)
const FUN_RE = compile(FUN_WORDS)

// Laughter comes in shapes word boundaries can't see: ahahahaha, loool,
// lolol, lmaooo. IMPORTANT: only fixed-length atoms may sit under a
// repetition here — a variable-length group like (?:o+){2,} backtracks
// exponentially on strings like "loooo...ong" and froze the event loop in
// production (2026-07-13). scoreTone runs on every post on the firehose;
// its regexes must be linear-time.
const LAUGHTER_RE = /(?:ha){3,}|lo{2,}l|(?:lo){2,}l|lma+o+/i

function countMatches(text: string, re: RegExp): number {
  return text.match(re)?.length ?? 0
}

function countEmoji(text: string, emoji: string[]): number {
  let n = 0
  for (const e of emoji) {
    if (text.includes(e)) n++
  }
  return n
}

function capsRatio(original: string): number {
  const letters = original.replace(/[^a-zA-Z]/g, '')
  if (letters.length < 20) return 0
  const caps = original.replace(/[^A-Z]/g, '')
  return caps.length / letters.length
}

export function scoreTone(text: string): number {
  if (!text) return 0
  const lower = text.toLowerCase()

  let points = 2 * countMatches(lower, RAGE_RE) + countMatches(lower, CONTEMPT_RE)
  points += countEmoji(text, ALARM_EMOJI)
  if (lower.includes('breaking:') || text.includes('BREAKING')) points++
  // ALL CAPS amplifies anger but never triggers alone — caps is also how
  // people shout about horseshoe crabs, and that's joy
  if (points >= 1 && capsRatio(text) > 0.3) points++

  const fun = countMatches(lower, FUN_RE) + countEmoji(text, FUN_EMOJI) + (LAUGHTER_RE.test(text) ? 1 : 0)

  if (points >= 4) return -2
  if (points >= 1) return -1
  if (countMatches(lower, POLITICS_RE) >= 1) return -1
  if (fun >= 1) return 1
  return 0
}
