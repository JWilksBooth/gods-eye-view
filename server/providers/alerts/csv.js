/**
 * RFC 4180 CSV reading for the feeds that publish it: comma-separated,
 * double-quoted fields that may hold commas, line breaks and doubled quotes,
 * CRLF or LF row ends. A single pass over the text with no regular
 * expressions, so a multi-megabyte district file parses in linear time.
 */

/**
 * Every row of a CSV text as an array of field strings. A trailing empty
 * line is not a row.
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsvRows(text) {
  const source = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let index = 0;
  const length = source.length;
  while (index < length) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"' && field === '') {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      index += 1;
      continue;
    }
    if (char === '\r' || char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index += char === '\r' && source[index + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += char;
    index += 1;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * The rows of a CSV text with a header line, as objects keyed by the header
 * names. Missing trailing fields read as empty strings.
 * @param {string} text
 * @returns {{header: string[], records: object[]}}
 */
export function parseCsvRecords(text) {
  const [header = [], ...rows] = parseCsvRows(text);
  const names = header.map((name) => name.trim());
  const records = [];
  for (const row of rows) {
    if (row.length === 1 && row[0] === '') continue;
    const record = {};
    names.forEach((name, column) => {
      record[name] = row[column] ?? '';
    });
    records.push(record);
  }
  return { header: names, records };
}
