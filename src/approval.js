// Feishu Approval API: lists Payment Request instances (GET /approval/v4/instances),
// fetches their details (GET /approval/v4/instances/:instance_id), keeps a resumable
// local cache, and derives per-step progress columns.

const fs = require('fs');
const path = require('path');

const WINDOW_MS = 10 * 3600 * 1000; // documented max time range per list query
const OVERLAP_MS = 3600 * 1000; // re-scan the last hour on incremental runs (late indexing)
const LIST_MIN_INTERVAL_MS = 700; // list API limit is 100 req/min
const PAGE_SIZE = 100; // documented max for the list API
const DETAIL_CONCURRENCY = 5;
const FINAL_STATUSES = new Set(['APPROVED', 'REJECTED', 'CANCELED', 'DELETED']);
const DONE_TASK = new Set(['APPROVED', 'DONE']);
const PERMISSION_DENIED = 99991672;
const RATE_LIMITED = 99991400;
const STATUS_LABEL = {
  PENDING: 'Pending',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  CANCELED: 'Canceled',
  DELETED: 'Deleted',
};

class FeishuApiError extends Error {
  constructor(code, msg, httpStatus) {
    super(`[${code}] ${msg}`);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** Small JSON state file written atomically (tmp + rename) so a crash never corrupts it. */
class StateStore {
  constructor(file) {
    this.file = file;
  }

  load(defaults) {
    try {
      return { ...defaults, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`Cannot read ${this.file}: ${err.message}`);
      return { ...defaults };
    }
  }

  save(state) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, this.file);
  }
}

class ApprovalSync {
  /**
   * @param {object} o
   * @param {object} o.client         lark.Client
   * @param {string} o.approvalCode   approval definition code
   * @param {number} o.backfillFrom   ms timestamp where the first scan starts
   * @param {Array}  o.steps          [{ column, node }] from APPROVAL_STEPS
   * @param {string} o.stateFile
   */
  constructor({ client, approvalCode, backfillFrom, steps, timeZone, logger, stateFile, sleep }) {
    this.client = client;
    this.approvalCode = approvalCode;
    this.backfillFrom = backfillFrom;
    this.steps = steps;
    this.timeZone = timeZone;
    this.log = logger;
    this.store = new StateStore(stateFile);
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.lastListCall = 0;
    this.state = null;
  }

  get columns() {
    return [...this.steps.map((s) => s.column), 'Status'];
  }

  loadState() {
    this.state = this.store.load({ approvalCode: this.approvalCode, scannedUntil: 0, instances: {}, users: {} });
    if (this.state.approvalCode !== this.approvalCode) {
      throw new Error(
        `State file belongs to approval ${this.state.approvalCode}, not ${this.approvalCode}. Move ${this.store.file} away to start fresh.`,
      );
    }
    return this.state;
  }

  saveState() {
    this.store.save(this.state);
  }

  // ---------- API calls with retries ----------

  async call(what, fn, { retries = 5 } = {}) {
    for (let attempt = 0; ; attempt++) {
      let err;
      try {
        const res = await fn();
        if (res && res.code === 0) return res.data || {};
        err = new FeishuApiError(res && res.code, res && res.msg, 200);
      } catch (e) {
        const d = e.response && e.response.data;
        err = d && d.code !== undefined ? new FeishuApiError(d.code, d.msg, e.response.status) : e;
        if (!err.httpStatus && e.response) err.httpStatus = e.response.status;
      }
      const retryable =
        err.code === RATE_LIMITED ||
        err.httpStatus === 429 ||
        (err.httpStatus >= 500 && err.httpStatus < 600) ||
        (!err.httpStatus && !(err instanceof FeishuApiError)); // network error
      if (!retryable || attempt >= retries) {
        err.message = `${what}: ${err.message}`;
        throw err;
      }
      const wait = Math.min(30000, 1000 * 2 ** attempt);
      this.log.warn(`${what} failed (${err.message}); retry ${attempt + 1}/${retries} in ${wait / 1000}s`);
      await this.sleep(wait);
    }
  }

  async throttleList() {
    const wait = this.lastListCall + LIST_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.lastListCall = Date.now();
  }

  /** All instance codes created in [start, end), following page_token. */
  async listWindow(start, end) {
    const codes = [];
    let pageToken;
    do {
      await this.throttleList();
      const data = await this.call('list instances', () =>
        this.client.approval.v4.instance.list({
          params: {
            approval_code: this.approvalCode,
            start_time: String(start),
            end_time: String(end),
            page_size: PAGE_SIZE,
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        }),
      );
      codes.push(...(data.instance_code_list || []));
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);
    return codes;
  }

  async getInstance(code) {
    return this.call(`get instance ${code}`, () =>
      this.client.approval.v4.instance.get({ path: { instance_id: code }, params: { locale: 'en-US' } }),
    );
  }

  // ---------- sync steps ----------

  /** Scans creation-time windows from the saved cursor (or backfillFrom) up to now. */
  async scan(now = Date.now()) {
    const s = this.state;
    let from = s.scannedUntil ? s.scannedUntil - OVERLAP_MS : this.backfillFrom;
    if (from < this.backfillFrom) from = this.backfillFrom;
    const totalWindows = Math.ceil((now - from) / WINDOW_MS);
    let found = 0;
    let added = 0;
    let n = 0;

    if (totalWindows > 10) {
      this.log.info(`Approval scan: ${totalWindows} windows from ${new Date(from).toISOString()} (resumable).`);
    }
    for (let start = from; start < now; start += WINDOW_MS) {
      const end = Math.min(start + WINDOW_MS, now);
      const codes = await this.listWindow(start, end);
      found += codes.length;
      for (const code of codes) {
        if (!s.instances[code]) {
          s.instances[code] = { code };
          added++;
        }
      }
      s.scannedUntil = end;
      this.saveState();
      if (++n % 100 === 0) this.log.info(`Approval scan: ${n}/${totalWindows} windows, ${added} new instance(s) so far.`);
    }
    return { windows: n, found, added };
  }

  /** Fetches details for new instances and refreshes ones not in a final status. */
  async refreshDetails(extraCodes = []) {
    const s = this.state;
    for (const code of extraCodes) if (!s.instances[code]) s.instances[code] = { code, extra: true };

    const todo = Object.values(s.instances).filter((i) => !FINAL_STATUSES.has(i.status) && !i.notFound);
    let ok = 0;
    let failed = 0;
    let sinceSave = 0;

    await mapLimit(todo, DETAIL_CONCURRENCY, async (inst) => {
      try {
        const d = await this.getInstance(inst.code);
        Object.assign(inst, summarize(d));
        delete inst.error;
        ok++;
      } catch (err) {
        if (err.code === PERMISSION_DENIED) throw err;
        if (err.code === 1390003) inst.notFound = true; // "instance code not found"
        inst.error = err.message;
        failed++;
        this.log.warn(err.message);
      }
      if (++sinceSave >= 20) {
        sinceSave = 0;
        this.saveState();
      }
    });
    this.saveState();
    return { refreshed: ok, failed };
  }

  /** Best effort: resolves initiator names (needs a contact permission; skipped if missing). */
  async resolveNames() {
    const s = this.state;
    const ids = [...new Set(Object.values(s.instances).map((i) => i.openId).filter(Boolean))].filter(
      (id) => !(id in s.users),
    );
    for (const id of ids) {
      try {
        const data = await this.call('get user', () =>
          this.client.contact.v3.user.get({ path: { user_id: id }, params: { user_id_type: 'open_id' } }),
        );
        s.users[id] = (data.user && data.user.name) || null;
      } catch (err) {
        if (err.code === PERMISSION_DENIED || err.httpStatus === 400 || err.httpStatus === 403) {
          if (!this.warnedContact) {
            this.log.warn(`Requester names not available from Feishu contact API (${err.message.slice(0, 120)}). Using Base data where present.`);
            this.warnedContact = true;
          }
          return; // don't cache: retry next run in case permission is added later
        }
        this.log.warn(err.message);
      }
    }
    if (ids.length) this.saveState();
  }

  /** Full incremental run. Returns instance summaries that have details. */
  async sync({ extraCodes = [], now = Date.now() } = {}) {
    this.loadState();
    const scan = await this.scan(now);
    const details = await this.refreshDetails(extraCodes);
    await this.resolveNames();
    const all = Object.values(this.state.instances);
    this.lastStats = {
      ...scan,
      ...details,
      cached: all.length,
      withDetails: all.filter((i) => i.status).length,
    };
    this.log.info(
      `Approval: scanned ${scan.windows} window(s), ${scan.added} new; details refreshed ${details.refreshed}, failed ${details.failed}; total ${this.lastStats.withDetails}.`,
    );
    return all.filter((i) => i.status);
  }

  // ---------- presentation ----------

  requesterName(inst) {
    return (inst.openId && this.state.users[inst.openId]) || '';
  }

  /** Step cells + Status (Done/Pending), same order as `columns`. */
  cells(inst) {
    const tasks = inst.tasks || [];
    let present = 0;
    let allDone = true;
    const stepCells = this.steps.map((step) => {
      const matching = tasks.filter((t) => normalize(t.node) === normalize(step.node));
      if (!matching.length) return ''; // step not in this instance's flow (or not reached yet)
      present++;
      const done = matching.filter((t) => DONE_TASK.has(t.status));
      if (done.length) {
        const end = Math.max(...done.map((t) => Number(t.end) || 0));
        return end ? this.fmt(end) : 'Done';
      }
      allDone = false;
      return 'Pending';
    });
    let status = '';
    if (inst.status === 'PENDING') status = 'Pending';
    else if (inst.status === 'APPROVED') status = present && allDone ? 'Done' : 'Pending';
    // REJECTED / CANCELED / DELETED: left blank; the approval status column shows it.
    return [...stepCells, status];
  }

  fmt(ms) {
    return formatDateTime(ms, this.timeZone);
  }
}

// ---------- helpers ----------

function summarize(d) {
  return {
    code: d.instance_code,
    serial: d.serial_number || '',
    approvalName: d.approval_name || '',
    status: d.status,
    startTime: Number(d.start_time) || 0,
    endTime: Number(d.end_time) || 0,
    openId: d.open_id || '',
    tasks: (d.task_list || []).map((t) => ({ node: t.node_name, status: t.status, end: Number(t.end_time) || 0 })),
    fetchedAt: Date.now(),
  };
}

/** Instance code (UUID) of a Base record, decoded from its SourceID field. */
function instanceCodeFromBase(fields) {
  const v = fields.SourceID;
  const src = typeof v === 'string' ? v : Array.isArray(v) ? v.map((x) => (x && x.text) || '').join('') : (v && v.text) || '';
  if (!src.trim()) return '';
  try {
    const m = Buffer.from(src.trim(), 'base64')
      .toString('utf8')
      .match(/[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/i);
    return m ? m[0].toUpperCase() : '';
  } catch {
    return '';
  }
}

/** Parses "QB Handled=QB Handle;Bank Maked=Bank Maker" */
function parseSteps(spec) {
  return String(spec || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const [column, node] = pair.split('=').map((x) => x.trim());
      return { column, node: node || column };
    });
}

function formatDateTime(ms, timeZone) {
  if (!ms) return '';
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
}

function normalize(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

module.exports = {
  ApprovalSync,
  StateStore,
  parseSteps,
  instanceCodeFromBase,
  formatDateTime,
  STATUS_LABEL,
  WINDOW_MS,
};
