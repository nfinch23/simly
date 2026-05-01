import { describe, expect, it } from 'vitest';
import { parseSavedVars } from './lua-parser';

describe('parseSavedVars', () => {
  it('parses a representative SimlyDB block', () => {
    const source = `
SimlyDB = {
  schema_version = 1,
  exported_at = 1714435200,
  character = {
    name = "Charname",
    realm = "Stormrage",
    region = "us",
    class = "WARRIOR",
    spec = "Arms",
    level = 80,
  },
  simc_export = "warrior=\\"Charname\\"\\nlevel=80\\nrace=human\\n",
  requests = {},
}
`;
    const db = parseSavedVars(source);
    expect(db.schema_version).toBe(1);
    expect(db.exported_at).toBe(1714435200);
    expect(db.character.name).toBe('Charname');
    expect(db.character.region).toBe('us');
    expect(db.character.level).toBe(80);
    expect(db.simc_export).toContain('level=80');
    expect(db.requests).toEqual([]);
  });

  it('handles a populated requests array', () => {
    const source = `
SimlyDB = {
  schema_version = 1,
  exported_at = 100,
  character = { name = "X", realm = "Y", region = "us", class = "MAGE", spec = "Fire", level = 1 },
  simc_export = "",
  requests = {
    { id = "best_dungeon", queued_at = 200 },
    { id = "best_flask", queued_at = 201 },
  },
}
`;
    const db = parseSavedVars(source);
    expect(db.requests).toHaveLength(2);
    expect(db.requests[0]?.id).toBe('best_dungeon');
    expect(db.requests[1]?.queued_at).toBe(201);
  });

  it('throws when the global is missing', () => {
    expect(() => parseSavedVars('SomethingElse = {}')).toThrow(/not found/);
  });

  it('throws on unsupported expressions', () => {
    expect(() =>
      parseSavedVars('SimlyDB = { x = 1 + 2 }'),
    ).toThrow(/Unsupported/);
  });

  it('parses negative numbers via unary minus', () => {
    const db = parseSavedVars(`
SimlyDB = {
  schema_version = 1,
  exported_at = 0,
  character = { name = "X", realm = "Y", region = "us", class = "MAGE", spec = "Fire", level = 1 },
  simc_export = "",
  requests = {},
  delta = -3,
}
`) as unknown as { delta: number };
    expect(db.delta).toBe(-3);
  });
});
