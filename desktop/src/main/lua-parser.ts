import { parse, type Statement, type Expression, type TableConstructorExpression } from 'luaparse';
import type { SimlyDB, SimlyResults } from '@simly/shared';

type LuaValue = string | number | boolean | null | LuaValue[] | { [key: string]: LuaValue };

/**
 * Parse a Simly SavedVariables Lua file and extract the
 * `SimlyDB` table. We only support a narrow subset of Lua: literal
 * tables, strings, numbers, booleans, nil. That's all the addon emits, and
 * any drift will throw — which is what we want.
 */
export function parseSavedVars(source: string): SimlyDB {
  const ast = parse(source, { comments: false, encodingMode: 'pseudo-latin1' });

  for (const stmt of ast.body) {
    const target = topLevelAssignmentTarget(stmt);
    if (target?.name !== 'SimlyDB') continue;
    const value = expressionToValue(target.init);
    if (!isPlainObject(value)) {
      throw new Error('SimlyDB is not a table');
    }
    return applyDefaults(value as unknown as SimlyDB);
  }

  throw new Error('SimlyDB assignment not found in SavedVariables file');
}

/**
 * Parse a Simly results Lua file and extract the `SimlyResults` table.
 * Returns undefined if the file doesn't contain a SimlyResults
 * assignment (placeholder file, partial write, etc.) — callers should
 * fall back to synthesizing a results object from other sources.
 *
 * Used by the quick-sim short-circuit: when "Update sims" returns
 * up_to_date or no_upgrades, we want to bump generated_at on the
 * existing results file so the addon's "fresh results" detection
 * fires without redoing the actual sim work.
 *
 * Encoding round-trip: lua-writer escapes non-ASCII chars as `\ddd`
 * UTF-8 byte sequences. luaparse's pseudo-latin1 mode reads `\ddd` as
 * 1-byte latin1 chars, which corrupts UTF-8-encoded strings (e.g.,
 * an em dash's 3 bytes 0xE2 0x80 0x94 become 3 separate latin1 code
 * points). To prevent every refresh cycle from doubling the byte
 * count (latin1 → re-encoded as UTF-8 → escaped as \ddd → next
 * cycle decodes those latin1 bytes again, etc.), this function walks
 * every parsed string and reinterprets its latin1 code units as
 * UTF-8 bytes. Result: ASCII strings round-trip cleanly, multi-byte
 * sequences round-trip back to their original codepoint, and refresh
 * cycles are idempotent.
 */
export function parseResultsFile(source: string): SimlyResults | undefined {
  const ast = parse(source, { comments: false, encodingMode: 'pseudo-latin1' });
  for (const stmt of ast.body) {
    const target = topLevelAssignmentTarget(stmt);
    if (target?.name !== 'SimlyResults') continue;
    const value = expressionToValue(target.init);
    if (!isPlainObject(value)) return undefined;
    return reinterpretLatin1AsUtf8(value) as unknown as SimlyResults;
  }
  return undefined;
}

/**
 * Walk a parsed Lua value and reinterpret every string's char codes
 * (which luaparse delivers as latin1, range 0x00-0xFF) as a sequence
 * of bytes that together form a UTF-8-encoded string. ASCII is a
 * subset of UTF-8 so pure-ASCII strings are unchanged. A 3-byte UTF-8
 * sequence like the em dash (0xE2 0x80 0x94) gets reassembled into
 * the single codepoint U+2014.
 */
function reinterpretLatin1AsUtf8(value: LuaValue): LuaValue {
  if (typeof value === 'string') {
    if (value.length === 0) return value;
    let allAscii = true;
    for (let i = 0; i < value.length; i++) {
      if (value.charCodeAt(i) > 0x7f) {
        allAscii = false;
        break;
      }
    }
    if (allAscii) return value;
    const bytes = Buffer.alloc(value.length);
    for (let i = 0; i < value.length; i++) bytes[i] = value.charCodeAt(i) & 0xff;
    return bytes.toString('utf8');
  }
  if (Array.isArray(value)) return value.map(reinterpretLatin1AsUtf8);
  if (typeof value === 'object' && value !== null) {
    const out: { [key: string]: LuaValue } = {};
    for (const k of Object.keys(value)) {
      out[k] = reinterpretLatin1AsUtf8((value as { [key: string]: LuaValue })[k] as LuaValue);
    }
    return out;
  }
  return value;
}

/**
 * Fill in v2-required fields for SavedVariables files that may pre-date
 * the schema bump. v1 files lack `update_requested_at` and
 * `active_scenario`; we default both rather than crash so the dev cycle
 * survives the transition (the addon's WriteSnapshot will write proper
 * v2 values on the next /reload). Phase-out: drop this once v1 files
 * are rare in the wild.
 */
function applyDefaults(db: SimlyDB): SimlyDB {
  if (typeof db.update_requested_at !== 'number') {
    db.update_requested_at = 0;
  }
  if (typeof db.active_scenario !== 'string') {
    db.active_scenario = 'single_target_patchwerk';
  }
  return db;
}

function topLevelAssignmentTarget(
  stmt: Statement,
): { name: string; init: Expression } | undefined {
  if (stmt.type !== 'AssignmentStatement') return undefined;
  const variable = stmt.variables[0];
  const init = stmt.init[0];
  if (!variable || !init) return undefined;
  if (variable.type !== 'Identifier') return undefined;
  return { name: variable.name, init };
}

function expressionToValue(expr: Expression): LuaValue {
  switch (expr.type) {
    case 'StringLiteral':
      return expr.value;
    case 'NumericLiteral':
      return expr.value;
    case 'BooleanLiteral':
      return expr.value;
    case 'NilLiteral':
      return null;
    case 'UnaryExpression':
      if (expr.operator === '-') {
        const inner = expressionToValue(expr.argument);
        if (typeof inner !== 'number') {
          throw new Error('Unary minus on non-number');
        }
        return -inner;
      }
      throw new Error(`Unsupported unary operator: ${expr.operator}`);
    case 'TableConstructorExpression':
      return tableToValue(expr);
    default:
      throw new Error(`Unsupported Lua expression type: ${expr.type}`);
  }
}

function tableToValue(table: TableConstructorExpression): LuaValue {
  const fields = table.fields;
  // Lua doesn't distinguish empty array from empty map. Our schema's
  // empty-table case is `requests = {}` (an array), so default to [].
  if (fields.length === 0) return [];

  const allArrayLike = fields.every((f) => f.type === 'TableValue');
  if (allArrayLike) {
    return fields.map((f) => {
      if (f.type !== 'TableValue') throw new Error('unreachable');
      return expressionToValue(f.value);
    });
  }

  const obj: { [key: string]: LuaValue } = {};
  for (const field of fields) {
    if (field.type === 'TableKeyString') {
      obj[field.key.name] = expressionToValue(field.value);
    } else if (field.type === 'TableKey') {
      const key = expressionToValue(field.key);
      if (typeof key !== 'string' && typeof key !== 'number') {
        throw new Error(`Unsupported table key type: ${typeof key}`);
      }
      obj[String(key)] = expressionToValue(field.value);
    } else {
      throw new Error(
        `Mixed array-like and key-value fields in table — Simly schemas should not produce this`,
      );
    }
  }
  return obj;
}

function isPlainObject(value: LuaValue): value is { [key: string]: LuaValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
