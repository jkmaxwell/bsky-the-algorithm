/**
 * Dev preview: run the full personalized pipeline for a given DID/handle
 * against the local index, bypassing JWT auth (which only the AppView can
 * exercise). Usage: npx tsx scripts/preview.ts <did-or-handle> [limit]
 */
import { IdResolver, MemoryCache } from '@atproto/identity'
import { openDb } from '../src/db.js'
import { Ingestor } from '../src/ingest.js'
import { ViewerStore } from '../src/viewer.js'
import { FeedAlgo } from '../src/feed.js'

const arg = process.argv[2]
if (!arg) {
  console.error('usage: npx tsx scripts/preview.ts <did-or-handle> [limit]')
  process.exit(1)
}
const limit = Number(process.argv[3] ?? 30)

const idResolver = new IdResolver({ didCache: new MemoryCache() })
const did = arg.startsWith('did:') ? arg : await idResolver.handle.resolve(arg).then((d) => {
  if (!d) throw new Error(`could not resolve handle ${arg}`)
  return d
})
console.log(`viewer: ${arg} -> ${did}`)

const db = openDb()
const ingestor = new Ingestor(db)
const viewers = new ViewerStore(db, idResolver, ingestor)
viewers.loadRelevantFromDb()
const algo = new FeedAlgo(db, viewers)

// Diagnostics before ranking, so an empty feed explains itself
const state = await viewers.getViewer(did)
const totalPosts = (db.prepare('SELECT count(*) AS n FROM post').get() as { n: number }).n
const byFollows = (
  db
    .prepare(
      `SELECT count(*) AS n FROM post
       WHERE author IN (SELECT value FROM json_each(?)) AND is_reply = 0`,
    )
    .get(JSON.stringify(state.followsArr)) as { n: number }
).n
console.log(`index: ${totalPosts} posts total; viewer follows ${state.followsArr.length} accounts, ${byFollows} of their posts indexed`)
if (state.followsArr.length < 5) {
  console.warn(`⚠ this account follows almost nobody — did you mean to preview a different handle?`)
}
if (totalPosts < 50_000) {
  console.warn(`⚠ small index — let \`npm run dev\` ingest for 15+ minutes for a meaningful preview`)
}

console.time('page 1')
const page1 = await algo.getSkeleton(did, limit)
console.timeEnd('page 1')
console.log(`\npage 1: ${page1.feed.length} items`)
for (const item of page1.feed) {
  console.log(` ${item.reason ? 'RT' : '  '} ${item.post}`)
}

if (page1.cursor) {
  console.time('page 2')
  const page2 = await algo.getSkeleton(did, limit, page1.cursor)
  console.timeEnd('page 2')
  console.log(`\npage 2: ${page2.feed.length} items, cursor=${page2.cursor ? 'yes' : 'end'}`)
  const dupes = page2.feed.filter((i) => page1.feed.some((j) => j.post === i.post))
  console.log(`duplicates across pages: ${dupes.length}`)
}
db.close()
