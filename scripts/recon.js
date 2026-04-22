#!/usr/bin/env node
// scripts/recon.js — read-only Drive folder recon. Writes data/recon_report.json.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { google } = require('googleapis')
const fs = require('fs')
const path = require('path')
const http = require('http')
const { execSync } = require('child_process')

const ROOT_DIR    = path.join(__dirname, '..')
const CRED_PATH   = process.env.GOOGLE_OAUTH_CLIENT_PATH || path.join(ROOT_DIR, 'data', 'credentials.json')
const TOKEN_PATH  = path.join(ROOT_DIR, 'data', 'token.json')
const REPORT_PATH = path.join(ROOT_DIR, 'data', 'recon_report.json')
const SOURCE_ID   = process.env.GOOGLE_SOURCE_FOLDER_ID
const OAUTH_PORT  = 3001
const EXIF_SAMPLE_SIZE = 20

if (!SOURCE_ID) { console.error('[ERROR] GOOGLE_SOURCE_FOLDER_ID not set in .env'); process.exit(1) }

// ── Auth (mirrors server.js — token already exists from prior auth) ──────────
async function authenticate() {
  const cred  = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'))
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

  // First-time flow (shouldn't be needed — token already saved)
  const authUrl = oauth2.generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/drive.readonly'] })
  console.log('[AUTH] Visit:', authUrl)
  try {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
    execSync(`${cmd} "${authUrl}"`)
  } catch {}
  const code = await new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const qs = new URL(req.url, `http://localhost:${OAUTH_PORT}`).searchParams
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<p>Authorized — close this tab.</p>')
      srv.close()
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
async function buildFolderTree(drive, folderId, folderName) {
  const node = { id: folderId, name: folderName, files: [], children: [] }
  let pageToken = null
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime)',
      pageSize: 200,
      pageToken: pageToken || undefined
    })
    for (const f of res.data.files || []) {
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        node.children.push(await buildFolderTree(drive, f.id, f.name))
      } else {
        node.files.push(f)
      }
    }
    pageToken = res.data.nextPageToken
  } while (pageToken)
  return node
}

function flattenFiles(node) {
  let all = [...node.files]
  for (const child of node.children) all = all.concat(flattenFiles(child))
  return all
}

function buildSubfolderMap(node, depth = 0) {
  const assetCount  = node.files.filter(f => isAsset(f)).length
  const totalCount  = node.files.length
  const result = {
    id: node.id,
    name: node.name,
    files: totalCount,
    assets: assetCount,
    children: node.children.map(c => buildSubfolderMap(c, depth + 1))
  }
  return result
}

function isAsset(f) {
  return f.mimeType && (f.mimeType.startsWith('image/') || f.mimeType.startsWith('video/'))
}

// ── Inline JPEG EXIF parser (no deps) ────────────────────────────────────────
function parseExifFromBuffer(buf) {
  if (!buf || buf.length < 4) return null
  if (buf[0] !== 0xFF || buf[1] !== 0xD8) return null // not JPEG

  let offset = 2
  while (offset < buf.length - 4) {
    if (buf[offset] !== 0xFF) break
    const marker = buf[offset + 1]
    if (marker === 0xDA) break // SOS — no more header segments

    const segLen = buf.readUInt16BE(offset + 2)
    if (marker === 0xE1 && offset + 10 < buf.length) {
      const hdr = buf.slice(offset + 4, offset + 10).toString('binary')
      if (hdr === 'Exif\x00\x00') {
        return readTiffTags(buf.slice(offset + 10, offset + 2 + segLen))
      }
    }
    offset += 2 + segLen
  }
  return null
}

function readTiffTags(tiff) {
  if (tiff.length < 8) return { hasDateTime: false, hasGPS: false }
  const le = tiff.slice(0, 2).toString('binary') === 'II'
  const u16 = o => le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o)
  const u32 = o => le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o)

  const ifd0 = u32(4)
  if (ifd0 + 2 > tiff.length) return { hasDateTime: false, hasGPS: false }

  let hasDateTime = false
  let hasGPS      = false
  let exifIFDPtr  = 0

  const count0 = u16(ifd0)
  for (let i = 0; i < count0; i++) {
    const e = ifd0 + 2 + i * 12
    if (e + 12 > tiff.length) break
    const tag = u16(e)
    if (tag === 0x0132) hasDateTime = true  // DateTime
    if (tag === 0x8825) hasGPS = true       // GPSInfo IFD pointer
    if (tag === 0x8769) exifIFDPtr = u32(e + 8) // Exif IFD pointer
  }

  if (!hasDateTime && exifIFDPtr > 0 && exifIFDPtr + 2 <= tiff.length) {
    const countE = u16(exifIFDPtr)
    for (let i = 0; i < countE; i++) {
      const e = exifIFDPtr + 2 + i * 12
      if (e + 12 > tiff.length) break
      const tag = u16(e)
      if (tag === 0x9003 || tag === 0x9004) { hasDateTime = true; break }
    }
  }

  return { hasDateTime, hasGPS }
}

async function downloadPartial(drive, fileId, maxBytes = 65536) {
  return new Promise(async (resolve) => {
    const chunks = []
    let total    = 0
    let done     = false

    const finish = () => {
      if (done) return
      done = true
      try { resolve(Buffer.concat(chunks)) } catch { resolve(Buffer.alloc(0)) }
    }

    try {
      const resp = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' })
      resp.data.on('data', chunk => {
        if (done) return
        chunks.push(chunk)
        total += chunk.length
        if (total >= maxBytes) { resp.data.destroy(); finish() }
      })
      resp.data.on('end',   finish)
      resp.data.on('close', finish)
      resp.data.on('error', err => {
        if (err.code === 'ERR_STREAM_DESTROYED') finish()
        else { chunks.push(Buffer.alloc(0)); finish() }
      })
    } catch {
      finish()
    }
  })
}

async function sampleExif(drive, allFiles) {
  const images = allFiles.filter(f => f.mimeType === 'image/jpeg' || f.mimeType === 'image/jpg')
  if (images.length === 0) return { sampled: 0, pct_with_datetime: 0, pct_with_gps: 0, samples: [] }

  // Pick random sample
  const pool     = [...images]
  const sample   = []
  while (sample.length < EXIF_SAMPLE_SIZE && pool.length > 0) {
    const idx = Math.floor(Math.random() * pool.length)
    sample.push(pool.splice(idx, 1)[0])
  }

  process.stdout.write(`[EXIF] Sampling ${sample.length} images`)
  const results = []
  for (const file of sample) {
    process.stdout.write('.')
    try {
      const buf  = await downloadPartial(drive, file.id, 65536)
      const exif = parseExifFromBuffer(buf)
      results.push({ name: file.name, hasExif: !!exif, hasDateTime: exif?.hasDateTime || false, hasGPS: exif?.hasGPS || false })
    } catch {
      results.push({ name: file.name, hasExif: false, hasDateTime: false, hasGPS: false })
    }
  }
  console.log(' done')

  const withExif     = results.filter(r => r.hasExif).length
  const withDateTime = results.filter(r => r.hasDateTime).length
  const withGPS      = results.filter(r => r.hasGPS).length

  return {
    sampled: results.length,
    pct_with_exif:     Math.round(withExif     / results.length * 100),
    pct_with_datetime: Math.round(withDateTime / results.length * 100),
    pct_with_gps:      Math.round(withGPS      / results.length * 100),
    samples: results
  }
}

// ── Duplicates ────────────────────────────────────────────────────────────────
function findDuplicates(files) {
  const byName = {}
  const bySize = {}
  for (const f of files) {
    byName[f.name] = (byName[f.name] || []).concat(f.id)
    if (f.size) bySize[f.size] = (bySize[f.size] || []).concat({ id: f.id, name: f.name })
  }
  const nameDupes = Object.entries(byName)
    .filter(([, ids]) => ids.length > 1)
    .map(([name, ids]) => ({ name, count: ids.length, ids }))

  const sizeDupes = Object.entries(bySize)
    .filter(([size, items]) => items.length > 1 && parseInt(size) > 1024) // skip tiny files
    .map(([size, items]) => ({ size_bytes: parseInt(size), count: items.length, files: items }))

  return { by_name: nameDupes, by_size: sizeDupes }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('[RECON] TTP Asset Tagger — Phase 0 Recon')
  console.log(`[RECON] Source folder: ${SOURCE_ID}`)
  console.log('[RECON] Read-only scan — no changes will be made\n')

  const auth  = await authenticate()
  const drive = google.drive({ version: 'v3', auth })

  // Get root folder name
  const rootMeta = await drive.files.get({ fileId: SOURCE_ID, fields: 'name, modifiedTime' })
  console.log(`[SCAN] Root folder: "${rootMeta.data.name}"`)

  console.log('[SCAN] Building folder tree...')
  const tree     = await buildFolderTree(drive, SOURCE_ID, rootMeta.data.name)
  const allFiles = flattenFiles(tree)
  const assets   = allFiles.filter(isAsset)
  const nonAssets = allFiles.filter(f => !isAsset(f))

  console.log(`[SCAN] Total files: ${allFiles.length} (${assets.length} assets, ${nonAssets.length} non-assets)`)

  // MIME breakdown
  const mimeBreakdown = {}
  for (const f of allFiles) {
    mimeBreakdown[f.mimeType] = (mimeBreakdown[f.mimeType] || 0) + 1
  }

  // Size distribution
  const sizeDist = { under_100kb: 0, '100kb_to_1mb': 0, '1mb_to_10mb': 0, over_10mb: 0 }
  for (const f of assets) {
    const s = parseInt(f.size || 0)
    if (s < 100_000)         sizeDist.under_100kb++
    else if (s < 1_000_000)  sizeDist['100kb_to_1mb']++
    else if (s < 10_000_000) sizeDist['1mb_to_10mb']++
    else                     sizeDist.over_10mb++
  }

  // Date range
  const dates = assets.map(f => f.modifiedTime).filter(Boolean).sort()
  const dateRange = {
    oldest_modified:  dates[0]           || null,
    newest_modified:  dates[dates.length - 1] || null
  }

  // Duplicates
  console.log('[SCAN] Checking for duplicates...')
  const duplicates = findDuplicates(allFiles)

  // EXIF sample
  const exifResults = await sampleExif(drive, assets)

  // Assemble report
  const report = {
    generated_at: new Date().toISOString(),
    source_folder_id: SOURCE_ID,
    source_folder_name: rootMeta.data.name,
    total_files: allFiles.length,
    total_assets: assets.length,
    mime_breakdown: mimeBreakdown,
    subfolder_map: buildSubfolderMap(tree),
    non_asset_files: nonAssets.map(f => ({ id: f.id, name: f.name, mimeType: f.mimeType, size: f.size })),
    size_distribution: sizeDist,
    date_range: dateRange,
    exif_sample: exifResults,
    suspected_duplicates: duplicates
  }

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2))
  console.log(`\n[DONE] Report written to ${REPORT_PATH}`)

  // ── 10-line terminal summary ──────────────────────────────────────────────
  const dupNameCount = duplicates.by_name.reduce((a, d) => a + d.count, 0)
  const dupSizeCount = duplicates.by_size.reduce((a, d) => a + d.count, 0)

  const topMimes = Object.entries(mimeBreakdown).sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([m, n]) => `${m.split('/')[1]} ×${n}`).join(', ')

  console.log('\n══════════════════════════════════════════════')
  console.log(' TTP ASSET TAGGER — RECON SUMMARY')
  console.log('══════════════════════════════════════════════')
  console.log(` Total files scanned  : ${allFiles.length}`)
  console.log(` Asset files (img/vid): ${assets.length}`)
  console.log(` Non-asset files      : ${nonAssets.length}`)
  console.log(` MIME types           : ${topMimes}`)
  console.log(` Size dist            : <100KB=${sizeDist.under_100kb}  100KB-1MB=${sizeDist['100kb_to_1mb']}  1-10MB=${sizeDist['1mb_to_10mb']}  >10MB=${sizeDist.over_10mb}`)
  console.log(` Date range           : ${dateRange.oldest_modified?.slice(0,10) || '?'} → ${dateRange.newest_modified?.slice(0,10) || '?'}`)
  console.log(` Suspected dupes (name): ${dupNameCount} files across ${duplicates.by_name.length} name collision(s)`)
  console.log(` Suspected dupes (size): ${dupSizeCount} files across ${duplicates.by_size.length} size collision(s)`)
  console.log(` EXIF sample (${exifResults.sampled} images): DateTime=${exifResults.pct_with_datetime}%  GPS=${exifResults.pct_with_gps}%`)
  console.log(` Report saved         : data/recon_report.json`)
  console.log('══════════════════════════════════════════════\n')
}

main().catch(err => {
  console.error('[FATAL]', err.message)
  process.exit(1)
})
