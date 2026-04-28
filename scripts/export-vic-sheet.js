#!/usr/bin/env node
'use strict'

// scripts/export-vic-sheet.js — write data/clusters_for_vic.xlsx and upload
// to the source Drive folder. Pure read of cluster_report.json + progress.json.
// Vic uses this as a punch-list in Excel.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { google } = require('googleapis')
const ExcelJS = require('exceljs')
const fs   = require('fs')
const path = require('path')
const config = require('../config')

const ROOT_DIR        = path.join(__dirname, '..')
const REPORT_PATH     = config.clusterReportPath
const PROGRESS_PATH   = config.progressPath
const OUT_PATH        = path.join(ROOT_DIR, 'data', 'clusters_for_vic.xlsx')
const DRIVE_FILE_NAME = 'clusters_for_vic'  // becomes a native Google Sheet

// ── Auth (same shape as cull.js / cluster-tag-all.js) ─────────────────────────
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

function driveFolderUrl(id) { return `https://drive.google.com/drive/folders/${id}` }
function driveFileUrl(id)   { return `https://drive.google.com/file/d/${id}/view` }

function styleHeader(row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } }
  row.alignment = { vertical: 'middle' }
  row.height = 22
}

function styleHyperlinkCell(cell, url, label) {
  cell.value = { text: label, hyperlink: url }
  cell.font = { color: { argb: 'FF2563EB' }, underline: 'single' }
}

function buildClusterSheet(wb, report, progress) {
  const ws = wb.addWorksheet('Clusters', { views: [{ state: 'frozen', ySplit: 1 }] })

  ws.columns = [
    { header: '#',            key: 'idx',      width: 5 },
    { header: 'Suburb',       key: 'suburb',   width: 20 },
    { header: 'State',        key: 'state',    width: 7 },
    { header: 'Date',         key: 'date',     width: 12 },
    { header: 'Files',        key: 'count',    width: 7 },
    { header: 'Folder',       key: 'folder',   width: 14 },
    { header: 'Sample photo', key: 'sample',   width: 32 },
    { header: 'Job Type',     key: 'jobType',  width: 32 },
    { header: 'Notes',        key: 'notes',    width: 32 },
    { header: 'Status',       key: 'status',   width: 14 }
  ]
  styleHeader(ws.getRow(1))

  const sorted = [...report.clusters].sort((a, b) => b.fileCount - a.fileCount)

  sorted.forEach((c, i) => {
    const firstFile = c.files[0]
    const folderId = progress.tagged?.[firstFile.id]?.destFolderId
    const row = ws.addRow({
      idx: i + 1,
      suburb: c.suburb,
      state: c.state,
      date: c.date,
      count: c.fileCount,
      folder: '',
      sample: '',
      jobType: '',
      notes: '',
      status: ''
    })
    if (folderId) styleHyperlinkCell(row.getCell('folder'), driveFolderUrl(folderId), 'Open folder')
    styleHyperlinkCell(row.getCell('sample'), driveFileUrl(firstFile.id), firstFile.name)
  })

  const lastRow = sorted.length + 1
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: lastRow, column: ws.columns.length } }

  const jobList    = `"${config.jobTypes.join(',')}"`
  const statusList = '"Done,Skip,In Progress"'
  for (let r = 2; r <= lastRow; r++) {
    ws.getCell(`H${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: [jobList] }
    ws.getCell(`J${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: [statusList] }
  }
}

function buildUngroupedSheet(wb, report) {
  const ws = wb.addWorksheet('Ungrouped', { views: [{ state: 'frozen', ySplit: 1 }] })

  ws.columns = [
    { header: '#',         key: 'idx',     width: 5 },
    { header: 'File name', key: 'name',    width: 36 },
    { header: 'MIME',      key: 'mime',    width: 14 },
    { header: 'Reason',    key: 'reason',  width: 16 },
    { header: 'Photo',     key: 'photo',   width: 14 },
    { header: 'Suburb',    key: 'suburb',  width: 18 },
    { header: 'Date',      key: 'date',    width: 12 },
    { header: 'Job Type',  key: 'jobType', width: 32 },
    { header: 'Notes',     key: 'notes',   width: 32 },
    { header: 'Status',    key: 'status',  width: 14 }
  ]
  styleHeader(ws.getRow(1))

  const items = report.ungrouped || []
  items.forEach((u, i) => {
    const row = ws.addRow({
      idx: i + 1,
      name: u.name,
      mime: u.mimeType,
      reason: u.reason,
      photo: '',
      suburb: '', date: '', jobType: '', notes: '', status: ''
    })
    styleHyperlinkCell(row.getCell('photo'), driveFileUrl(u.id), 'Open')
  })

  const lastRow = items.length + 1
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: lastRow, column: ws.columns.length } }

  const jobList    = `"${config.jobTypes.join(',')}"`
  const statusList = '"Done,Skip,In Progress"'
  for (let r = 2; r <= lastRow; r++) {
    ws.getCell(`H${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: [jobList] }
    ws.getCell(`J${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: [statusList] }
  }
}

async function uploadToDrive(drive, localPath) {
  // Find any existing copy (Sheet OR xlsx) so we can supersede it
  const existing = await drive.files.list({
    q: `(name = '${DRIVE_FILE_NAME}' or name = '${DRIVE_FILE_NAME}.xlsx') and '${config.sourceFolderId}' in parents and trashed = false`,
    fields: 'files(id, name, mimeType)',
    pageSize: 5
  })
  for (const f of existing.data.files || []) {
    await drive.files.update({ fileId: f.id, requestBody: { trashed: true } }).catch(() => {})
  }

  // Create as native Google Sheet (Drive auto-converts the uploaded xlsx body)
  const created = await drive.files.create({
    requestBody: {
      name: DRIVE_FILE_NAME,
      parents: [config.sourceFolderId],
      mimeType: 'application/vnd.google-apps.spreadsheet'
    },
    media: {
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body: fs.createReadStream(localPath)
    },
    fields: 'id'
  })
  return { id: created.data.id }
}

// Apply multi-select dropdown to Job Type column on both sheets
async function applyMultiSelectValidation(sheets, spreadsheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties(sheetId,title,gridProperties))' })
  const requests = []

  for (const s of meta.data.sheets) {
    const sheetId = s.properties.sheetId
    const title   = s.properties.title
    const rowCount = s.properties.gridProperties.rowCount
    // Job Type column is H (index 7) on both sheets per ws.columns above
    const jobCol = 7

    requests.push({
      setDataValidation: {
        range: { sheetId, startRowIndex: 1, endRowIndex: rowCount, startColumnIndex: jobCol, endColumnIndex: jobCol + 1 },
        rule: {
          condition: {
            type: 'ONE_OF_LIST',
            values: config.jobTypes.map(v => ({ userEnteredValue: v }))
          },
          showCustomUi: true,
          strict: false
        }
      }
    })
  }

  if (requests.length) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } })
  }
}

async function run() {
  console.log('\n╔══════════════════════════════════════════╗')
  console.log('║   TTP Asset Tagger — Vic Excel Export   ║')
  console.log('╚══════════════════════════════════════════╝\n')

  const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'))
  const progress = (() => {
    try { return JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8')) }
    catch { return { tagged: {} } }
  })()

  console.log(`  Clusters    : ${report.clusters.length}`)
  console.log(`  Ungrouped   : ${(report.ungrouped || []).length}`)

  const wb = new ExcelJS.Workbook()
  wb.creator = 'ttp-asset-tagger'
  wb.created = new Date()
  buildClusterSheet(wb, report, progress)
  buildUngroupedSheet(wb, report)

  await wb.xlsx.writeFile(OUT_PATH)
  console.log(`\n  Local file  : ${OUT_PATH}`)

  console.log('  Uploading to Drive (as Google Sheet)...')
  const auth  = await getAuth()
  const drive  = google.drive({ version: 'v3', auth })
  const sheets = google.sheets({ version: 'v4', auth })
  const result = await uploadToDrive(drive, OUT_PATH)
  console.log(`  Drive       : created Google Sheet (id: ${result.id})`)

  // Try Sheets API for programmatic multi-select; fall back gracefully if API blocked.
  try {
    await applyMultiSelectValidation(sheets, result.id)
    console.log('  Multi-select validation applied via Sheets API.')
  } catch (err) {
    if (/has not been used|has not been enabled|disabled/i.test(err.message)) {
      console.log('  Sheets API unavailable — Job Type ships as single-select dropdown.')
      console.log('  Vic toggles multi-select once: column H header → Data → Data validation')
      console.log('  → edit rule → check "Allow multiple values" → save.')
    } else {
      throw err
    }
  }
  console.log(`  Sheet URL   : https://docs.google.com/spreadsheets/d/${result.id}/edit\n`)
}

run().catch(err => { console.error('[FATAL]', err.message); process.exit(1) })
