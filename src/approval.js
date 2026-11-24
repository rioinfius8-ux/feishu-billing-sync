// Reads Feishu Approval instances to derive per-step progress columns.

const DONE_TASK = new Set(['APPROVED', 'DONE']);

/**
 * steps: [{ column: 'QB Handled', node: 'QB Handle' }, ...]
 */
class ApprovalSteps {
  constructor({ client, steps, timeZone, logger }) {
    this.client = client;
    this.steps = steps;
    this.timeZone = timeZone;
    this.log = logger;
    this.warned = false;
  }

  get columns() {
    return [...this.steps.map((s) => s.column), 'Status'];
  }

  /** Candidate instance ids for a Base record (UUID from SourceID, numeric id from the Request No. link). */
  static instanceIds(fields) {
    const ids = [];
    const src = plain(fields.SourceID);
    if (src) {
      try {
        const m = Buffer.from(src, 'base64').toString('utf8').match(/[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/i);
        if (m) ids.push(m[0]);
      } catch { /* not base64 */ }
    }
    const link = JSON.stringify(fields['Request No.'] || '');
    const n = link.match(/instanceId=(\d+)/);
    if (n) ids.push(n[1]);
    return ids;
  }

  async fetchInstance(ids) {
    let lastErr;
    for (const id of ids) {
      try {
        const res = await this.client.approval.v4.instance.get({ path: { instance_id: id } });
        if (res.code === 0) return res.data;
        lastErr = new Error(`[${res.code}] ${res.msg}`);
      } catch (e) {
        const d = e.response && e.response.data;
        lastErr = new Error(d ? `[${d.code}] ${d.msg}` : e.message);
        if (d && d.code === 99991672) throw lastErr; // missing permission: no point retrying
      }
    }
    throw lastErr || new Error('no approval instance id found');
  }

  /** Returns one array of column values per record (same order as `this.columns`). */
  async valuesFor(records) {
    const empty = () => this.columns.map(() => '');
    const out = records.map(empty);

    await mapLimit(records, 5, async (rec, i) => {
      const ids = ApprovalSteps.instanceIds(rec.fields);
      if (!ids.length) return;
      try {
        const inst = await this.fetchInstance(ids);
        out[i] = this.rowFromInstance(inst);
      } catch (err) {
        if (/99991672/.test(err.message)) {
          if (!this.warned) {
            this.log.warn('Approval columns left blank: Feishu app lacks approval:approval:readonly (publish the app version).');
            this.warned = true;
          }
        } else {
          this.log.warn(`Approval lookup failed for ${ids[0]}: ${err.message}`);
        }
      }
    });
    return out;
  }

  rowFromInstance(inst) {
    const tasks = inst.task_list || [];
    let allDone = true;
    const cells = this.steps.map((step) => {
      const matching = tasks.filter((t) => normalize(t.node_name) === normalize(step.node));
      if (!matching.length) {
        allDone = false;
        return '';
      }
      const done = matching.filter((t) => DONE_TASK.has(t.status));
      if (done.length) {
        const end = Math.max(...done.map((t) => Number(t.end_time) || 0));
        return end ? this.fmt(end) : 'Done';
      }
      allDone = false;
      return 'Pending';
    });
    return [...cells, allDone ? 'Done' : 'Pending'];
  }

  fmt(ms) {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: this.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]),
    );
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
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

function plain(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return v.map((x) => (x && x.text) || '').join('').trim();
  return String(v.text || '').trim();
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

module.exports = { ApprovalSteps, parseSteps };
