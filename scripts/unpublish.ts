/**
 * Remove a published feed generator record from your account.
 * Usage: BLUESKY_HANDLE=... BLUESKY_APP_PASSWORD=... npx tsx scripts/unpublish.ts <rkey>
 */
import { AtpAgent } from '@atproto/api'

const rkey = process.argv[2]
const handle = process.env.BLUESKY_HANDLE
const password = process.env.BLUESKY_APP_PASSWORD

if (!rkey || !handle || !password) {
  console.error('usage: BLUESKY_HANDLE=... BLUESKY_APP_PASSWORD=... npx tsx scripts/unpublish.ts <rkey>')
  process.exit(1)
}

const agent = new AtpAgent({ service: 'https://bsky.social' })
await agent.login({ identifier: handle, password })

await agent.com.atproto.repo.deleteRecord({
  repo: agent.session!.did,
  collection: 'app.bsky.feed.generator',
  rkey,
})

console.log(`Deleted feed record "${rkey}". It will disappear from your profile shortly.`)
