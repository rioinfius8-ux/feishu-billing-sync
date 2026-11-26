const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ApprovalSync, parseSteps, instanceCodeFromBase, WINDOW_MS } = require('../src/approval');
const { buildApprovalRows } = require('../src/syncEngine');

const quiet = { info() {}, warn() {}, error() {} };
const STEPS = parseSteps('QB Handled=QB Handle;Bank Maked=Bank Maker;FS Final Checking=FS Final Checking;Bank Released=Bank Proofs/Approval');
const T0 = Date.parse('2026-01-01T00:00:00+08:00');

function tmpState() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'appr-')), 'state.json');
}

/** Fake lark client. `created` = [{ code, time }]; `details` = { code: instanceData }. */
function fakeClient({ created = [], details = {}, pageSize = 2, failFirstList = 0 } = {}) {
  const calls = { list: [], get: [] };
  let failures = failFirstList;
  return {
    calls,
    approval: {
      v4: {
        instance: {
          async list({ params }) {
            calls.list.push(params);
            if (failures > 0) {
              failures--;
              return { code: 99991400, msg: 'rate limited' };
            }
            const s = Number(params.start_time);
            const e = Number(params.end_time);
            assert.ok(e - s <= WINDOW_MS, 'window must not exceed 10 hours');
            const all = created.filter((c) => c.time >= s && c.time < e).map((c) => c.code);
            const offset = Number(params.page_token || 0);
            const page = all.slice(offset, offset + pageSize);
            const more = offset + pageSize < all.length;
            return { code: 0, data: { instance_code_list: page, has_more: more, page_token: more ? String(offset + pageSize) : '' } };
          },
          async get({ path: p }) {
            calls.get.push(p.instance_id);
            const d = details[p.instance_id];
            return d ? { code: 0, data: d } : { code: 1390003, msg: 'instance code not found' };
          },
        },
      },
    },
    contact: { v3: { user: { async get() { return { code: 99991672, msg: 'no contact permission' }; } } } },
  };
}

function detail(code, serial, status, tasks = [], start = T0 + 1000) {
  return {
    instance_code: code, serial_number: serial, approval_name: 'Payment Request', status,
    start_time: String(start), end_time: status === 'PENDING' ? '0' : String(start + 5000), open_id: 'ou_x',
    task_list: tasks.map(([node_name, s, end]) => ({ node_name, status: s, end_time: String(end || 0) })),
  };
}

function makeSync(client, stateFile, extra = {}) {
  return new ApprovalSync({
    client, approvalCode: 'APPROVAL', backfillFrom: T0, steps: STEPS, timeZone: 'Asia/Manila',
    logger: quiet, stateFile, sleep: async () => {}, ...extra,
  });
}

test('scan uses <=10h windows, follows pagination, and saves the cursor', async () => {
  const created = [1, 2, 3, 4, 5].map((i) => ({ code: `C${i}`, time: T0 + 3600e3 }));
  created.push({ code: 'C6', time: T0 + 25 * 3600e3 });
  const client = fakeClient({ created, pageSize: 2 });
  const file = tmpState();
  const sync = makeSync(client, file);
  sync.loadState();
  const now = T0 + 30 * 3600e3;
  const r = await sync.scan(now);
  assert.strictEqual(r.windows, 3);
  assert.strictEqual(r.added, 6);
  assert.strictEqual(client.calls.list.length, 5); // window 1 has 3 pages, then 1 + 1
  assert.strictEqual(JSON.parse(fs.readFileSync(file)).scannedUntil, now);
});

test('incremental scan resumes from cursor minus overlap and never duplicates', async () => {
  const created = [{ code: 'A', time: T0 + 1000 }, { code: 'B', time: T0 + 20 * 3600e3 }];
  const file = tmpState();
  const now1 = T0 + 20.5 * 3600e3;
  let sync = makeSync(fakeClient({ created }), file);
  sync.loadState();
  await sync.scan(now1);

  created.push({ code: 'C', time: now1 + 60e3 });
  const client2 = fakeClient({ created });
  sync = makeSync(client2, file);
  sync.loadState();
  const r = await sync.scan(now1 + 3600e3);
  assert.strictEqual(Number(client2.calls.list[0].start_time), now1 - 3600e3); // 1h overlap
  assert.strictEqual(r.added, 1); // B re-seen in overlap but not re-added
  assert.deepStrictEqual(Object.keys(sync.state.instances).sort(), ['A', 'B', 'C']);
});

test('retries on rate limit', async () => {
  const client = fakeClient({ created: [{ code: 'A', time: T0 + 1 }], failFirstList: 2 });
  const sync = makeSync(client, tmpState());
  sync.loadState();
  const r = await sync.scan(T0 + 3600e3);
  assert.strictEqual(r.added, 1);
  assert.strictEqual(client.calls.list.length, 3);
});

test('refreshDetails fetches new + pending instances, skips final ones', async () => {
  const details = {
    A: detail('A', '1', 'APPROVED'),
    B: detail('B', '2', 'PENDING'),
  };
  const client = fakeClient({ details });
  const file = tmpState();
  const sync = makeSync(client, file);
  sync.loadState();
  sync.state.instances = { A: { code: 'A' }, B: { code: 'B' } };
  await sync.refreshDetails();
  assert.deepStrictEqual(client.calls.get.sort(), ['A', 'B']);
  client.calls.get.length = 0;
  details.B = detail('B', '2', 'APPROVED');
  await sync.refreshDetails();
  assert.deepStrictEqual(client.calls.get, ['B']); // A is final; only B refreshed
  assert.strictEqual(sync.state.instances.B.status, 'APPROVED');
});

test('step cells: mapped steps, missing steps blank, overall Status', () => {
  const sync = makeSync(fakeClient(), tmpState());
  sync.loadState();
  const t = Date.parse('2026-10-29T10:07:00+08:00');
  const done = { status: 'APPROVED', tasks: [
    { node: 'QB Handle', status: 'APPROVED', end: t }, { node: 'QB Handle', status: 'DONE', end: t + 1 },
    { node: 'Bank Maker', status: 'APPROVED', end: t }, { node: 'Bank Proofs/Approval', status: 'APPROVED', end: t },
  ] };
  assert.deepStrictEqual(sync.cells(done), ['2026-10-29 10:07', '2026-10-29 10:07', '', '2026-10-29 10:07', 'Done']);
  const pending = { status: 'PENDING', tasks: [{ node: 'QB Handle', status: 'PENDING', end: 0 }] };
  assert.deepStrictEqual(sync.cells(pending), ['Pending', '', '', '', 'Pending']);
  assert.deepStrictEqual(sync.cells({ status: 'REJECTED', tasks: [] }), ['', '', '', '', '']);
});

test('instanceCodeFromBase decodes SourceID', () => {
  const src = Buffer.from('7711234440600603661:43E86E06-FAA5-4D87-93B3-ADA04089AB19:abc:1').toString('base64');
  assert.strictEqual(instanceCodeFromBase({ SourceID: src }), '43E86E06-FAA5-4D87-93B3-ADA04089AB19');
  assert.strictEqual(instanceCodeFromBase({}), '');
});

test('buildApprovalRows merges Base, keeps Base-only rows, no duplicates', () => {
  const sync = makeSync(fakeClient(), tmpState());
  sync.loadState();
  const header = ['Request No.', 'Status', 'Approval process', 'Submitted at', 'Completed at', 'Requester', 'PAF'];
  const src = (code) => Buffer.from(`1:${code}:x:1`).toString('base64');
  const records = [
    { fields: { 'Request No.': { text: '001', link: 'L1' }, SourceID: src('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'), Requester: 'Rio', PAF: 'p1' } },
    { fields: { 'Request No.': { text: '999', link: 'L9' }, PAF: 'old' } }, // not in API
  ];
  const baseRow = (r) => header.map((h) => {
    const v = r.fields[h];
    return v && typeof v === 'object' ? v.text : v || '';
  });
  const inst = (code, serial, start) => ({ code, serial, approvalName: 'Payment Request', status: 'APPROVED', startTime: start, endTime: start + 1, openId: '', tasks: [] });
  const instances = [
    inst('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', '001', T0 + 1),
    inst('BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB', '002', T0 + 2),
    inst('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '002', T0 + 2), // same code, different case
  ];
  const rows = buildApprovalRows({ header, records, instances, baseRow, approval: sync });
  assert.strictEqual(rows.length, 3); // 002, 001 (merged), 999 (Base-only)
  assert.deepStrictEqual(rows.map((r) => r[0]), ['002', '001', '999']);
  assert.strictEqual(rows[1][5], 'Rio'); // Base requester kept
  assert.strictEqual(rows[1][6], 'p1'); // Base field kept
  assert.strictEqual(rows[1][1], 'Approved'); // approval status applied
  assert.strictEqual(rows[0][2], 'Payment Request');
  assert.strictEqual(rows[0].length, header.length + 5);
});
