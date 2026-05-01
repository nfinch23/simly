import { describe, expect, it } from 'vitest';
import { serializeLua } from './lua-writer';
import { parseSavedVars } from './lua-parser';

describe('serializeLua', () => {
  it('emits a top-level assignment', () => {
    const out = serializeLua('Foo', { x: 1 });
    expect(out).toMatch(/^Foo = \{/);
    expect(out.endsWith('\n')).toBe(true);
  });

  it('escapes strings', () => {
    const out = serializeLua('Foo', { s: 'a"b\nc\\d' });
    expect(out).toContain('"a\\"b\\nc\\\\d"');
  });

  it('quotes keys that are not valid Lua identifiers', () => {
    const out = serializeLua('Foo', { 'has space': 1, _ok: 2, '123': 3 });
    expect(out).toContain('["has space"] = 1');
    expect(out).toContain('_ok = 2');
    expect(out).toContain('["123"] = 3');
  });

  it('round-trips through the parser as SimlyDB-shaped data', () => {
    const original = {
      schema_version: 1,
      exported_at: 1714435200,
      character: {
        name: 'Charname',
        realm: 'Stormrage',
        region: 'us',
        class: 'WARRIOR',
        spec: 'Arms',
        level: 80,
      },
      simc_export: 'warrior="Charname"\nlevel=80\n',
      requests: [{ id: 'best_flask', queued_at: 1 }],
    };
    const lua = serializeLua('SimlyDB', original);
    expect(parseSavedVars(lua)).toEqual(original);
  });

  it('rejects invalid Lua global names', () => {
    expect(() => serializeLua('1bad', {})).toThrow(/Invalid/);
    expect(() => serializeLua('end', {})).toThrow(/Invalid/);
  });

  it('rejects non-finite numbers', () => {
    expect(() => serializeLua('Foo', { x: Infinity })).toThrow(/non-finite/);
    expect(() => serializeLua('Foo', { x: NaN })).toThrow(/non-finite/);
  });
});
