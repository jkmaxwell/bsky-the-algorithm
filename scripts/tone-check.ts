/**
 * Sanity-check the tone classifier against a viewer's real current top
 * candidates (hydrates text from the public API, since we don't store it).
 * Usage: npx tsx scripts/tone-check.ts <did-or-handle> [count]
 */
import { IdResolver, MemoryCache } from '@atproto/identity'
import { openDb } from '../src/db.js'
import { Ingestor } from '../src/ingest.js'
import { ViewerStore } from '../src/viewer.js'
import { FeedAlgo } from '../src/feed.js'
import { hydratePosts } from '../src/appview.js'
import { scoreTone } from '../src/tone.js'

const arg = process.argv[2]
if (!arg) {
  console.error('usage: npx tsx scripts/tone-check.ts <did-or-handle> [count]')
  process.exit(1)
}
const count = Number(process.argv[3] ?? 30)

const idResolver = new IdResolver({ didCache: new MemoryCache() })
const did = arg.startsWith('did:') ? arg : await idResolver.handle.resolve(arg).then((d) => {
  if (!d) throw new Error(`could not resolve handle ${arg}`)
  return d
})

const db = openDb()
const ingestor = new Ingestor(db)
const viewers = new ViewerStore(db, idResolver, ingestor)
viewers.loadRelevantFromDb()
const algo = new FeedAlgo(db, viewers)

const viewer = await viewers.getViewer(did)
const top = algo.scoreCandidates(viewer, Date.now()).slice(0, count)
const hyd = await hydratePosts(top.map((c) => c.uri))

const label = (t: number) => (t <= -2 ? 'RAGE ' : t === -1 ? 'POLI ' : t >= 1 ? 'FUN  ' : '     ')
for (const c of top) {
  const p = hyd.get(c.uri)
  if (!p) continue
  const t = scoreTone(p.text)
  console.log(`${label(t)} (${p.likes}♥) @${p.handle}: ${p.text.slice(0, 80)}`)
}
db.close()
