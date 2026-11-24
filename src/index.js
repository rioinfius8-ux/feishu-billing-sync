const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { FeishuBase } = require('./feishu');
const { GoogleSheet } = require('./googleSheets');
const { SyncEngine } = require('./syncEngine');
const { ApprovalSteps, parseSteps } = require('./approval');

const ROOT = path.join(__dirname, '..');
const DIRS = {
  incoming: path.join(ROOT, 'imports', 'incoming'),
  processed: path.join(ROOT, 'imports', 'processed'),
  failed: path.join(ROOT, 'imports', 'failed'),
  logs: path.join(ROOT, 'logs'),
};
const SUPPORTED = /\.(xlsx|xls|csv)$/i;

// ---------- logger (console + logs/sync-YYYY-MM-DD.log) ----------

for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });

function write(level, msg) {
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${msg}`;
  (level === 'error' ? console.error : console.log)(line);
  const file = path.join(DIRS.logs, `sync-${new Date().toISOString().slice(0, 10)}.log`);
  fs.appendFileSync(file, line + '\n');
}
const logger = {
  info: (m) => write('info', m),
  warn: (m) => write('warn', m),
  error: (m) => write('error', m),
};

// ---------- config ----------

function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    logger.error(`Missing ${name} in .env`);
    process.exit(1);
  }
  return v.trim();
}

const config = {
  feishu: {
    appId: required('FEISHU_APP_ID'),
    appSecret: required('FEISHU_APP_SECRET'),
    appToken: required('FEISHU_APP_TOKEN'),
    tableId: required('FEISHU_TABLE_ID'),
    domain: (process.env.FEISHU_DOMAIN || 'feishu').toLowerCase(),
  },
  google: {
    spreadsheetId: required('GOOGLE_SPREADSHEET_ID'),
    keyFile: path.resolve(ROOT, required('GOOGLE_SERVICE_ACCOUNT_KEY_FILE')),
    sheetName: (process.env.GOOGLE_SHEET_NAME || 'Sheet1').trim(),
    hiddenColumns: (process.env.HIDDEN_COLUMNS || '').split(',').map((s) => s.trim()).filter(Boolean),
  },
  intervalMinutes: Number(process.env.SYNC_INTERVAL_MINUTES || 10),
  timeZone: process.env.TIMEZONE || 'Asia/Manila',
  uniqueKeyField: (process.env.UNIQUE_KEY_FIELD || '').trim(),
};

if (!fs.existsSync(config.google.keyFile)) {
  logger.error(`Google service account key not found: ${config.google.keyFile}`);
  process.exit(1);
}

const feishu = new FeishuBase(config.feishu);
const steps = parseSteps(process.env.APPROVAL_STEPS);
const approval = steps.length
  ? new ApprovalSteps({ client: feishu.client, steps, timeZone: config.timeZone, logger })
  : null;

const engine = new SyncEngine({
  feishu,
  approval,
  sheet: new GoogleSheet(config.google),
  logger,
  timeZone: config.timeZone,
  uniqueKeyField: config.uniqueKeyField,
  dirs: DIRS,
});

// ---------- run ----------

async function importPendingFiles() {
  const files = fs.readdirSync(DIRS.incoming).filter((f) => SUPPORTED.test(f) && !f.startsWith('~$'));
  let imported = 0;
  for (const f of files) {
    if (await engine.importFile(path.join(DIRS.incoming, f))) imported++;
  }
  return imported;
}

async function runOnce() {
  await engine.enqueue('import', importPendingFiles);
  await engine.enqueue('sync', () => engine.syncToSheet());
}

async function main() {
  const mode = process.argv[2];

  if (mode === '--once') {
    await runOnce();
    return;
  }
  if (mode === '--sync-only') {
    await engine.enqueue('sync', () => engine.syncToSheet());
    return;
  }

  logger.info(`Starting. Watching ${DIRS.incoming}; syncing every ${config.intervalMinutes} min.`);
  await runOnce();

  const chokidar = await import('chokidar');
  const watcher = chokidar.watch(DIRS.incoming, {
    ignoreInitial: true,
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 200 },
  });
  watcher.on('add', (file) => {
    const name = path.basename(file);
    if (!SUPPORTED.test(name) || name.startsWith('~$')) return;
    logger.info(`New file detected: ${name}`);
    engine.enqueue('import', async () => {
      if (await engine.importFile(file)) await engine.syncToSheet();
    });
  });

  setInterval(() => engine.enqueue('sync', () => engine.syncToSheet()), config.intervalMinutes * 60 * 1000);

  const stop = async () => {
    logger.info('Stopping...');
    await watcher.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  logger.error(err.stack || err.message);
  process.exit(1);
});
