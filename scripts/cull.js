#!/usr/bin/env node
'use strict'

const { google } = require('googleapis')
const fs = require('fs')
const path = require('path')
const config = require('../config')

const DRY_RUN = !process.argv.includes('--confirm')
const RATE_LIMIT_MS = 120  // ~8 req/sec, safe under 10/sec cap
const CULL_FOLDER_NAME = '_DUPLICATES_CULL'

const REPORT_PATH  = config.dedupReportPath
const CULL_LOG     = path.join(__dirname, '..', 'data', 'cull_log.json')
const OAUTH_PATH   = config.oauthClientPath
const TOKEN_PATH   = config.tokenPath

// ── Auth ──────────────────────────────────────────────────────────────────────
async function getAuth() {
  const cred = JSON.parse(fs.readFileSync(OAUTH_PATH, 'utf8'))
  const { client_id, client_secret } = cred.installed
  const oAuth2 = new google.auth.OAuth2(client_id, client_secret, `http://localhost:${config.oauthPort}`)
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'))
  oAuth2.setCredentials(token)
  oAuth2.on('tokens', t => {
    if (t.refresh_token) token.refresh_token = t.refresh_token
    Object.assign(token, t)
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2))
  })
  return oAuth2
}

// ── Kill list ─────────────────────────────────────────────────────────────────
function getKillList() {
  const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'))
  const kills = []
  for (const group of report.duplicate_groups || []) {
    for (const killId of group.kill_ids) {
      const file = group.files.find(f => f.id === killId)
      if (file) kills.push({ id: file.id, name: file.name, size: parseInt(file.size || 0) })
    }
  }
  return kills
}

// ── Rate limiter ──────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── Get or create the cull folder at Drive root ───────────────────────────────
async function getOrCreateCullFolder(drive) {
  const res = await drive.files.list({
    q: `name = '${CULL_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id)',
    pageSize: 1
  })
  if (res.data.files && res.data.files.length > 0) return res.data.files[0].id

  const created = await drive.files.create({
    requestBody: { name: CULL_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id'
  })
  return created.data.id
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  const kills = getKillList()

  console.log('\n╔══════════════════════════════════════════╗')
  console.log('║      TTP Asset Tagger — Phase 1.5 Cull   ║')
  console.log('╚══════════════════════════════════════════╝\n')
  console.log(`  Kill list : ${kills.length} files`)
  console.log(`  Mode      : ${DRY_RUN ? '🔍 DRY RUN (pass --confirm to execute)' : `⚡ LIVE — moving to ${CULL_FOLDER_NAME}`}`)

  const totalBytes = kills.reduce((a, f) => a + f.size, 0)
  console.log(`  Size      : ${fmtBytes(totalBytes)}\n`)

  if (DRY_RUN) {
    console.log('Files that would be moved:')
    for (const f of kills) console.log(`  [DRY] ${f.name}  (${fmtBytes(f.size)})  ${f.id}`)
    console.log(`\n  DRY RUN — would move ${kills.length} files to ${CULL_FOLDER_NAME} (${fmtBytes(totalBytes)})`)
    console.log('  Run with --confirm to execute.\n')
    return
  }

  const auth  = await getAuth()
  const drive = google.drive({ version: 'v3', auth })

  console.log(`  Creating/locating folder: ${CULL_FOLDER_NAME}...`)
  const cullFolderId = await getOrCreateCullFolder(drive)
  console.log(`  Folder ID: ${cullFolderId}\n`)

  const log = []
  let moved = 0, errors = 0, bytesMoved = 0

  for (let i = 0; i < kills.length; i++) {
    const file = kills[i]
    const entry = {
      timestamp: new Date().toISOString(),
      file_id: file.id,
      file_name: file.name,
      action: null
    }

    try {
      const meta = await drive.files.get({ fileId: file.id, fields: 'parents' })
      const prevParents = (meta.data.parents || []).join(',')
      await drive.files.update({
        fileId: file.id,
        addParents: cullFolderId,
        removeParents: prevParents,
        fields: 'id, parents'
      })
      entry.action = 'moved'
      moved++
      bytesMoved += file.size
      console.log(`  [${i + 1}/${kills.length}] MOVED  ${file.name}  (${fmtBytes(file.size)})`)
    } catch (err) {
      if (err.code === 404 || (err.message && err.message.includes('File not found'))) {
        entry.action = 'skipped_not_found'
        console.log(`  [${i + 1}/${kills.length}] SKIP   ${file.name}  (not found)`)
      } else {
        entry.action = 'error'
        entry.error_message = err.message
        errors++
        console.error(`  [${i + 1}/${kills.length}] ERROR  ${file.name}  — ${err.message}`)
      }
    }

    log.push(entry)
    fs.writeFileSync(CULL_LOG, JSON.stringify(log, null, 2))

    if (i < kills.length - 1) await sleep(RATE_LIMIT_MS)
  }

  console.log('\n──────────────────────────────────────────────')
  console.log(`  Moved to ${CULL_FOLDER_NAME} : ${moved}`)
  console.log(`  Errors                    : ${errors}`)
  console.log(`  Total size moved          : ${fmtBytes(bytesMoved)}`)
  console.log(`  Log                       : ${CULL_LOG}`)
  console.log('──────────────────────────────────────────────')
  console.log(`  Files are in Drive → ${CULL_FOLDER_NAME}`)
  console.log('  Delete that folder manually when satisfied.\n')
}

function fmtBytes(b) {
  if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB'
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB'
  if (b >= 1e3) return (b / 1e3).toFixed(1) + ' KB'
  return b + ' B'
}

run().catch(err => {
  console.error('[FATAL]', err.message)
  process.exit(1)
})
