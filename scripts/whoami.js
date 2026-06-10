// Diagnostic: which account, and a FULL recursive image+GPS census of the source folder.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const fs = require('fs')
const { google } = require('googleapis')
const config = require('../config')

async function census(drive, rootId) {
  let images = 0, withGPS = 0, withDate = 0, folders = 0
  const perFolder = {}
  async function walk(id, label) {
    let pageToken
    do {
      const res = await drive.files.list({
        q: `'${id}' in parents and trashed=false`,
        fields: 'nextPageToken, files(id,name,mimeType,imageMediaMetadata(location,time))',
        pageSize: 500, pageToken,
        includeItemsFromAllDrives: true, supportsAllDrives: true,
      })
      for (const f of res.data.files || []) {
        if (f.mimeType === 'application/vnd.google-apps.folder') { folders++; await walk(f.id, f.name) }
        else if ((f.mimeType || '').startsWith('image/')) {
          images++; perFolder[label] = (perFolder[label] || 0) + 1
          const m = f.imageMediaMetadata
          if (m && m.location && typeof m.location.latitude === 'number') withGPS++
          if (m && m.time) withDate++
        }
      }
      pageToken = res.data.nextPageToken
    } while (pageToken)
  }
  await walk(rootId, '(root)')
  return { images, withGPS, withDate, folders, perFolder }
}

;(async () => {
  const cred = JSON.parse(fs.readFileSync(config.oauthClientPath, 'utf8')).installed
  const oa = new google.auth.OAuth2(cred.client_id, cred.client_secret, `http://localhost:${config.oauthPort}`)
  oa.setCredentials(JSON.parse(fs.readFileSync(config.tokenPath, 'utf8')))
  const drive = google.drive({ version: 'v3', auth: oa })

  const about = await drive.about.get({ fields: 'user(emailAddress,displayName)' })
  console.log('AUTHORIZED AS:', about.data.user.emailAddress)

  const c = await census(drive, config.sourceFolderId)
  console.log(`RECURSIVE CENSUS of ${config.sourceFolderId}:`)
  console.log(`  subfolders: ${c.folders}`)
  console.log(`  images: ${c.images} | withGPS: ${c.withGPS} | withDate(EXIF): ${c.withDate}`)
  console.log('  images per folder:')
  for (const [k, v] of Object.entries(c.perFolder).sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log(`    ${String(v).padStart(4)}  ${k}`)
  }
})().catch(e => console.error('ERR', e.message))
