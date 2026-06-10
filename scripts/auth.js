#!/usr/bin/env node
// scripts/auth.js — (re)authorize the tagger's Google Drive access and exit.
//
// The OAuth app is in "Testing" publishing status, so Google expires its refresh
// token after ~7 days → calls start failing with `invalid_grant`. When that happens,
// delete/move data/token.json and run this to mint a fresh one. Opens a browser,
// waits for the consent redirect on localhost, saves data/token.json, exits.
//
//   node scripts/auth.js
//
// Authorize as the account that can see Vic's "Pics insta" folder
// (the one the folder is shared to).

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const fs = require('fs')
const http = require('http')
const { execSync } = require('child_process')
const { google } = require('googleapis')
const config = require('../config')

function waitForCode() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const qs = new URL(req.url, `http://localhost:${config.oauthPort}`).searchParams
      const code = qs.get('code')
      const err = qs.get('error')
      res.writeHead(200, { 'Content-Type': 'text/html' })
      if (code) {
        res.end('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>✓ Authorized</h2><p>Token saved. You can close this tab.</p></body></html>')
        server.close(); resolve(code)
      } else {
        res.end('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>Authorization failed</h2><p>' + (err || 'Unknown error') + '</p></body></html>')
        server.close(); reject(new Error('OAuth error: ' + err))
      }
    })
    server.listen(config.oauthPort, () => console.log(`[AUTH] Waiting for OAuth callback on http://localhost:${config.oauthPort} ...`))
    server.on('error', reject)
  })
}

;(async () => {
  const cred = JSON.parse(fs.readFileSync(config.oauthClientPath, 'utf8'))
  const { client_id, client_secret } = cred.installed
  const oAuth2 = new google.auth.OAuth2(client_id, client_secret, `http://localhost:${config.oauthPort}`)

  const authUrl = oAuth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',  // force a fresh refresh_token
    scope: ['https://www.googleapis.com/auth/drive']
  })

  console.log('\n[AUTH] Opening browser for Google authorization...')
  console.log('[AUTH] If it does not open automatically, visit:\n' + authUrl + '\n')
  try {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
    execSync(`${cmd} "${authUrl}"`)
  } catch {}

  const code = await waitForCode()
  const { tokens } = await oAuth2.getToken(code)
  fs.writeFileSync(config.tokenPath, JSON.stringify(tokens, null, 2))
  console.log(`[AUTH] Authorized. Token saved to ${config.tokenPath}`)
  process.exit(0)
})().catch(e => { console.error('[FATAL]', e.message); process.exit(1) })
