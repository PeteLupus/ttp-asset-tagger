#!/usr/bin/env node
'use strict'

// scripts/cluster-tag-all.js — bulk-move all clustered files into
// TTP Organized Assets/{Suburb STATE}/{YYYY-MM-DD}/ folders.
// Reads data/cluster_report.json. Updates data/progress.json so the
// tagger UI no longer surfaces these files. No job-type assigned.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { google } = require('googleapis')
const fs   = require('fs')
const path = require('path')
const config = require('../config')

const DRY_RUN        = !process.argv.includes('--confirm')
const RATE_LIMIT_MS  = 120  // ~8 req/sec
const ROOT_DIR       = path.join(__dirname, '..')
const REPORT_PATH    = config.clusterReportPath
const LOG_PATH       = path.join(ROOT_DIR, 'data', 'cluster_tag_log.json')
const PROGRESS_PATH  = config.progressPath
const DEST_ROOT_NAME = config.destinationRootName

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

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── Folder cache ──────────────────────────────────────────────────────────────
const folderCache = {}
async function ensureFolder(drive, name, parentId) {
  const key = `${parentId}::${name}`
  if (folderCache[key]) return folderCache[key]
  const res = await drive.files.list({
    q: `name = '${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id)',
    pageSize: 1
  })
  if (res.data.files && res.data.files.length > 0) {
    folderCache[key] = res.data.files[0].id
    return folderCache[key]
  }
  const created = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    fields: 'id'
  })
  folderCache[key] = created.data.id
  return folderCache[key]
}

async function getOrCreateDestRoot(drive) {
  const res = await drive.files.list({
    q: `name = '${DEST_ROOT_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id)',
    pageSize: 1
  })
  if (res.data.files && res.data.files.length > 0) return res.data.files[0].id
  const created = await drive.files.create({
    requestBody: { name: DEST_ROOT_NAME, mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id'
  })
  return created.data.id
}

async function moveFile(drive, fileId, destFolderId) {
  const meta = await drive.files.get({ fileId, fields: 'parents' })
  const prevParents = (meta.data.parents || []).join(',')
  await drive.files.update({
    fileId,
    addParents: destFolderId,
    removeParents: prevParents,
    fields: 'id, parents'
  })
}

// ── Progress / log helpers ────────────────────────────────────────────────────
function loadProgress() {
  try { return JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8')) }
  catch { return { tagged: {}, skipped: [] } }
}
function saveProgress(p) { fs.writeFileSync(PROGRESS_PATH, JSON.stringify(p, null, 2)) }
function loadLog() {
  try { return JSON.parse(fs.readFileSync(LOG_PATH, 'utf8')) }
  catch { return [] }
}
function saveLog(log) { fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2)) }

function fmtBytes(b) {
  if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB'
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB'
  if (b >= 1e3) return (b / 1e3).toFixed(1) + ' KB'
  return b + ' B'
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'))
  const clusters = report.clusters || []
  const totalFiles = clusters.reduce((a, c) => a + c.fileCount, 0)
  const totalBytes = clusters.reduce((a, c) => a + c.files.reduce((s, f) => s + (parseInt(f.size) || 0), 0), 0)

  console.log('\n╔══════════════════════════════════════════╗')
  console.log('║  TTP Asset Tagger — Cluster Tag-All     ║')
  console.log('╚══════════════════════════════════════════╝\n')
  console.log(`  Clusters    : ${clusters.length}`)
  console.log(`  Total files : ${totalFiles}`)
  console.log(`  Total size  : ${fmtBytes(totalBytes)}`)
  console.log(`  Mode        : ${DRY_RUN ? '🔍 DRY RUN (pass --confirm to execute)' : '⚡ LIVE'}\n`)

  if (DRY_RUN) {
    console.log('Folders that would be created and files that would be moved:\n')
    for (const c of clusters) {
      console.log(`  ${DEST_ROOT_NAME}/${c.suburb} ${c.state}/${c.date}/  (${c.fileCount} files)`)
    }
    console.log(`\n  DRY RUN — would move ${totalFiles} files into ${clusters.length} cluster folders.`)
    console.log('  Run with --confirm to execute.\n')
    return
  }

  const auth  = await getAuth()
  const drive = google.drive({ version: 'v3', auth })

  console.log('  Resolving destination root...')
  const rootId = await getOrCreateDestRoot(drive)
  console.log(`  Root folder ID: ${rootId}\n`)

  const log = loadLog()
  const alreadyMoved = new Set(log.filter(e => e.action === 'moved').map(e => e.file_id))
  const progress = loadProgress()

  let moved = 0, errors = 0, skipped = 0, bytesMoved = 0
  let fileIdx = 0

  for (const c of clusters) {
    console.log(`\n  ▶ ${c.suburb} ${c.state} / ${c.date}  (${c.fileCount} files)`)
    const locFolderId  = await ensureFolder(drive, `${c.suburb} ${c.state}`, rootId)
    const dateFolderId = await ensureFolder(drive, c.date, locFolderId)

    for (const file of c.files) {
      fileIdx++
      if (alreadyMoved.has(file.id) || progress.tagged[file.id]) {
        skipped++
        continue
      }
      const entry = {
        timestamp: new Date().toISOString(),
        cluster_id: c.id,
        suburb: c.suburb,
        state: c.state,
        date: c.date,
        file_id: file.id,
        file_name: file.name,
        action: null
      }
      try {
        await moveFile(drive, file.id, dateFolderId)
        entry.action = 'moved'
        progress.tagged[file.id] = {
          suburb: c.suburb,
          state: c.state,
          date: c.date,
          destFolderId: dateFolderId,
          taggedAt: entry.timestamp,
          via: 'cluster-tag-all'
        }
        moved++
        bytesMoved += parseInt(file.size || 0)
        console.log(`    [${fileIdx}/${totalFiles}] MOVED  ${file.name}  (${fmtBytes(parseInt(file.size || 0))})`)
      } catch (err) {
        if (err.code === 404 || (err.message && err.message.includes('File not found'))) {
          entry.action = 'skipped_not_found'
          console.log(`    [${fileIdx}/${totalFiles}] SKIP   ${file.name}  (not found)`)
        } else {
          entry.action = 'error'
          entry.error_message = err.message
          errors++
          console.error(`    [${fileIdx}/${totalFiles}] ERROR  ${file.name}  — ${err.message}`)
        }
      }
      log.push(entry)
      saveLog(log)
      saveProgress(progress)
      await sleep(RATE_LIMIT_MS)
    }
  }

  console.log('\n──────────────────────────────────────────────')
  console.log(`  Moved       : ${moved}`)
  console.log(`  Skipped     : ${skipped} (already tagged or already moved)`)
  console.log(`  Errors      : ${errors}`)
  console.log(`  Size moved  : ${fmtBytes(bytesMoved)}`)
  console.log(`  Log         : ${LOG_PATH}`)
  console.log('──────────────────────────────────────────────\n')
}

run().catch(err => { console.error('[FATAL]', err.message); process.exit(1) })
