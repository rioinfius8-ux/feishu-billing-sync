# feishu-billing-sync

Keeps billing / payment request data in sync between **Feishu Base (多维表格)** and **Google Sheets**.

- **Feishu Base → Google Sheets.** Copies every record of a Feishu Base table into a Google Sheets tab. Runs on start, every N minutes, and after each import.
- **Excel/CSV → Feishu Base.** Picks up `.xlsx`, `.xls` or `.csv` files dropped into `imports/incoming/` and adds their rows to the Feishu table.

## Requirements

- Node.js 20 or newer
- A Feishu self-built app with Base (bitable) permissions
- A Google Cloud service account with the Google Sheets API enabled

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Configure the environment.** Copy `.env.example` to `.env` and fill it in:

   | Variable | Where to get it |
   | --- | --- |
   | `FEISHU_APP_ID`, `FEISHU_APP_SECRET` | Feishu developer console (open.feishu.cn) → your app → Credentials |
   | `FEISHU_APP_TOKEN` | Base URL: `https://xxx.feishu.cn/base/<APP_TOKEN>?table=...` |
   | `FEISHU_TABLE_ID` | Base URL: `...?table=<TABLE_ID>&view=...` |
   | `GOOGLE_SPREADSHEET_ID` | Sheet URL: `https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit` |
   | `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` | Path to the service account JSON key (default `./credentials/google-service-account.json`) |
   | `GOOGLE_SHEET_NAME` | Name of the tab to write to (created if missing) |

   Optional:

   | Variable | Default | Meaning |
   | --- | --- | --- |
   | `FEISHU_DOMAIN` | `feishu` | Use `lark` for larksuite.com tenants |
   | `SYNC_INTERVAL_MINUTES` | `10` | How often to sync Feishu to Google Sheets |
   | `TIMEZONE` | `Asia/Manila` | Time zone used to format dates |
   | `UNIQUE_KEY_FIELD` | *(empty)* | Feishu field used as a unique ID (e.g. `Request No.`). When set, imported rows update matching records instead of creating duplicates. |

3. **Grant access**
   - **Google:** share the spreadsheet with the service account's `client_email` (from the JSON key) as **Editor**.
   - **Feishu:** give the app Base (bitable) read/write permissions in the developer console, then add the app as a collaborator on the Base.

## Usage

```bash
npm start       # run continuously: watch imports/incoming and sync every N minutes
npm run once    # import pending files, sync once, then exit
npm run sync    # sync Feishu → Google Sheets only
```

Logs are printed to the console and written to `logs/sync-YYYY-MM-DD.log`.

## How it works

### Feishu Base → Google Sheets

- The target tab is **cleared and fully rewritten** on every sync. Don't use it for manual notes; put those in another tab.
- Columns follow the field order of the Feishu table, and the header row is the list of field names.
- Values are flattened to plain text:
  - dates use the field's format in `TIMEZONE`
  - users, links and attachments become their names
  - checkboxes become `TRUE` or `FALSE`
- The tab is formatted after each sync: fixed row height, text clipped instead of wrapped, bold frozen header, and column widths between 80 and 260 px.

### Excel/CSV → Feishu Base

- Only the **first sheet** of each file is read.
- The **first row must be headers matching Feishu field names.** Matching ignores case and extra spaces. Columns that don't match, or that are read-only in Feishu (formula, lookup, created time, user, attachment, link), are skipped and logged.
- Values are converted to the field type:
  - numbers: commas and currency symbols are stripped
  - dates: converted to Feishu timestamps
  - checkboxes: `yes`, `true` and `1` count as checked
  - multi-select: split on `,` or `;`
- Successful files are moved to `imports/processed/`. Failed files go to `imports/failed/`. Both get a timestamp prefix.

## Project structure

```
src/
  index.js         entry point: config, logger, file watcher, schedule
  syncEngine.js    import (file → Feishu) and sync (Feishu → Sheets) logic
  feishu.js        Feishu Base client and value conversion
  googleSheets.js  Google Sheets client and tab formatting
imports/
  incoming/        drop Excel/CSV files here
  processed/       imported files
  failed/          files that failed to import
credentials/       service account key (git-ignored)
logs/              daily log files (git-ignored)
```

## Security

`.env`, `credentials/` and `logs/` are in `.gitignore`. Never commit the Feishu app secret or the Google service account key.
