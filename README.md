# TTP Asset Tagger

Tags and reorganizes The Truss People image dump into a structured Google Drive folder hierarchy.

## Stack
Node.js, Express, Google Drive API v3, vanilla HTML/CSS/JS

## Setup

```bash
npm install
cp .env.example .env
# Edit .env — set GOOGLE_SOURCE_FOLDER_ID and GOOGLE_OAUTH_CLIENT_PATH
node server.js
```

First run opens a browser for Google OAuth. Authorize once, token is saved.

Open **http://localhost:3000**

## How it works

1. Shows each image from the source GDrive folder
2. Vic enters suburb, state, job type, optional description
3. Click **Tag & Next** → file is moved to `/TTP Organized Assets/[Suburb STATE]/[Job Type]/`
4. Progress saved in `data/progress.json` — stop and resume any time

## Environment variables

| Variable | Description |
|----------|-------------|
| `GOOGLE_SOURCE_FOLDER_ID` | GDrive folder ID of the image dump |
| `GOOGLE_OAUTH_CLIENT_PATH` | Path to credentials.json (Google OAuth client) |
| `PORT` | Local server port (default: 3000) |

## Current status
Phase: Build complete
