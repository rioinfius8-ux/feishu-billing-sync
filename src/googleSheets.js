const fs = require('fs');
const { google } = require('googleapis');

class GoogleSheet {
  constructor(config) {
    const key = JSON.parse(fs.readFileSync(config.keyFile, 'utf8'));
    const auth = new google.auth.JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    this.sheets = google.sheets({ version: 'v4', auth });
    this.spreadsheetId = config.spreadsheetId;
    this.sheetName = config.sheetName;
  }

  get range() {
    return `'${this.sheetName.replace(/'/g, "''")}'`;
  }

  /** Creates the tab if it doesn't exist yet. Returns its sheetId. */
  async ensureSheet() {
    const res = await this.sheets.spreadsheets.get({
      spreadsheetId: this.spreadsheetId,
      fields: 'sheets.properties(sheetId,title)',
    });
    const found = (res.data.sheets || []).find((s) => s.properties.title === this.sheetName);
    if (found) return found.properties.sheetId;
    const add = await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: this.sheetName } } }] },
    });
    return add.data.replies[0].addSheet.properties.sheetId;
  }

  /** Compact layout: single-line rows, bold frozen header, sensible column widths. */
  async formatSheet(sheetId, rowCount, colCount) {
    const ROW_HEIGHT = 24;
    const MAX_COL_WIDTH = 260;
    const MIN_COL_WIDTH = 80;
    const all = { sheetId };
    const header = { sheetId, startRowIndex: 0, endRowIndex: 1 };

    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests: [
          {
            repeatCell: {
              range: all,
              cell: { userEnteredFormat: { wrapStrategy: 'CLIP', verticalAlignment: 'MIDDLE' } },
              fields: 'userEnteredFormat(wrapStrategy,verticalAlignment)',
            },
          },
          {
            repeatCell: {
              range: header,
              cell: { userEnteredFormat: { textFormat: { bold: true } } },
              fields: 'userEnteredFormat.textFormat.bold',
            },
          },
          {
            updateSheetProperties: {
              properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
              fields: 'gridProperties.frozenRowCount',
            },
          },
          {
            updateDimensionProperties: {
              range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: rowCount },
              properties: { pixelSize: ROW_HEIGHT },
              fields: 'pixelSize',
            },
          },
          {
            autoResizeDimensions: {
              dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: colCount },
            },
          },
        ],
      },
    });

    // Clamp auto-sized column widths so long text doesn't make huge columns.
    const meta = await this.sheets.spreadsheets.get({
      spreadsheetId: this.spreadsheetId,
      ranges: [this.range],
      fields: 'sheets.data.columnMetadata.pixelSize',
    });
    const cols = meta.data.sheets[0].data[0].columnMetadata || [];
    const requests = [];
    cols.slice(0, colCount).forEach((c, i) => {
      const w = c.pixelSize || 100;
      const clamped = Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, w));
      if (clamped !== w) {
        requests.push({
          updateDimensionProperties: {
            range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
            properties: { pixelSize: clamped },
            fields: 'pixelSize',
          },
        });
      }
    });
    if (requests.length) {
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: { requests },
      });
    }
  }

  /** Replaces the whole tab with the given rows (first row = headers). */
  async replaceAll(rows) {
    const sheetId = await this.ensureSheet();
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
    const colCount = Math.max(...rows.map((r) => r.length));
    await this.formatSheet(sheetId, rows.length, colCount);
  }
}

module.exports = { GoogleSheet };
