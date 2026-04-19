require('dotenv').config()

module.exports = {
  sourceFolderId: process.env.GOOGLE_SOURCE_FOLDER_ID,
  oauthClientPath: process.env.GOOGLE_OAUTH_CLIENT_PATH || require('path').join(__dirname, 'data', 'credentials.json'),
  tokenPath: require('path').join(__dirname, 'data', 'token.json'),
  progressPath: require('path').join(__dirname, 'data', 'progress.json'),
  destinationRootName: 'TTP Organized Assets',
  port: process.env.PORT || 3000,
  oauthPort: 3001,
  jobTypes: [
    'Trusses',
    'Wall Frames',
    'Floor Joists',
    'Steelwood',
    'Crane Rental',
    'Delivery',
    'Other'
  ],
  defaultState: 'VIC'
}
