#!/usr/bin/env node
// scripts/cluster.js — read-only. Groups Drive images by (suburb, date) using
// Drive's imageMediaMetadata.location + Nominatim reverse geocoding.
// Writes data/cluster_report.json. No Drive writes.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { google } = require('googleapis')
const fs   = require('fs')
const path = require('path')
const https = require('https')
const config = require('../config')

const ROOT_DIR        = path.join(__dirname, '..')
const SOURCE_ID       = process.env.GOOGLE_SOURCE_FOLDER_ID
const REPORT_PATH     = config.clusterReportPath
const GEOCODE_CACHE   = path.join(ROOT_DIR, 'data', 'geocode_cache.json')
const NOMINATIM_DELAY = 1100   // ms — respect 1 req/sec rate limit
const COORD_PRECISION = 3      // decimal places (~110m bucketing)

if (!SOURCE_ID) { console.error('[ERROR] GOOGLE_SOURCE_FOLDER_ID not set'); process.exit(1) }

// ── Auth ──────────────────────────────────────────────────────────────────────
async function getAuth() {
  const cred = JSON.parse(fs.readFileSync(config.oauthClientPath, 'utf8'))
  const { client_id, client_secret } = cred.installed
  const oa = new google.auth.OAuth2(client_id, client_secret, `http://localhost:${config.oauthPort}`)
  const tok = JSON.parse(fs.readFileSync(config.tokenPath, 'utf8'))
  oa.setCredentials(tok)
  oa.on('tokens', t => {
    if (t.refresh_token) tok.refresh_token = t.refresh_token
    Object.assign(tok, t)
    fs.writeFileSync(config.tokenPath, JSON.stringify(tok, null, 2))
  })
  return oa
}

// ── Drive recursive list with imageMediaMetadata ─────────────────────────────
async function listAllImages(drive, folderId) {
  const out = []
  async function walk(id) {
    let pageToken
    do {
      const res = await drive.files.list({
        q: `'${id}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, size, parents, modifiedTime, imageMediaMetadata)',
        pageSize: 200,
        pageToken
      })
      for (const f of res.data.files || []) {
        if (f.mimeType === 'application/vnd.google-apps.folder') await walk(f.id)
        else if (f.mimeType && f.mimeType.startsWith('image/')) out.push(f)
      }
      pageToken = res.data.nextPageToken
    } while (pageToken)
  }
  await walk(folderId)
  return out
}

// ── Nominatim reverse geocode with on-disk cache ─────────────────────────────
function loadCache() {
  try { return JSON.parse(fs.readFileSync(GEOCODE_CACHE, 'utf8')) } catch { return {} }
}
function saveCache(c) { fs.writeFileSync(GEOCODE_CACHE, JSON.stringify(c, null, 2)) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

function nominatim(lat, lng) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=14&addressdetails=1`
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'ttp-asset-tagger/1.0 (internal use)' } }, res => {
      let body = ''
      res.on('data', c => body += c)
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (e) { reject(e) }
      })
    }).on('error', reject)
  })
}

const STATE_MAP = { 'Victoria': 'VIC', 'New South Wales': 'NSW', 'Queensland': 'QLD',
  'South Australia': 'SA', 'Western Australia': 'WA', 'Tasmania': 'TAS',
  'Northern Territory': 'NT', 'Australian Capital Territory': 'ACT' }

async function reverseGeocode(lat, lng, cache) {
  const key = `${lat.toFixed(COORD_PRECISION)},${lng.toFixed(COORD_PRECISION)}`
  if (cache[key]) return cache[key]
  await sleep(NOMINATIM_DELAY)
  try {
    const r = await nominatim(parseFloat(lat.toFixed(COORD_PRECISION)), parseFloat(lng.toFixed(COORD_PRECISION)))
    const a = r.address || {}
    const suburb = a.suburb || a.city_district || a.town || a.village || a.city || a.locality || a.hamlet || null
    const state  = STATE_MAP[a.state] || a.state || null
    const result = { suburb, state, postcode: a.postcode || null, raw: r.display_name }
    cache[key] = result
    saveCache(cache)
    return result
  } catch (err) {
    cache[key] = { suburb: null, state: null, error: err.message }
    saveCache(cache)
    return cache[key]
  }
}

// ── Date parsing — Drive returns "YYYY:MM:DD HH:MM:SS" ────────────────────────
function parseExifTime(t) {
  if (!t) return null
  const m = t.match(/^(\d{4}):(\d{2}):(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  console.log('\n╔══════════════════════════════════════════╗')
  console.log('║   TTP Asset Tagger — Phase 3 Cluster     ║')
  console.log('╚══════════════════════════════════════════╝\n')

  const auth  = await getAuth()
  const drive = google.drive({ version: 'v3', auth })

  console.log('[SCAN] Listing all images...')
  const files = await listAllImages(drive, SOURCE_ID)
  console.log(`[SCAN] Found ${files.length} images`)

  const withGPS = []
  const ungrouped = []
  for (const f of files) {
    const meta = f.imageMediaMetadata
    const loc  = meta && meta.location
    const time = meta && meta.time
    const date = parseExifTime(time)
    if (loc && typeof loc.latitude === 'number' && typeof loc.longitude === 'number' && date) {
      withGPS.push({ file: f, lat: loc.latitude, lng: loc.longitude, date })
    } else {
      ungrouped.push({
        id: f.id, name: f.name, mimeType: f.mimeType,
        reason: !meta ? 'no_metadata' : !loc ? 'no_gps' : !date ? 'no_date' : 'unknown'
      })
    }
  }

  console.log(`[SCAN] With GPS+date : ${withGPS.length}`)
  console.log(`[SCAN] Ungrouped     : ${ungrouped.length}`)

  // Reverse geocode unique coords
  const cache = loadCache()
  const uniqueKeys = new Set(withGPS.map(x => `${x.lat.toFixed(COORD_PRECISION)},${x.lng.toFixed(COORD_PRECISION)}`))
  const cachedKeys = new Set(Object.keys(cache))
  const toFetch    = [...uniqueKeys].filter(k => !cachedKeys.has(k))
  const cachedHits = [...uniqueKeys].filter(k => cachedKeys.has(k)).length
  console.log(`[GEO]  Unique coords : ${uniqueKeys.size} (cached: ${cachedHits}, to fetch: ${toFetch.length})`)
  console.log(`[GEO]  Estimated time: ~${Math.ceil(toFetch.length * NOMINATIM_DELAY / 1000)}s\n`)

  for (const item of withGPS) {
    const result = await reverseGeocode(item.lat, item.lng, cache)
    item.suburb = result.suburb
    item.state  = result.state
    if (toFetch.includes(`${item.lat.toFixed(COORD_PRECISION)},${item.lng.toFixed(COORD_PRECISION)}`)) {
      process.stdout.write(`  [GEO] ${item.lat.toFixed(4)}, ${item.lng.toFixed(4)} → ${result.suburb || '?'}, ${result.state || '?'}\n`)
    }
  }

  // Group by (suburb, date)
  const groups = {}
  for (const item of withGPS) {
    if (!item.suburb) {
      ungrouped.push({ id: item.file.id, name: item.file.name, mimeType: item.file.mimeType, reason: 'geocode_failed' })
      continue
    }
    const key = `${item.suburb}|${item.state}|${item.date}`
    if (!groups[key]) groups[key] = { suburb: item.suburb, state: item.state, date: item.date, files: [] }
    groups[key].files.push({
      id: item.file.id,
      name: item.file.name,
      mimeType: item.file.mimeType,
      size: parseInt(item.file.size || 0),
      parents: item.file.parents || [],
      exifTime: item.file.imageMediaMetadata?.time,
      lat: item.lat,
      lng: item.lng
    })
  }

  const clusters = Object.entries(groups).map(([id, g]) => ({
    id: Buffer.from(id).toString('base64').replace(/=+$/, ''),
    suburb: g.suburb,
    state: g.state,
    date: g.date,
    fileCount: g.files.length,
    files: g.files.sort((a, b) => (a.exifTime || '').localeCompare(b.exifTime || ''))
  })).sort((a, b) => (b.fileCount - a.fileCount))

  const report = {
    generated_at: new Date().toISOString(),
    source_folder_id: SOURCE_ID,
    total_images: files.length,
    clustered: withGPS.filter(x => x.suburb).length,
    ungrouped_count: ungrouped.length,
    cluster_count: clusters.length,
    clusters,
    ungrouped
  }

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2))
  console.log('\n──────────────────────────────────────────────')
  console.log(`  Clusters    : ${clusters.length}`)
  console.log(`  Clustered   : ${report.clustered} files`)
  console.log(`  Ungrouped   : ${report.ungrouped_count} files`)
  console.log(`  Top 5 clusters:`)
  for (const c of clusters.slice(0, 5)) {
    console.log(`    ${c.suburb} ${c.state} ${c.date} — ${c.fileCount} files`)
  }
  console.log(`  Report      : ${REPORT_PATH}`)
  console.log('──────────────────────────────────────────────\n')
}

run().catch(err => { console.error('[FATAL]', err.message); process.exit(1) })
