/**
 * Mine the network's actual "fun" vocabulary: hydrate the most-liked,
 * reply-light posts from a viewer's follows (the empirically fun/positive
 * cluster) plus the viewer's own recent likes, and report term frequencies
 * so the tone lexicon can be grounded in the corpus instead of vibes.
 * Usage: npx tsx scripts/mine-fun.ts <did-or-handle>
 */
import { IdResolver, MemoryCache } from '@atproto/identity'
import { openDb } from '../src/db.js'
import { Ingestor } from '../src/ingest.js'
import { ViewerStore } from '../src/viewer.js'
import { hydratePosts } from '../src/appview.js'

const arg = process.argv[2]
if (!arg) {
  console.error('usage: npx tsx scripts/mine-fun.ts <did-or-handle>')
  process.exit(1)
}

const idResolver = new IdResolver({ didCache: new MemoryCache() })
const did = arg.startsWith('did:') ? arg : await idResolver.handle.resolve(arg).then((d) => {
  if (!d) throw new Error(`could not resolve ${arg}`)
  return d
})

const db = openDb()
const ingestor = new Ingestor(db)
const viewers = new ViewerStore(db, idResolver, ingestor)
const viewer = await viewers.getViewer(did)

// Fun cluster: well-liked, conversation-light posts from follows
const rows = db
  .prepare(
    `SELECT uri FROM post
     WHERE author IN (SELECT value FROM json_each(?))
       AND is_reply = 0 AND like_count >= 15 AND reply_count * 3 < like_count
     ORDER BY like_count DESC LIMIT 400`,
  )
  .all(JSON.stringify(viewer.followsArr)) as { uri: string }[]

const hyd = await hydratePosts(rows.map((r) => r.uri))
const texts = [...hyd.values()].map((p) => p.text).filter((t) => t.length > 0)
console.log(`corpus: ${texts.length} well-liked, reply-light posts from follows\n`)

// Unigrams + bigrams, minus boring stopwords
const STOP = new Set(
  'the a an and or but of to in on for with at by from is are was were be been being it its this that these those i you he she they we my your his her their our me him them us as if so not no do does did done just too very can will would should could about into over after before out up down off own same than then there here when what who whom which why how all any both each few more most other some such only very s t don now get got one two like'.split(' '),
)
const counts = new Map<string, number>()
for (const text of texts) {
  const tokens = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .split(/[^a-z0-9'’]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
  const seen = new Set<string>()
  for (let i = 0; i < tokens.length; i++) {
    for (const term of [tokens[i], i + 1 < tokens.length ? `${tokens[i]} ${tokens[i + 1]}` : '']) {
      if (term && !seen.has(term)) {
        seen.add(term)
        counts.set(term, (counts.get(term) ?? 0) + 1)
      }
    }
  }
  // emoji
  for (const m of text.match(/\p{Extended_Pictographic}/gu) ?? []) {
    const key = `EMOJI ${m}`
    if (!seen.has(key)) {
      seen.add(key)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
}

const top = [...counts.entries()].filter(([, n]) => n >= 4).sort((a, b) => b[1] - a[1])
console.log('recurring terms (in >= 4 distinct posts):')
for (const [term, n] of top.slice(0, 80)) console.log(`  ${String(n).padStart(3)}  ${term}`)

console.log('\n--- sample of the corpus (first 25) ---')
for (const t of texts.slice(0, 25)) console.log(`  • ${t.slice(0, 90)}`)
db.close()
