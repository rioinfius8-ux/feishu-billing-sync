const lark = require('@larksuiteoapi/node-sdk');

const BATCH_SIZE = 500; // Feishu limit per batch request

// Feishu Base field type ids
const FieldType = {
  TEXT: 1,
  NUMBER: 2,
  SINGLE_SELECT: 3,
  MULTI_SELECT: 4,
  DATE: 5,
  CHECKBOX: 7,
  USER: 11,
  PHONE: 13,
  URL: 15,
  ATTACHMENT: 17,
  LINK: 18,
  LOOKUP: 19,
  FORMULA: 20,
  DUPLEX_LINK: 21,
  LOCATION: 22,
  GROUP: 23,
  CREATED_TIME: 1001,
  MODIFIED_TIME: 1002,
  CREATED_USER: 1003,
  MODIFIED_USER: 1004,
  AUTO_NUMBER: 1005,
  CURRENCY: 99003,
  RATING: 99004,
  PROGRESS: 99002,
};

// Fields we can write to when importing
const WRITABLE_TYPES = new Set([
  FieldType.TEXT,
  FieldType.NUMBER,
  FieldType.SINGLE_SELECT,
  FieldType.MULTI_SELECT,
  FieldType.DATE,
  FieldType.CHECKBOX,
  FieldType.PHONE,
  FieldType.URL,
  FieldType.CURRENCY,
  FieldType.RATING,
  FieldType.PROGRESS,
]);

function createClient(config) {
  return new lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    appType: lark.AppType.SelfBuild,
    domain: config.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
    loggerLevel: lark.LoggerLevel.fatal, // errors are handled and logged by our own code
  });
}

function check(res, what) {
  if (!res || res.code !== 0) {
    throw new Error(`Feishu ${what} failed: [${res && res.code}] ${res && res.msg}`);
  }
  return res.data;
}

class FeishuBase {
  constructor(config) {
    this.client = createClient(config);
    this.path = { app_token: config.appToken, table_id: config.tableId };
  }

  /** Returns [{ field_name, type, ... }] in table order. */
  async listFields() {
    const fields = [];
    let pageToken;
    do {
      const res = await this.client.bitable.v1.appTableField.list({
        path: this.path,
        params: { page_size: 100, page_token: pageToken },
      });
      const data = check(res, 'list fields');
      fields.push(...(data.items || []));
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);
    return fields;
  }

  /** Returns [{ record_id, fields }] for every record in the table. */
  async listRecords() {
    const records = [];
    let pageToken;
    do {
      const res = await this.client.bitable.v1.appTableRecord.list({
        path: this.path,
        params: { page_size: 500, page_token: pageToken },
      });
      const data = check(res, 'list records');
      records.push(...(data.items || []));
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);
    return records;
  }

  async createRecords(fieldsList) {
    for (let i = 0; i < fieldsList.length; i += BATCH_SIZE) {
      const chunk = fieldsList.slice(i, i + BATCH_SIZE);
      const res = await this.client.bitable.v1.appTableRecord.batchCreate({
        path: this.path,
        data: { records: chunk.map((fields) => ({ fields })) },
      });
      check(res, 'create records');
    }
  }

  /** updates: [{ record_id, fields }] */
  async updateRecords(updates) {
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const chunk = updates.slice(i, i + BATCH_SIZE);
      const res = await this.client.bitable.v1.appTableRecord.batchUpdate({
        path: this.path,
        data: { records: chunk },
      });
      check(res, 'update records');
    }
  }
}

/** Converts a Feishu cell value into a plain string/number for Google Sheets. */
function toPlainValue(value, field, timeZone) {
  if (value === null || value === undefined) return '';
  const type = field && field.type;

  if (type === FieldType.DATE || type === FieldType.CREATED_TIME || type === FieldType.MODIFIED_TIME) {
    if (typeof value === 'number') return formatDate(value, field, timeZone);
  }
  if (type === FieldType.CHECKBOX) return value ? 'TRUE' : 'FALSE';

  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';

  if (Array.isArray(value)) {
    return value
      .map((v) => toPlainValue(v, null, timeZone))
      .filter((v) => v !== '')
      .join(type === FieldType.TEXT ? '' : ', ');
  }

  if (typeof value === 'object') {
    // Rich text segment, user, attachment, link, url, location, formula/lookup result...
    if (value.value !== undefined && value.type !== undefined && Array.isArray(value.value)) {
      return toPlainValue(value.value, null, timeZone); // lookup / formula wrapper
    }
    return (
      value.text ??
      value.name ??
      value.en_name ??
      value.full_address ??
      value.link ??
      value.url ??
      (Array.isArray(value.text_arr) ? value.text_arr.join(', ') : undefined) ??
      JSON.stringify(value)
    );
  }
  return String(value);
}

function formatDate(ms, field, timeZone) {
  const fmt = (field && field.property && field.property.date_formatter) || 'yyyy/MM/dd';
  const withTime = /HH:mm/.test(fmt);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
  }).formatToParts(new Date(ms));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  return withTime ? `${date} ${p.hour}:${p.minute}` : date;
}

module.exports = { FeishuBase, FieldType, WRITABLE_TYPES, toPlainValue };
