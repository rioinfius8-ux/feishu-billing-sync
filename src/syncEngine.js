const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { FieldType, WRITABLE_TYPES, toPlainValue } = require('./feishu');
const { instanceCodeFromBase, formatDateTime, STATUS_LABEL } = require('./approval');

class SyncEngine {
  constructor({ feishu, sheet, logger, timeZone, uniqueKeyField, dirs, approval }) {
    this.feishu = feishu;
    this.approval = approval || null;
    this.sheet = sheet;
    this.log = logger;
    this.timeZone = timeZone;
    this.uniqueKeyField = uniqueKeyField || null;
    this.dirs = dirs;
    this.queue = Promise.resolve(); // run jobs one at a time
  }

  enqueue(name, job) {
    const run = this.queue.then(async () => {
      try {
        await job();
      } catch (err) {
        this.log.error(`${name} failed: ${err.message}`);
      }
    });
    this.queue = run;
    return run;
  }

  // ---------- Feishu Base -> Google Sheets ----------

  async syncToSheet() {
    const fields = await this.feishu.listFields();
    const records = await this.feishu.listRecords();

    const header = fields.map((f) => f.field_name);
    const baseRow = (r) => fields.map((f) => toSheetValue(r.fields[f.field_name], f, this.timeZone));

    let rows;
    if (this.approval) {
      const extraCodes = records.map((r) => instanceCodeFromBase(r.fields)).filter(Boolean);
      const instances = await this.approval.sync({ extraCodes });
      const fieldByName = new Map(fields.map((f) => [f.field_name, f]));
      const formatValue = (name, raw) => {
        const f = fieldByName.get(name);
        return f ? toSheetValue(raw, f, this.timeZone) : toPlainValue(raw, null, this.timeZone);
      };
      rows = buildApprovalRows({ header, records, instances, baseRow, approval: this.approval, formatValue });
      header.push(...this.approval.columns);
    } else {
      rows = records.map(baseRow);
    }

    await this.safeReplace([header, ...rows]);
    this.lastSyncedRows = rows.length;
    this.log.info(`Synced ${rows.length} row(s) to Google Sheets (${records.length} Base record(s) merged).`);
  }

  /** Backs up the tab before the first approval-based write, and whenever the row count would shrink. */
  async safeReplace(rows) {
    const existing = await this.sheet.countDataRows();
    const incoming = rows.length - 1;
    const state = this.approval && this.approval.state;
    const firstMigration = state && !state.sheetMigratedAt;
    if (existing > 0 && (firstMigration || incoming < existing)) {
      const reason = firstMigration ? 'pre-approval-migration' : `rows-${existing}-to-${incoming}`;
      const title = await this.sheet.backupTab(reason);
      this.log.warn(`Backed up "${this.sheet.sheetName}" to "${title}" before writing (${reason}).`);
    }
    await this.sheet.replaceAll(rows);
    if (firstMigration) {
      state.sheetMigratedAt = new Date().toISOString();
      this.approval.saveState();
    }
  }

  // ---------- Excel/CSV file -> Feishu Base ----------

  async importFile(filePath) {
    const name = path.basename(filePath);
    try {
      const fields = await this.feishu.listFields();
      const rows = readSpreadsheet(filePath);
      const { records, ignoredColumns } = this.mapRows(rows, fields);

      if (ignoredColumns.length) {
        this.log.warn(`${name}: ignored columns not found/writable in Feishu: ${ignoredColumns.join(', ')}`);
      }
      if (records.length === 0) throw new Error('no usable rows found');

      const { created, updated } = await this.saveRecords(records, fields);
      this.log.info(`${name}: imported ${created} new, updated ${updated} existing record(s).`);
      moveFile(filePath, this.dirs.processed);
      return true;
    } catch (err) {
      this.log.error(`${name}: import failed: ${err.message}`);
      moveFile(filePath, this.dirs.failed);
      return false;
    }
  }

  mapRows(rows, fields) {
    const byName = new Map(fields.map((f) => [normalize(f.field_name), f]));
    const columns = rows.length ? Object.keys(rows[0]) : [];
    const ignoredColumns = [];
    const colMap = [];

    for (const col of columns) {
      const field = byName.get(normalize(col));
      if (field && WRITABLE_TYPES.has(field.type)) colMap.push([col, field]);
      else ignoredColumns.push(col);
    }

    const records = [];
    for (const row of rows) {
      const out = {};
      for (const [col, field] of colMap) {
        const v = coerce(row[col], field);
        if (v !== undefined) out[field.field_name] = v;
      }
      if (Object.keys(out).length) records.push(out);
    }
    return { records, ignoredColumns };
  }

  async saveRecords(records, fields) {
    const keyField = this.uniqueKeyField && fields.find((f) => f.field_name === this.uniqueKeyField);
    if (this.uniqueKeyField && !keyField) {
      throw new Error(`UNIQUE_KEY_FIELD "${this.uniqueKeyField}" does not exist in the Feishu table`);
    }
    if (!keyField) {
      await this.feishu.createRecords(records);
      return { created: records.length, updated: 0 };
    }

    // Update rows whose key already exists, create the rest.
    const existing = new Map();
    for (const r of await this.feishu.listRecords()) {
      const key = String(toPlainValue(r.fields[keyField.field_name], keyField, this.timeZone)).trim();
      if (key) existing.set(key, r.record_id);
    }

    const toCreate = [];
    const toUpdate = new Map(); // record_id -> fields (last row wins)
    for (const rec of records) {
      const key = String(rec[keyField.field_name] ?? '').trim();
      const id = key && existing.get(key);
      if (id) toUpdate.set(id, rec);
      else toCreate.push(rec);
    }

    if (toCreate.length) await this.feishu.createRecords(toCreate);
    if (toUpdate.size) {
      await this.feishu.updateRecords([...toUpdate].map(([record_id, f]) => ({ record_id, fields: f })));
    }
    return { created: toCreate.length, updated: toUpdate.size };
  }
}

// ---------- helpers ----------

// Existing sheet columns that the Approval API fills (approval data wins over Base data).
const APPROVAL_FIELD_COLUMNS = {
  requestNo: 'Request No.',
  approvalName: 'Approval process',
  status: 'Status',
  submitted: 'Submitted at',
  completed: 'Completed at',
  requester: 'Requester',
};

/**
 * One row per approval instance (keyed by instance_code), merged with the matching Base record
 * (matched by SourceID instance code, then by serial number). Base records with no matching
 * instance are kept as Base-only rows. Sorted newest first.
 */
function buildApprovalRows({ header, records, instances, baseRow, approval, formatValue = (n, v) => v }) {
  const col = {};
  for (const [key, name] of Object.entries(APPROVAL_FIELD_COLUMNS)) col[key] = header.indexOf(name);

  const byCode = new Map();
  const bySerial = new Map();
  for (const r of records) {
    const code = instanceCodeFromBase(r.fields);
    if (code) byCode.set(code, r);
    const serial = String(toPlainValue(r.fields['Request No.'], { type: FieldType.URL }) || '').trim();
    if (serial) bySerial.set(serial, r);
  }

  const used = new Set();
  const seen = new Set();
  const out = [];
  const sorted = [...instances].sort((a, b) => b.startTime - a.startTime);

  for (const inst of sorted) {
    const code = String(inst.code).toUpperCase();
    if (seen.has(code)) continue; // never emit the same instance twice
    seen.add(code);

    const base = byCode.get(code) || bySerial.get(inst.serial);
    if (base) used.add(base);
    const row = base ? baseRow(base) : header.map(() => '');
    const set = (key, value) => {
      if (col[key] >= 0 && value !== undefined && value !== '') row[col[key]] = value;
    };
    if (!base) set('requestNo', inst.serial);
    set('approvalName', inst.approvalName);
    set('status', STATUS_LABEL[inst.status] || inst.status);
    set('submitted', formatDateTime(inst.startTime, approval.timeZone));
    if (col.completed >= 0) row[col.completed] = formatDateTime(inst.endTime, approval.timeZone);
    if (col.requester >= 0 && !row[col.requester]) row[col.requester] = approval.requesterName(inst);

    // Approval form values fill only empty cells, so existing Base values/links are preserved.
    const formFields = inst.fields || {};
    header.forEach((name, i) => {
      if (row[i] !== '' && row[i] !== undefined && row[i] !== null) return;
      if (!(name in formFields) || name === '_unmapped') return;
      row[i] = formatValue(name, formFields[name]);
    });
    out.push([...row, ...approval.cells(inst)]);
  }

  for (const r of records) {
    if (!used.has(r)) out.push([...baseRow(r), ...approval.columns.map(() => '')]);
  }
  return out;
}

/** Like toPlainValue, but URL fields become clickable =HYPERLINK() cells. */
function toSheetValue(value, field, timeZone) {
  if (field.type === FieldType.URL && value && typeof value === 'object' && value.link) {
    const esc = (s) => String(s).replace(/"/g, '""');
    const label = value.text || value.link;
    return `=HYPERLINK("${esc(value.link)}","${esc(label)}")`;
  }
  return toPlainValue(value, field, timeZone);
}

function readSpreadsheet(filePath) {
  const wb = XLSX.read(fs.readFileSync(filePath), { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return [];
  return XLSX.utils.sheet_to_json(ws, { defval: null, raw: true });
}

function normalize(s) {
  return String(s).trim().toLowerCase().replace(/\s+/g, ' ');
}

function isBlank(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

function coerce(v, field) {
  if (isBlank(v)) return undefined;
  switch (field.type) {
    case FieldType.NUMBER:
    case FieldType.CURRENCY:
    case FieldType.RATING:
    case FieldType.PROGRESS: {
      const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.\-]/g, ''));
      return Number.isFinite(n) ? n : undefined;
    }
    case FieldType.DATE: {
      const d = v instanceof Date ? v : new Date(v);
      return Number.isNaN(d.getTime()) ? undefined : d.getTime();
    }
    case FieldType.CHECKBOX:
      return ['true', 'yes', 'y', '1', 'oo', '✓'].includes(String(v).trim().toLowerCase());
    case FieldType.MULTI_SELECT:
      return String(v).split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    case FieldType.URL:
      return { text: String(v), link: String(v) };
    default:
      return v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  }
}

function moveFile(src, destDir) {
  try {
    fs.mkdirSync(destDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(destDir, `${stamp}_${path.basename(src)}`);
    fs.renameSync(src, dest);
  } catch {
    /* file may already be gone */
  }
}

module.exports = { SyncEngine, buildApprovalRows, APPROVAL_FIELD_COLUMNS };
