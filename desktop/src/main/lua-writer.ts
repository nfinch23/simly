import { writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

type Serializable =
  | string
  | number
  | boolean
  | null
  | undefined
  | Serializable[]
  | { [key: string]: Serializable };

const LUA_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LUA_RESERVED = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function',
  'goto', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then',
  'true', 'until', 'while',
]);

/**
 * Serialize a JS object as a Lua source file with a single top-level
 * assignment: `<globalName> = { ... }`. Used to write
 * `SimlyResults.lua` for the addon. Strings are escaped, tables are
 * pretty-printed with 2-space indentation. The output is deterministic for
 * a given input (object key order is preserved per V8 insertion order).
 */
export function serializeLua(globalName: string, value: Serializable): string {
  if (!LUA_IDENT.test(globalName) || LUA_RESERVED.has(globalName)) {
    throw new Error(`Invalid Lua global name: ${globalName}`);
  }
  return `${globalName} = ${formatValue(value, 0)}\n`;
}

/**
 * Atomically write a Lua source file. Writes to `<path>.tmp` first, then
 * renames into place — the addon should never see a partial write.
 */
export async function writeLuaFile(
  path: string,
  globalName: string,
  value: Serializable,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, serializeLua(globalName, value), 'utf8');
  await rename(tmp, path);
}

function formatValue(value: Serializable, indent: number): string {
  if (value === null || value === undefined) return 'nil';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot serialize non-finite number: ${value}`);
    }
    return String(value);
  }
  if (typeof value === 'string') return formatString(value);
  if (Array.isArray(value)) return formatArray(value, indent);
  return formatObject(value, indent);
}

function formatString(value: string): string {
  // 1) Escape Lua-meaningful chars (backslash, quote, common whitespace).
  // 2) Escape every remaining non-printable-ASCII char (control chars
  //    + everything U+0080 and above) as \ddd byte sequences. The byte
  //    representation comes from UTF-8 encoding the original char and
  //    emitting one \ddd per byte. This keeps the .lua source pure
  //    ASCII so luaparse's pseudo-latin1 mode never trips on a
  //    multi-byte codepoint (e.g., U+2014 em dash → \226\128\148),
  //    while still round-tripping cleanly: WoW's Lua 5.1 parses \ddd
  //    as the original byte value and the displayed string renders as
  //    UTF-8 by default.
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/[^\x20-\x7e]/g, escapeCharAsBytes);
  return `"${escaped}"`;
}

function escapeCharAsBytes(ch: string): string {
  // Buffer.from handles surrogate pairs correctly: even though we're
  // iterating UTF-16 code units via String.replace, JS replace passes
  // the matched substring verbatim, and Buffer.from(str, 'utf8') will
  // emit the right multi-byte sequence for valid surrogate-pair chars.
  // Lone surrogates (invalid input) become U+FFFD.
  const bytes = Buffer.from(ch, 'utf8');
  let out = '';
  for (const b of bytes) {
    out += '\\' + b.toString().padStart(3, '0');
  }
  return out;
}

function formatArray(value: Serializable[], indent: number): string {
  if (value.length === 0) return '{}';
  const inner = '  '.repeat(indent + 1);
  const outer = '  '.repeat(indent);
  const items = value.map((v) => `${inner}${formatValue(v, indent + 1)},`);
  return `{\n${items.join('\n')}\n${outer}}`;
}

function formatObject(
  value: { [key: string]: Serializable },
  indent: number,
): string {
  const keys = Object.keys(value);
  if (keys.length === 0) return '{}';
  const inner = '  '.repeat(indent + 1);
  const outer = '  '.repeat(indent);
  const entries = keys.map((key) => {
    const formattedKey =
      LUA_IDENT.test(key) && !LUA_RESERVED.has(key)
        ? key
        : `[${formatString(key)}]`;
    return `${inner}${formattedKey} = ${formatValue(value[key], indent + 1)},`;
  });
  return `{\n${entries.join('\n')}\n${outer}}`;
}
