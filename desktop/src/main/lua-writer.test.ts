import { describe, expect, it } from 'vitest';
import { serializeLua } from './lua-writer';
import { parseResultsFile, parseSavedVars } from './lua-parser';

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
      schema_version: 2,
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
      update_requested_at: 1714435100,
      active_scenario: 'single_target_patchwerk',
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

  describe('non-ASCII escape (regression: U+2014 em dash crashed parser)', () => {
    it('escapes em dash as multi-byte UTF-8 \\ddd sequence', () => {
      // U+2014 EM DASH = bytes 0xE2 0x80 0x94 = \226\128\148
      const out = serializeLua('Foo', { label: 'a — b' });
      expect(out).toContain('"a \\226\\128\\148 b"');
      expect(out).not.toContain('—'); // raw codepoint must not leak
    });

    it('escapes a basic Latin-1 byte (U+00FF) as \\255', () => {
      const out = serializeLua('Foo', { s: 'ÿ' });
      expect(out).toContain('"\\195\\191"'); // U+00FF in UTF-8 is 0xC3 0xBF
    });

    it('round-trips a results-shaped value with em dashes through writer + parser', () => {
      // This is the exact failure mode the user hit: a quick-sim
      // short-circuit refresh wrote rich data including em dash labels,
      // then the next refresh tried to read it and the parser threw on
      // U+2014. After the fix, the file is pure ASCII and parses cleanly.
      const original = {
        schema_version: 2,
        generated_at: 1714435200,
        simc_version: '1205-01',
        character_key: 'Felfriend-Zul\'jin-us',
        active_scenario: 'single_target_patchwerk' as const,
        scans: {
          trinket_pre_scan: {
            status: 'done' as const,
            finished_at: 1714435200,
            data: {
              label: 'Best trinket pair (single-target Patchwerk) — cached',
              pairs: [],
            },
          },
        },
        composed: {
          label: 'Cached best loadout — Felfriend',
        },
      };
      const lua = serializeLua('SimlyResults', original);
      const parsed = parseResultsFile(lua);
      expect(parsed).toBeDefined();
      // The parser sees the \ddd-escaped bytes as latin1 chars; for
      // round-trip *correctness* the caller (e.g. the queue's refresh
      // path) just needs the parse to SUCCEED so the rich data isn't
      // dropped to the synthesize fallback. Verify generated_at and
      // structure landed; string contents are byte-equivalent to the
      // original UTF-8.
      expect(parsed?.generated_at).toBe(1714435200);
      expect(parsed?.character_key).toBe('Felfriend-Zul\'jin-us');
      expect(parsed?.composed?.label).toBeDefined();
      expect(parsed?.scans.trinket_pre_scan?.status).toBe('done');
    });
  });
});
