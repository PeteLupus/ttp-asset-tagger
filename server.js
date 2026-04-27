const express = require('express')
const { google } = require('googleapis')
const fs = require('fs')
const path = require('path')
const http = require('http')
const { execSync } = require('child_process')
const config = require('./config')

if (!config.sourceFolderId) {
  console.error('[ERROR] GOOGLE_SOURCE_FOLDER_ID is not set in .env')
  process.exit(1)
}

const app = express()
app.use(express.json())
app.use(express.static('public'))

// ── State ──────────────────────────────────────────────────────────────────
let drive = null
let allFiles = []           // full file list from Drive (cached)
let folderCache = {}        // path string → folder ID cache
let destRootId = null       // ID of the "TTP Organized Assets" root folder

// ── Progress helpers ───────────────────────────────────────────────────────
function loadProgress() {
  try {
    return JSON.parse(fs.readFileSync(config.progressPath, 'utf8'))
  } catch {
    return { tagged: {}, skipped: [] }
  }
}

function saveProgress(p) {
  fs.writeFileSync(config.progressPath, JSON.stringify(p, null, 2))
}

// ── OAuth ──────────────────────────────────────────────────────────────────
async function authenticate() {
  const credRaw = fs.readFileSync(config.oauthClientPath, 'utf8')
  const cred = JSON.parse(credRaw)
  const { client_id, client_secret } = cred.installed
  const redirectUri = `http://localhost:${config.oauthPort}`

  const oAuth2 = new google.auth.OAuth2(client_id, client_secret, redirectUri)

  if (fs.existsSync(config.tokenPath)) {
    const token = JSON.parse(fs.readFileSync(config.tokenPath, 'utf8'))
    oAuth2.setCredentials(token)
    oAuth2.on('tokens', (t) => {
      if (t.refresh_token) token.refresh_token = t.refresh_token
      Object.assign(token, t)
      fs.writeFileSync(config.tokenPath, JSON.stringify(token, null, 2))
    })
    return oAuth2
  }

  const authUrl = oAuth2.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/drive']
  })

  console.log('\n[AUTH] Opening browser for Google authorization...')
  console.log('[AUTH] If it does not open automatically, visit:\n' + authUrl)

  try {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
    execSync(`${cmd} "${authUrl}"`)
  } catch {}

  const code = await waitForOAuthCode()
  const { tokens } = await oAuth2.getToken(code)
  oAuth2.setCredentials(tokens)
  fs.writeFileSync(config.tokenPath, JSON.stringify(tokens, null, 2))
  console.log('[AUTH] Authorized. Token saved.')
  return oAuth2
}

function waitForOAuthCode() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const qs = new URL(req.url, `http://localhost:${config.oauthPort}`).searchParams
      const code = qs.get('code')
      const err = qs.get('error')

      res.writeHead(200, { 'Content-Type': 'text/html' })
      if (code) {
        res.end('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>✓ Authorized</h2><p>You can close this tab and go back to the tagger.</p></body></html>')
        server.close()
        resolve(code)
      } else {
        res.end('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>Authorization failed</h2><p>' + (err || 'Unknown error') + '</p></body></html>')
        server.close()
        reject(new Error('OAuth error: ' + err))
      }
    })
    server.listen(config.oauthPort, () => {
      console.log(`[AUTH] Waiting for OAuth callback on port ${config.oauthPort}...`)
    })
    server.on('error', reject)
  })
}

// ── Drive helpers ──────────────────────────────────────────────────────────
async function getAllFolderIds(rootId) {
  const ids = [rootId]
  const queue = [rootId]
  while (queue.length) {
    const parentId = queue.shift()
    let pageToken = null
    do {
      const res = await drive.files.list({
        q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'nextPageToken, files(id, name)',
        pageSize: 200,
        pageToken: pageToken || undefined
      })
      for (const folder of res.data.files || []) {
        console.log(`[DRIVE] Found subfolder: ${folder.name}`)
        ids.push(folder.id)
        queue.push(folder.id)
      }
      pageToken = res.data.nextPageToken
    } while (pageToken)
  }
  return ids
}

async function loadAllFiles() {
  console.log('[DRIVE] Mapping folder tree...')
  const folderIds = await getAllFolderIds(config.sourceFolderId)
  console.log(`[DRIVE] Found ${folderIds.length} folder(s). Loading files...`)

  const files = []
  for (const folderId of folderIds) {
    let pageToken = null
    do {
      const res = await drive.files.list({
        q: `'${folderId}' in parents and (mimeType contains 'image/' or mimeType contains 'video/') and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, size)',
        pageSize: 200,
        pageToken: pageToken || undefined
      })
      files.push(...(res.data.files || []))
      pageToken = res.data.nextPageToken
    } while (pageToken)
  }

  console.log(`[DRIVE] Found ${files.length} images/videos across all folders.`)
  return files
}

async function ensureFolder(name, parentId) {
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
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId]
    },
    fields: 'id'
  })
  folderCache[key] = created.data.id
  return folderCache[key]
}

async function getOrCreateDestRoot() {
  if (destRootId) return destRootId

  const res = await drive.files.list({
    q: `name = '${config.destinationRootName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id)',
    pageSize: 1
  })

  if (res.data.files && res.data.files.length > 0) {
    destRootId = res.data.files[0].id
  } else {
    const created = await drive.files.create({
      requestBody: {
        name: config.destinationRootName,
        mimeType: 'application/vnd.google-apps.folder'
      },
      fields: 'id'
    })
    destRootId = created.data.id
    console.log(`[DRIVE] Created destination root folder: ${config.destinationRootName}`)
  }
  return destRootId
}

async function moveFile(fileId, destFolderId) {
  const file = await drive.files.get({ fileId, fields: 'parents' })
  const prevParents = (file.data.parents || []).join(',')
  await drive.files.update({
    fileId,
    addParents: destFolderId,
    removeParents: prevParents,
    fields: 'id, parents'
  })
}

// ── Routes ─────────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({ jobTypes: config.jobTypes, defaultState: config.defaultState })
})

app.get('/api/progress', (req, res) => {
  const p = loadProgress()
  const done = Object.keys(p.tagged).length
  const skipped = p.skipped.length
  const total = allFiles.length
  res.json({ total, done, skipped, remaining: total - done - skipped })
})

app.get('/api/next', (req, res) => {
  const p = loadProgress()
  const processed = new Set([...Object.keys(p.tagged), ...p.skipped])
  const next = allFiles.find(f => !processed.has(f.id))
  if (!next) return res.json({ done: true })
  res.json({ file: next })
})

app.get('/api/image/:id', async (req, res) => {
  try {
    const response = await drive.files.get(
      { fileId: req.params.id, alt: 'media' },
      { responseType: 'stream' }
    )
    const mimeType = response.headers['content-type'] || 'image/jpeg'
    res.setHeader('Content-Type', mimeType)
    res.setHeader('Cache-Control', 'private, max-age=3600')
    response.data.pipe(res)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/tag', async (req, res) => {
  const { fileId, suburb, state, jobType, description } = req.body
  if (!fileId || !suburb || !state || !jobType) {
    return res.status(400).json({ error: 'fileId, suburb, state, jobType are required' })
  }

  try {
    const rootId = await getOrCreateDestRoot()
    const locationLabel = `${suburb.trim()} ${state.trim()}`
    const locationFolderId = await ensureFolder(locationLabel, rootId)
    const typeFolderId = await ensureFolder(jobType, locationFolderId)

    await moveFile(fileId, typeFolderId)

    const p = loadProgress()
    p.tagged[fileId] = {
      suburb: suburb.trim(),
      state: state.trim(),
      jobType,
      description: (description || '').trim(),
      destFolderId: typeFolderId,
      taggedAt: new Date().toISOString()
    }
    saveProgress(p)

    res.json({ ok: true })
  } catch (err) {
    console.error('[TAG ERROR]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Dedup helpers ──────────────────────────────────────────────────────────
function loadDedupProgress() {
  try { return JSON.parse(fs.readFileSync(config.dedupProgressPath, 'utf8')) }
  catch { return { decided: [] } }
}

function saveDedupProgress(p) {
  fs.writeFileSync(config.dedupProgressPath, JSON.stringify(p, null, 2))
}

function getDedupPairs() {
  const report = JSON.parse(fs.readFileSync(config.dedupReportPath, 'utf8'))
  const pairs = []
  for (const group of report.duplicate_groups || []) {
    const keepFile = group.files.find(f => f.id === group.keep_id)
    for (const killId of group.kill_ids) {
      const killFile = group.files.find(f => f.id === killId)
      if (keepFile && killFile) pairs.push({ keepFile, killFile })
    }
  }
  return pairs
}

app.get('/api/dedup', (req, res) => {
  const pairs = getDedupPairs()
  const prog = loadDedupProgress()
  const decided = new Set(prog.decided)
  const total = pairs.length
  const pending = pairs.filter(p => !decided.has(p.killFile.id))
  res.json({ total, remaining: pending.length, next: pending[0] || null })
})

app.post('/api/dedup/trash', async (req, res) => {
  const { killId } = req.body
  if (!killId) return res.status(400).json({ error: 'killId required' })
  try {
    await drive.files.update({ fileId: killId, requestBody: { trashed: true } })
    const prog = loadDedupProgress()
    if (!prog.decided.includes(killId)) prog.decided.push(killId)
    saveDedupProgress(prog)
    res.json({ ok: true })
  } catch (err) {
    console.error('[DEDUP TRASH ERROR]', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/dedup/trash-all', (req, res) => {
  res.status(410).json({ error: 'trash-all disabled — use scripts/cull.js (move-based) instead' })
})

app.post('/api/dedup/keep', (req, res) => {
  const { killId } = req.body
  if (!killId) return res.status(400).json({ error: 'killId required' })
  const prog = loadDedupProgress()
  if (!prog.decided.includes(killId)) prog.decided.push(killId)
  saveDedupProgress(prog)
  res.json({ ok: true })
})

// ── Cluster (batch-tag) helpers ────────────────────────────────────────────
function loadClusterReport() {
  try { return JSON.parse(fs.readFileSync(config.clusterReportPath, 'utf8')) }
  catch { return null }
}

function loadClusterProgress() {
  try { return JSON.parse(fs.readFileSync(config.clusterProgressPath, 'utf8')) }
  catch { return { tagged: [], skipped: [] } }
}

function saveClusterProgress(p) {
  fs.writeFileSync(config.clusterProgressPath, JSON.stringify(p, null, 2))
}

function getActiveClusters() {
  const report = loadClusterReport()
  if (!report) return null
  const cprog = loadClusterProgress()
  const fprog = loadProgress()
  const taggedFiles = new Set(Object.keys(fprog.tagged))
  const decided = new Set([...cprog.tagged, ...cprog.skipped])

  return report.clusters
    .filter(c => !decided.has(c.id))
    .map(c => ({
      ...c,
      files: c.files.filter(f => !taggedFiles.has(f.id))
    }))
    .filter(c => c.files.length > 0)
}

app.get('/api/clusters', (req, res) => {
  const report = loadClusterReport()
  if (!report) return res.json({ available: false })
  const cprog = loadClusterProgress()
  const active = getActiveClusters() || []
  const next = active[0] || null
  res.json({
    available: true,
    total: report.clusters.length,
    tagged: cprog.tagged.length,
    skipped: cprog.skipped.length,
    remaining: active.length,
    next
  })
})

app.post('/api/clusters/tag', async (req, res) => {
  const { clusterId, suburb, state, jobType, description } = req.body
  if (!clusterId || !suburb || !state || !jobType) {
    return res.status(400).json({ error: 'clusterId, suburb, state, jobType are required' })
  }
  const report = loadClusterReport()
  const cluster = report?.clusters.find(c => c.id === clusterId)
  if (!cluster) return res.status(404).json({ error: 'cluster not found' })

  try {
    const rootId = await getOrCreateDestRoot()
    const locationLabel = `${suburb.trim()} ${state.trim()}`
    const locationFolderId = await ensureFolder(locationLabel, rootId)
    const typeFolderId = await ensureFolder(jobType, locationFolderId)

    const fprog = loadProgress()
    let moved = 0, errors = 0, skipped = 0

    for (const file of cluster.files) {
      if (fprog.tagged[file.id]) { skipped++; continue }
      try {
        await moveFile(file.id, typeFolderId)
        fprog.tagged[file.id] = {
          suburb: suburb.trim(),
          state: state.trim(),
          jobType,
          description: (description || '').trim(),
          destFolderId: typeFolderId,
          taggedAt: new Date().toISOString(),
          via: 'cluster',
          clusterId
        }
        moved++
      } catch (err) {
        console.error('[CLUSTER TAG]', file.name, err.message)
        errors++
      }
    }
    saveProgress(fprog)

    const cprog = loadClusterProgress()
    if (!cprog.tagged.includes(clusterId)) cprog.tagged.push(clusterId)
    saveClusterProgress(cprog)

    res.json({ ok: true, moved, skipped, errors })
  } catch (err) {
    console.error('[CLUSTER TAG ERROR]', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/clusters/skip', (req, res) => {
  const { clusterId } = req.body
  if (!clusterId) return res.status(400).json({ error: 'clusterId required' })
  const cprog = loadClusterProgress()
  if (!cprog.skipped.includes(clusterId)) cprog.skipped.push(clusterId)
  saveClusterProgress(cprog)
  res.json({ ok: true })
})

app.post('/api/skip', (req, res) => {
  const { fileId } = req.body
  if (!fileId) return res.status(400).json({ error: 'fileId required' })
  const p = loadProgress()
  if (!p.skipped.includes(fileId)) p.skipped.push(fileId)
  saveProgress(p)
  res.json({ ok: true })
})

// ── Boot ───────────────────────────────────────────────────────────────────
async function boot() {
  console.log('[BOOT] TTP Asset Tagger starting...')

  const auth = await authenticate()
  drive = google.drive({ version: 'v3', auth })
  allFiles = await loadAllFiles()

  const p = loadProgress()
  const done = Object.keys(p.tagged).length
  const skipped = p.skipped.length
  console.log(`[BOOT] Progress: ${done} tagged, ${skipped} skipped, ${allFiles.length - done - skipped} remaining`)

  app.listen(config.port, () => {
    console.log(`\n[READY] Open http://localhost:${config.port} in your browser\n`)
  })
}

boot().catch(err => {
  console.error('[FATAL]', err.message)
  process.exit(1)
})
