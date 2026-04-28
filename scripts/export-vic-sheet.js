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
const DRIVE_FILE_NAME = 'clusters_for_vic.xlsx'

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

  // Build column list: fixed cols + one tickable col per job type
  const baseCols = [
    { header: '#',            key: 'idx',      width: 5 },
    { header: 'Suburb',       key: 'suburb',   width: 20 },
    { header: 'State',        key: 'state',    width: 7 },
    { header: 'Date',         key: 'date',     width: 12 },
    { header: 'Files',        key: 'count',    width: 7 },
    { header: 'Folder',       key: 'folder',   width: 14 },
    { header: 'Sample photo', key: 'sample',   width: 32 }
  ]
  const jobCols = config.jobTypes.map(jt => ({
    header: jt, key: 'jt_' + jt.replace(/\s+/g, '_'), width: 13
  }))
  const tailCols = [
    { header: 'Notes',  key: 'notes',  width: 32 },
    { header: 'Status', key: 'status', width: 14 }
  ]
  ws.columns = [...baseCols, ...jobCols, ...tailCols]
  styleHeader(ws.getRow(1))

  const sorted = [...report.clusters].sort((a, b) => b.fileCount - a.fileCount)

  sorted.forEach((c, i) => {
    const firstFile = c.files[0]
    const folderId = progress.tagged?.[firstFile.id]?.destFolderId
    const rowData = {
      idx: i + 1,
      suburb: c.suburb,
      state: c.state,
      date: c.date,
      count: c.fileCount,
      folder: '',
      sample: '',
      notes: '',
      status: ''
    }
    for (const jt of config.jobTypes) rowData['jt_' + jt.replace(/\s+/g, '_')] = false
    const row = ws.addRow(rowData)
    if (folderId) styleHyperlinkCell(row.getCell('folder'), driveFolderUrl(folderId), 'Open folder')
    styleHyperlinkCell(row.getCell('sample'), driveFileUrl(firstFile.id), firstFile.name)
  })

  // Filter spans header + ALL data rows so values populate in dropdown
  const lastRow = sorted.length + 1
  const lastCol = ws.columns.length
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: lastRow, column: lastCol } }

  // Data validation: TRUE/FALSE on each job-type column, list on Status
  const jobStartCol = baseCols.length + 1               // 8 (= H)
  const jobEndCol   = jobStartCol + config.jobTypes.length - 1  // 12 (= L)
  const statusCol   = lastCol                            // 14 (= N)
  const statusList  = '"Done,Skip,In Progress"'
  for (let r = 2; r <= lastRow; r++) {
    for (let c = jobStartCol; c <= jobEndCol; c++) {
      const cell = ws.getCell(r, c)
      cell.dataValidation = { type: 'list', allowBlank: true, formulae: ['"TRUE,FALSE"'] }
      cell.alignment = { horizontal: 'center' }
    }
    ws.getCell(r, statusCol).dataValidation = { type: 'list', allowBlank: true, formulae: [statusList] }
  }
}

function buildUngroupedSheet(wb, report) {
  const ws = wb.addWorksheet('Ungrouped', { views: [{ state: 'frozen', ySplit: 1 }] })

  const baseCols = [
    { header: '#',         key: 'idx',    width: 5 },
    { header: 'File name', key: 'name',   width: 36 },
    { header: 'MIME',      key: 'mime',   width: 14 },
    { header: 'Reason',    key: 'reason', width: 16 },
    { header: 'Photo',     key: 'photo',  width: 14 },
    { header: 'Suburb',    key: 'suburb', width: 18 },
    { header: 'Date',      key: 'date',   width: 12 }
  ]
  const jobCols = config.jobTypes.map(jt => ({
    header: jt, key: 'jt_' + jt.replace(/\s+/g, '_'), width: 13
  }))
  const tailCols = [
    { header: 'Notes',  key: 'notes',  width: 32 },
    { header: 'Status', key: 'status', width: 14 }
  ]
  ws.columns = [...baseCols, ...jobCols, ...tailCols]
  styleHeader(ws.getRow(1))

  const items = report.ungrouped || []
  items.forEach((u, i) => {
    const rowData = {
      idx: i + 1,
      name: u.name,
      mime: u.mimeType,
      reason: u.reason,
      photo: '',
      suburb: '', date: '', notes: '', status: ''
    }
    for (const jt of config.jobTypes) rowData['jt_' + jt.replace(/\s+/g, '_')] = false
    const row = ws.addRow(rowData)
    styleHyperlinkCell(row.getCell('photo'), driveFileUrl(u.id), 'Open')
  })

  const lastRow = items.length + 1
  const lastCol = ws.columns.length
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: lastRow, column: lastCol } }

  const jobStartCol = baseCols.length + 1
  const jobEndCol   = jobStartCol + config.jobTypes.length - 1
  const statusCol   = lastCol
  const statusList  = '"Done,Skip,In Progress"'
  for (let r = 2; r <= lastRow; r++) {
    for (let c = jobStartCol; c <= jobEndCol; c++) {
      const cell = ws.getCell(r, c)
      cell.dataValidation = { type: 'list', allowBlank: true, formulae: ['"TRUE,FALSE"'] }
      cell.alignment = { horizontal: 'center' }
    }
    ws.getCell(r, statusCol).dataValidation = { type: 'list', allowBlank: true, formulae: [statusList] }
  }
}

async function uploadToDrive(drive, localPath) {
  const existing = await drive.files.list({
    q: `name = '${DRIVE_FILE_NAME}' and '${config.sourceFolderId}' in parents and trashed = false`,
    fields: 'files(id)',
    pageSize: 1
  })

  const media = {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    body: fs.createReadStream(localPath)
  }

  if (existing.data.files && existing.data.files.length > 0) {
    const id = existing.data.files[0].id
    await drive.files.update({ fileId: id, media })
    return { id, replaced: true }
  }

  const created = await drive.files.create({
    requestBody: {
      name: DRIVE_FILE_NAME,
      parents: [config.sourceFolderId],
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    },
    media,
    fields: 'id'
  })
  return { id: created.data.id, replaced: false }
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

  console.log('  Uploading to Drive...')
  const auth  = await getAuth()
  const drive = google.drive({ version: 'v3', auth })
  const result = await uploadToDrive(drive, OUT_PATH)
  console.log(`  Drive       : ${result.replaced ? 'replaced' : 'created'} (id: ${result.id})`)
  console.log(`  Drive URL   : ${driveFileUrl(result.id)}\n`)
}

run().catch(err => { console.error('[FATAL]', err.message); process.exit(1) })
