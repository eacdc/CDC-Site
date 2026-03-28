const DEFAULT_ALLOWED_TABLES = new Set(['productmaster', 'ledgermaster']);

const FORBIDDEN_KEYWORDS = [
  'insert',
  'update',
  'delete',
  'merge',
  'truncate',
  'drop',
  'alter',
  'create',
  'exec',
  'execute',
  'openrowset',
  'bulk',
  'xp_',
  'sp_executesql'
];

function stripSqlCommentsAndStrings(sql) {
  let out = '';
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        out += '\n';
      }
      i += 1;
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (!inSingle && !inDouble && ch === '-' && next === '-') {
      inLineComment = true;
      i += 2;
      continue;
    }

    if (!inSingle && !inDouble && ch === '/' && next === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }

    if (!inDouble && ch === '\'') {
      if (inSingle && next === '\'') {
        i += 2;
        continue;
      }
      inSingle = !inSingle;
      i += 1;
      continue;
    }

    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      i += 1;
      continue;
    }

    if (!inSingle && !inDouble) {
      out += ch;
    }
    i += 1;
  }

  return out;
}

function normalizeIdentifier(value) {
  return String(value || '').replace(/[\[\]]/g, '').toLowerCase();
}

function isSingleStatement(cleanedSql) {
  const trimmed = cleanedSql.trim();
  if (!trimmed) return false;
  const semicolons = [...trimmed.matchAll(/;/g)];
  if (semicolons.length === 0) return true;
  if (semicolons.length > 1) return false;
  return semicolons[0].index === trimmed.length - 1;
}

function startsWithSelect(cleanedSql) {
  const trimmed = cleanedSql.trim().toLowerCase();
  return trimmed.startsWith('select ');
}

function extractTableNames(cleanedSql) {
  const tableNames = [];
  const re = /\b(from|join)\s+([a-zA-Z0-9_.\[\]]+)/gi;
  let match;
  while ((match = re.exec(cleanedSql)) !== null) {
    const raw = match[2];
    const parts = normalizeIdentifier(raw).split('.');
    tableNames.push(parts[parts.length - 1]);
  }
  return tableNames;
}

export function validateReadOnlySelect(sqlText, options = {}) {
  const allowedTables = new Set(
    (options.allowedTables || Array.from(DEFAULT_ALLOWED_TABLES)).map((t) => normalizeIdentifier(t))
  );

  if (typeof sqlText !== 'string' || !sqlText.trim()) {
    return { ok: false, reason: 'SQL is empty.' };
  }

  const cleaned = stripSqlCommentsAndStrings(sqlText);

  if (!isSingleStatement(cleaned)) {
    return { ok: false, reason: 'Only one SQL statement is allowed.' };
  }

  if (!startsWithSelect(cleaned)) {
    return { ok: false, reason: 'SQL must start with SELECT.' };
  }

  if (/\bselect\b[\s\S]*\binto\b/i.test(cleaned)) {
    return { ok: false, reason: 'SELECT INTO is not allowed.' };
  }

  for (const keyword of FORBIDDEN_KEYWORDS) {
    const re = new RegExp(`\\b${keyword}\\b`, 'i');
    if (re.test(cleaned)) {
      return { ok: false, reason: `Forbidden token detected: ${keyword}` };
    }
  }

  const tables = extractTableNames(cleaned);
  if (!tables.length) {
    return { ok: false, reason: 'Could not detect FROM/JOIN table names.' };
  }

  for (const table of tables) {
    if (!allowedTables.has(table)) {
      return { ok: false, reason: `Table not allowlisted: ${table}` };
    }
  }

  return { ok: true, reason: null, tables };
}

export function assertReadOnlySelect(sqlText, options = {}) {
  const result = validateReadOnlySelect(sqlText, options);
  if (!result.ok) {
    const err = new Error(result.reason || 'SQL validation failed.');
    err.code = 'READ_ONLY_SQL_VALIDATION_FAILED';
    throw err;
  }
  return result;
}

