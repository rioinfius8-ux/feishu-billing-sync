const fs = require('fs');
const { google } = require('googleapis');

class GoogleSheet {
  constructor(config) {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(fs.readFileSync(config.keyFile, 'utf8')),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    this.sheets = google.sheets({ version: 'v4', auth });
    this.spreadsheetId = config.spreadsheetId;
    this.sheetName = config.sheetName;
  }

  get range() {
    return `'${this.sheetName.replace(/'/g, "''")}'`;
  }

  /** Creates the tab if it doesn't exist yet. */
  async ensureSheet() {
    const res = await this.sheets.spreadsheets.get({
      spreadsheetId: this.spreadsheetId,
      fields: 'sheets.properties.title',
    });
    const exists = (res.data.sheets || []).some((s) => s.properties.title === this.sheetName);
    if (!exists) {
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: this.sheetName } } }] },
      });
    }
  }

  /** Replaces the whole tab with the given rows (first row = headers). */
  async replaceAll(rows) {
    await this.ensureSheet();
    await this.sheets.spreadsheets.values.clear({
      spreadsheetId: this.spreadsheetId,
      range: this.range,
    });
    if (rows.length === 0) return;
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${this.range}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: rows },
    });
  }
}

module.exports = { GoogleSheet };
