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
   | `APPROVAL_CODE` | *(empty)* | Approval definition code. When set, the Feishu Approval API becomes the source of rows (see below). |
   | `APPROVAL_BACKFILL_FROM` | `2026-01-01T00:00:00+08:00` | Where the first approval scan starts |
   | `APPROVAL_STEPS` | *(empty)* | Step columns, as `Column=Approval node name;...` |
   | `HIDDEN_COLUMNS` | *(empty)* | Comma-separated column names to hide in Google Sheets |
   | `UNIQUE_KEY_FIELD` | *(empty)* | Feishu field used as a unique ID (e.g. `Request No.`). When set, imported rows update matching records instead of creating duplicates. |

3. **Grant access**
   - **Google:** share the spreadsheet with the service account's `client_email` (from the JSON key) as **Editor**.
   - **Feishu:** give the app Base (bitable) read/write permissions in the developer console, then add the app as a collaborator on the Base.

## Usage

```bash
npm start       # run continuously: watch imports/incoming and sync every N minutes
npm run once    # import pending files, sync once, then exit
npm run sync    # sync Feishu → Google Sheets only
npm test        # unit tests (no network)
```

Logs are printed to the console and written to `logs/sync-YYYY-MM-DD.log`.

## How it works

### Feishu Approval → Google Sheets (when `APPROVAL_CODE` is set)

When `APPROVAL_CODE` is set, the Feishu Approval API is the primary source of rows. Each sync:

1. **Lists instance codes.** Calls `GET /approval/v4/instances` in 10-hour creation-time windows (the documented maximum), following `page_token`. The first run backfills from `APPROVAL_BACKFILL_FROM`. Later runs resume from the saved cursor minus a 1-hour overlap.
2. **Fetches details.** Calls `GET /approval/v4/instances/:instance_id` for new instances and for any not yet in a final state (APPROVED, REJECTED, CANCELED or DELETED).
3. **Writes one row per instance.** Rows are keyed by `instance_code`, so an instance never appears twice. Each row is merged with its Feishu Base record when one exists, matched by the instance code in `SourceID`, then by serial number. Approval data fills:
   - `Request No.`
   - `Approval process`
   - `Status`
   - `Submitted at`
   - `Completed at`
   - `Requester`, only if the Base record doesn't already have it

   All other columns come from Base. Base records with no matching instance are kept as Base-only rows.
4. **Fills the step columns** from `APPROVAL_STEPS`:
   - Each step column shows the step's completion time, `Pending`, or blank if the step isn't in the flow.
   - `Status` is `Done` once every mapped step that appears in an approved instance is done. Otherwise it is `Pending`.

Progress and an instance cache are stored in `data/approval-state.json`, which is git-ignored. It is written atomically after every window, so an interrupted backfill resumes where it stopped. Delete the file to rebuild from scratch.

API calls retry with exponential backoff on rate limits, HTTP 429 and 5xx responses, and network errors. List calls are throttled below the 100 requests/min limit.

**Safety:** the tab is duplicated to a `… backup …` tab:
- before the first approval-based write
- whenever a sync would reduce the number of rows

Required Feishu app scope: `approval:approval:readonly`. Optional: a contact read scope such as `contact:user.base:readonly`, to fill requester names for requests not in Base.

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
  approval.js      Approval API listing/backfill, details, state, step columns
  feishu.js        Feishu Base client and value conversion
  googleSheets.js  Google Sheets client and tab formatting
imports/
  incoming/        drop Excel/CSV files here
  processed/       imported files
  failed/          files that failed to import
credentials/       service account key (git-ignored)
data/              approval sync state and cache (git-ignored)
test/              unit tests (node --test)
logs/              daily log files (git-ignored)
```

## Security

`.env`, `credentials/` and `logs/` are in `.gitignore`. Never commit the Feishu app secret or the Google service account key.
