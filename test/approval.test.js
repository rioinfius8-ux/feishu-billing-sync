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

// ---------- form field mapping ----------
const { extractFormFields } = require('../src/approval');

const FORM = [
  { name: 'Related Approvals', type: 'connect', ext: { serialIDs: '202610060003' }, value: ['63819018-9507-4F7F-BC51-2412FDF82B98'] },
  { name: 'Payment Urgent', type: 'radioV2', value: 'Urgent' },
  { name: 'Belongs To', type: 'checkboxV2', value: ['Project'] },
  { name: 'Project Location', type: 'checkboxV2', value: ['ALBAY', 'CAMSUR'] },
  { name: 'DateInterval', type: 'dateInterval', value: { start: '2026-09-01T00:00:00+08:00', end: '2026-09-30T00:00:00+08:00', interval: 30 } },
  { name: 'Due Date', type: 'date', value: '2026-10-29T00:00:00+08:00' },
  { name: 'PAF NO.(Internal)', type: 'input', value: 'I801101' },
  { name: 'Payment Details -Albay', type: 'fieldList', value: [[
    { name: 'Project', type: 'radioV2', value: 'SLI-PR' },
    { name: 'Payable Amount-Gross', type: 'amount', ext: { currency: 'PHP' }, value: 364800 },
    { name: '2307 Rate', type: 'radioV2', value: '0%' },
    { name: 'VAT Amount', type: 'amount', ext: { currency: 'PHP' }, value: 39085.71 },
    { name: 'Net Amount-PHP', type: 'formula', value: 364800 },
  ]] },
  { name: 'Payment Details', type: 'fieldList', value: [
    [{ name: 'Products', type: 'checkboxV2', value: ['A', 'B'] }, { name: 'Payment To', type: 'radioV2', value: 'Company Account' }],
    [{ name: 'Products', type: 'checkboxV2', value: ['C'] }, { name: 'Payment To', type: 'radioV2', value: 'Employees Account' }],
  ] },
  { name: 'Total Amount-PHP', type: 'formula', value: 1887360 },
  { name: 'Breakdown of Request', type: 'image', value: ['https://x/1.png?x-expires=1'] },
  { name: 'PAF', type: 'attachmentV2', ext: 'a.pdf', value: ['https://x/a', 'https://x/b'] },
  { name: 'Payment Schedule', type: 'image', value: [] },
];

test('extractFormFields matches Base formats', () => {
  const f = extractFormFields(JSON.stringify(FORM));
  assert.strictEqual(f['Related Approvals'], '202610060003');
  assert.strictEqual(f['Payment Urgent'], 'Urgent');
  assert.deepStrictEqual(f['Project Location'], ['ALBAY', 'CAMSUR']);
  assert.strictEqual(f['Billing Start Date'], Date.parse('2026-09-01T00:00:00+08:00'));
  assert.strictEqual(f['Billing End Date'], Date.parse('2026-09-30T00:00:00+08:00'));
  assert.strictEqual(f['Duration'], '30');
  assert.strictEqual(f['Due Date'], Date.parse('2026-10-29T00:00:00+08:00'));
  // Same text the Base table holds for this request:
  assert.strictEqual(f['Payment Details -Albay'], 'Project:SLI-PR | Payable Amount-Gross:364800.000000 PHP | 2307 Rate:0% | VAT Amount:39085.710000 PHP | Net Amount-PHP:364800.000000');
  assert.strictEqual(f['Payment Details'], 'Products:A, B | Payment To:Company Account\nProducts:C | Payment To:Employees Account');
  assert.strictEqual(f['Total Amount-PHP'], 1887360);
  assert.strictEqual(f['Breakdown of Request'], '1 image(s)');
  assert.strictEqual(f['PAF'], '2 attachment(s)');
  assert.ok(!('Payment Schedule' in f), 'empty widgets are not emitted');
  assert.deepStrictEqual(extractFormFields('not json'), {});
});

test('form values fill only empty cells; Base values are preserved', () => {
  const sync = makeSync(fakeClient(), tmpState());
  sync.loadState();
  const header = ['Request No.', 'Status', 'PAF', 'Payment Urgent', 'Payment Details -Albay'];
  const src = (code) => Buffer.from(`1:${code}:x:1`).toString('base64');
  const records = [{ fields: { 'Request No.': { text: '001' }, SourceID: src('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'), PAF: '=HYPERLINK("L","1 attachment(s)")' } }];
  const baseRow = (r) => header.map((h) => { const v = r.fields[h]; return v && typeof v === 'object' ? v.text : v || ''; });
  const fields = extractFormFields(FORM);
  const mk = (code, serial) => ({ code, serial, status: 'APPROVED', startTime: T0, endTime: T0 + 1, tasks: [], fields });
  const rows = buildApprovalRows({
    header, records, baseRow, approval: sync,
    instances: [mk('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', '001'), mk('CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC', '003')],
    formatValue: (n, v) => (Array.isArray(v) ? v.join(', ') : v),
  });
  const base = rows.find((r) => r[0] === '001');
  const api = rows.find((r) => r[0] === '003');
  assert.strictEqual(base[2], '=HYPERLINK("L","1 attachment(s)")'); // Base link kept
  assert.strictEqual(base[3], 'Urgent'); // empty Base cell filled from form
  assert.strictEqual(api[2], '2 attachment(s)');
  assert.ok(api[4].startsWith('Project:SLI-PR | Payable Amount-Gross:364800.000000 PHP'));
});

test('unmapped nodes (Bank Handle, SI/OR) do not fill step columns', () => {
  const sync = makeSync(fakeClient(), tmpState());
  sync.loadState();
  const t = Date.parse('2026-01-05T16:16:00+08:00');
  const bankHandle = { status: 'APPROVED', tasks: [
    { node: 'QB Handle', status: 'APPROVED', end: t - 1e8 }, { node: 'Bank Handle', status: 'APPROVED', end: t },
  ] };
  const cells = sync.cells(bankHandle);
  assert.strictEqual(cells[1], ''); // Bank Maked
  assert.strictEqual(cells[2], ''); // FS Final Checking
  assert.strictEqual(cells[3], ''); // Bank Released
  assert.strictEqual(cells[4], 'Done'); // approved rule: Bank Handle requests keep step Status Done
  assert.ok(cells.every((c) => c !== '2026-01-05 16:16'), 'Bank Handle time must not appear in any step column');
  const siOr = { status: 'APPROVED', tasks: [
    { node: 'QB Handle', status: 'APPROVED', end: t }, { node: 'Bank Maker', status: 'APPROVED', end: t },
    { node: 'Bank Proofs/Approval', status: 'APPROVED', end: t }, { node: 'SI/OR and Bank Refund', status: 'APPROVED', end: t + 1e8 },
  ] };
  const si = sync.cells(siOr);
  assert.strictEqual(si[3], '2026-01-05 16:16'); // Bank Released stays the Bank Proofs time
  assert.strictEqual(si[4], 'Done');
  // A pending SI/OR step must not change any step column or the step Status.
  const siPending = { status: 'APPROVED', tasks: siOr.tasks.map((x) => (x.node === 'SI/OR and Bank Refund' ? { ...x, status: 'PENDING', end: 0 } : x)) };
  assert.deepStrictEqual(sync.cells(siPending), si);
  assert.deepStrictEqual(STEPS.map((s) => s.node), ['QB Handle', 'Bank Maker', 'FS Final Checking', 'Bank Proofs/Approval']);
});
