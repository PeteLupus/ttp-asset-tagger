#!/usr/bin/env node
// scripts/dedup.js — perceptual hash dedup pass. Read-only. Writes data/dedup_report.json.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { google } = require('googleapis')
const sharp      = require('sharp')
const fs         = require('fs')
const path       = require('path')
const http       = require('http')
const { execSync } = require('child_process')

const ROOT_DIR    = path.join(__dirname, '..')
const CRED_PATH   = process.env.GOOGLE_OAUTH_CLIENT_PATH || path.join(ROOT_DIR, 'data', 'credentials.json')
const TOKEN_PATH  = path.join(ROOT_DIR, 'data', 'token.json')
const REPORT_PATH = path.join(ROOT_DIR, 'data', 'dedup_report.json')
const SOURCE_ID   = process.env.GOOGLE_SOURCE_FOLDER_ID
const OAUTH_PORT  = 3001

const HAMMING_THRESHOLD = 5   // bits different = duplicate
const MAX_HASH_SIZE     = 50 * 1024 * 1024  // 50MB — skip beyond this
const CONCURRENCY       = 8   // parallel Drive downloads

if (!SOURCE_ID) { console.error('[ERROR] GOOGLE_SOURCE_FOLDER_ID not set'); process.exit(1) }

// ── Auth ─────────────────────────────────────────────────────────────────────
async function authenticate() {
  const cred = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'))
  const { client_id, client_secret } = cred.installed
  const oauth2 = new google.auth.OAuth2(client_id, client_secret, `http://localhost:${OAUTH_PORT}`)

  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'))
    oauth2.setCredentials(token)
    oauth2.on('tokens', t => {
      if (t.refresh_token) token.refresh_token = t.refresh_token
      Object.assign(token, t)
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2))
    })
    return oauth2
  }

  const authUrl = oauth2.generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/drive.readonly'] })
  console.log('[AUTH] Visit:', authUrl)
  try { execSync(`${process.platform === 'darwin' ? 'open' : 'start'} "${authUrl}"`) } catch {}
  const code = await new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const qs = new URL(req.url, `http://localhost:${OAUTH_PORT}`).searchParams
      res.writeHead(200); res.end('<p>Authorized.</p>'); srv.close()
      qs.get('error') ? reject(new Error(qs.get('error'))) : resolve(qs.get('code'))
    })
    srv.listen(OAUTH_PORT)
  })
  const { tokens } = await oauth2.getToken(code)
  oauth2.setCredentials(tokens)
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2))
  return oauth2
}

// ── Folder traversal ─────────────────────────────────────────────────────────
async function getAllFiles(drive, folderId) {
  const files = []
  const queue = [folderId]

  while (queue.length) {
    const parentId = queue.shift()
    let pageToken  = null
    do {
      const res = await drive.files.list({
        q: `'${parentId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime)',
        pageSize: 200,
        pageToken: pageToken || undefined
      })
      for (const f of res.data.files || []) {
        if (f.mimeType === 'application/vnd.google-apps.folder') queue.push(f.id)
        else files.push(f)
      }
      pageToken = res.data.nextPageToken
    } while (pageToken)
  }
  return files
}

// ── dHash via sharp (true stream — no full file buffer) ──────────────────────
// Resize to 9×8 grayscale, compare adjacent pixels left→right per row → 64-bit hash
async function computeDHash(drive, fileId) {
  const response = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' }
  )

  const transform = sharp({ failOnError: false })
    .resize(9, 8, { fit: 'fill', kernel: 'nearest' })
    .grayscale()
    .raw()

  return new Promise((resolve, reject) => {
    const chunks = []
    response.data.pipe(transform)
    transform.on('data',  d   => chunks.push(d))
    transform.on('error', err => reject(err))
    transform.on('end', () => {
      try {
        const pixels = Buffer.concat(chunks)
        if (pixels.length < 72) return reject(new Error('not enough pixels'))
        let hash = 0n
        for (let row = 0; row < 8; row++) {
          for (let col = 0; col < 8; col++) {
            const i = row * 9 + col
            if (pixels[i] > pixels[i + 1]) hash |= (1n << BigInt(row * 8 + col))
          }
        }
        resolve(hash.toString(16).padStart(16, '0'))
      } catch (e) { reject(e) }
    })
    response.data.on('error', err => {
      if (err.code === 'ERR_STREAM_DESTROYED') return
      reject(err)
    })
  })
}

// ── Hamming distance ──────────────────────────────────────────────────────────
function hamming(a, b) {
  let diff = BigInt('0x' + a) ^ BigInt('0x' + b)
  let d = 0
  while (diff > 0n) { d += Number(diff & 1n); diff >>= 1n }
  return d
}

// ── Union-Find ────────────────────────────────────────────────────────────────
function makeUF(n) {
  const parent = Array.from({ length: n }, (_, i) => i)
  const rank   = new Array(n).fill(0)
  function find(x) { return parent[x] === x ? x : (parent[x] = find(parent[x])) }
  function union(x, y) {
    const [rx, ry] = [find(x), find(y)]
    if (rx === ry) return
    if (rank[rx] < rank[ry]) parent[rx] = ry
    else if (rank[rx] > rank[ry]) parent[ry] = rx
    else { parent[ry] = rx; rank[rx]++ }
  }
  return { find, union }
}

// ── Controlled concurrency ────────────────────────────────────────────────────
async function runWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length)
  let next = 0
  async function worker() {
    while (next < tasks.length) {
      const i = next++
      results[i] = await tasks[i]()
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker))
  return results
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('[DEDUP] TTP Asset Tagger — Phase 1 Dedup Pass')
  console.log('[DEDUP] Read-only — no Drive writes\n')

  const auth  = await authenticate()
  const drive = google.drive({ version: 'v3', auth })

  console.log('[SCAN] Loading file list...')
  const allFiles = await getAllFiles(drive, SOURCE_ID)
  console.log(`[SCAN] ${allFiles.length} total files\n`)

  // Separate hashable images from videos and oversized files
  const isImage = f => f.mimeType && (
    f.mimeType === 'image/jpeg' || f.mimeType === 'image/jpg' ||
    f.mimeType === 'image/png'  || f.mimeType === 'image/heif' ||
    f.mimeType === 'image/heic' || f.mimeType === 'image/webp' ||
    f.mimeType === 'image/gif'
  )
  const isVideo = f => f.mimeType && f.mimeType.startsWith('video/')

  const hashable  = allFiles.filter(f => isImage(f) && parseInt(f.size || 0) <= MAX_HASH_SIZE)
  const oversized = allFiles.filter(f => isImage(f) && parseInt(f.size || 0) >  MAX_HASH_SIZE)
  const videos    = allFiles.filter(f => isVideo(f))

  console.log(`[HASH] Images to hash : ${hashable.length}`)
  console.log(`[HASH] Oversized skip : ${oversized.length} (> 50MB — size-exact match only)`)
  console.log(`[HASH] Videos         : ${videos.length} (exact size match)`)
  console.log()

  // ── Phase 1: Hash all hashable images ────────────────────────────────────
  let done    = 0
  const hashes = new Array(hashable.length)
  const errors = []

  const hashTasks = hashable.map((file, idx) => async () => {
    try {
      hashes[idx] = await computeDHash(drive, file.id)
    } catch (err) {
      hashes[idx] = null
      errors.push({ id: file.id, name: file.name, error: err.message })
    }
    done++
    if (done % 20 === 0 || done === hashable.length) {
      process.stdout.write(`\r[HASH] ${done}/${hashable.length} images hashed${' '.repeat(10)}`)
    }
  })

  await runWithConcurrency(hashTasks, CONCURRENCY)
  console.log('\n')

  // ── Phase 2: All-pairs comparison → union-find grouping ──────────────────
  console.log('[GROUP] Comparing hashes...')
  const uf = makeUF(hashable.length)
  let edgesFound = 0

  for (let i = 0; i < hashable.length; i++) {
    if (!hashes[i]) continue
    for (let j = i + 1; j < hashable.length; j++) {
      if (!hashes[j]) continue
      if (hamming(hashes[i], hashes[j]) <= HAMMING_THRESHOLD) {
        uf.union(i, j)
        edgesFound++
      }
    }
  }
  console.log(`[GROUP] ${edgesFound} duplicate edges found`)

  // Collect image dupe groups (size > 1)
  const imageGroups = {}
  for (let i = 0; i < hashable.length; i++) {
    if (!hashes[i]) continue
    const root = uf.find(i)
    if (!imageGroups[root]) imageGroups[root] = []
    imageGroups[root].push(i)
  }
  const imageDupeGroups = Object.values(imageGroups).filter(g => g.length > 1)

  // ── Phase 3: Video + oversized exact-size grouping ────────────────────────
  const videoAndOversized = [...videos, ...oversized]
  const sizeMap = {}
  for (const f of videoAndOversized) {
    const key = `${f.size}_${f.mimeType}`
    if (!sizeMap[key]) sizeMap[key] = []
    sizeMap[key].push(f)
  }
  const sizeExactGroups = Object.values(sizeMap).filter(g => g.length > 1)

  // ── Phase 4: Build report ─────────────────────────────────────────────────
  function keepRecommendation(files) {
    // Keep largest size (highest quality). Tiebreak: most recent modifiedTime.
    return [...files].sort((a, b) => {
      const sizeDiff = parseInt(b.size || 0) - parseInt(a.size || 0)
      if (sizeDiff !== 0) return sizeDiff
      return new Date(b.modifiedTime) - new Date(a.modifiedTime)
    })[0].id
  }

  const duplicateGroups = []
  let bytesSaved = 0

  for (const group of imageDupeGroups) {
    const files  = group.map(i => hashable[i])
    const keepId = keepRecommendation(files)
    const kills  = files.filter(f => f.id !== keepId)
    bytesSaved  += kills.reduce((s, f) => s + parseInt(f.size || 0), 0)
    duplicateGroups.push({
      type:        'image_phash',
      files:       files.map(f => ({ id: f.id, name: f.name, mimeType: f.mimeType, size: parseInt(f.size || 0) })),
      keep_id:     keepId,
      kill_ids:    kills.map(f => f.id),
      hash_values: group.map(i => hashes[i]),
      min_hamming: (() => {
        let min = Infinity
        for (let a = 0; a < group.length; a++)
          for (let b = a + 1; b < group.length; b++)
            min = Math.min(min, hamming(hashes[group[a]], hashes[group[b]]))
        return min
      })()
    })
  }

  for (const group of sizeExactGroups) {
    const keepId = keepRecommendation(group)
    const kills  = group.filter(f => f.id !== keepId)
    bytesSaved  += kills.reduce((s, f) => s + parseInt(f.size || 0), 0)
    duplicateGroups.push({
      type:     'size_exact',
      files:    group.map(f => ({ id: f.id, name: f.name, mimeType: f.mimeType, size: parseInt(f.size || 0) })),
      keep_id:  keepId,
      kill_ids: kills.map(f => f.id)
    })
  }

  const allKillIds  = [...new Set(duplicateGroups.flatMap(g => g.kill_ids))]
  const uniqueAfter = allFiles.length - allKillIds.length

  const report = {
    generated_at:          new Date().toISOString(),
    source_folder_id:      SOURCE_ID,
    total_files_scanned:   allFiles.length,
    images_hashed:         hashable.length,
    hash_errors:           errors.length,
    duplicate_groups:      duplicateGroups,
    total_duplicate_files: allKillIds.length,
    total_unique_after_dedup: uniqueAfter,
    bytes_saved_estimate:  bytesSaved,
    hash_errors_detail:    errors
  }

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2))
  console.log(`[DONE] Report written to ${REPORT_PATH}\n`)

  // ── 10-line summary ───────────────────────────────────────────────────────
  const imgDupeFiles  = imageDupeGroups.reduce((s, g) => s + g.length, 0)
  const sizeDupeFiles = sizeExactGroups.reduce((s, g) => s + g.length, 0)
  const savedMB       = (bytesSaved / 1_000_000).toFixed(1)

  console.log('══════════════════════════════════════════════════')
  console.log(' TTP ASSET TAGGER — DEDUP SUMMARY')
  console.log('══════════════════════════════════════════════════')
  console.log(` Total files scanned     : ${allFiles.length}`)
  console.log(` Images hashed (pHash)   : ${hashable.length}  (${errors.length} errors)`)
  console.log(` pHash dupe groups       : ${imageDupeGroups.length}  (${imgDupeFiles} files)`)
  console.log(` Exact-size dupe groups  : ${sizeExactGroups.length}  (${sizeDupeFiles} files — video/oversized)`)
  console.log(` Total duplicate files   : ${allKillIds.length}  recommended for deletion`)
  console.log(` Unique files after dedup: ${uniqueAfter}`)
  console.log(` Estimated bytes saved   : ${savedMB} MB`)
  console.log(` Hash errors             : ${errors.length}${errors.length ? '  (see dedup_report.json > hash_errors_detail)' : ''}`)
  console.log(` Report saved            : data/dedup_report.json`)
  console.log('══════════════════════════════════════════════════\n')
}

main().catch(err => {
  console.error('[FATAL]', err.message)
  process.exit(1)
})
