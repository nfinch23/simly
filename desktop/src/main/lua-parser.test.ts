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
    expect(db.update_requested_at).toBe(0);
    expect(db.active_scenario).toBe('single_target_patchwerk');
  });

  it('parses update_requested_at and active_scenario from a v2 snapshot', () => {
    const source = `
SimlyDB = {
  schema_version = 2,
  exported_at = 100,
  character = { name = "X", realm = "Y", region = "us", class = "MAGE", spec = "Fire", level = 1 },
  simc_export = "",
  update_requested_at = 1714435200,
  active_scenario = "single_target_patchwerk",
}
`;
    const db = parseSavedVars(source);
    expect(db.update_requested_at).toBe(1714435200);
    expect(db.active_scenario).toBe('single_target_patchwerk');
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
