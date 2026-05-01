import { join } from 'node:path';

export interface SimcPaths {
  binPath: string;
  scratchDir: string;
}

export function resolveSimcPaths(override?: Partial<SimcPaths>): SimcPaths {
  const localAppData = process.env['LOCALAPPDATA'];
  if (!localAppData) {
    throw new Error('LOCALAPPDATA env var not set; cannot resolve SimC paths');
  }
  const simlyRoot = join(localAppData, 'Simly');
  return {
    binPath: override?.binPath ?? join(simlyRoot, 'simc', 'current', 'simc.exe'),
    scratchDir: override?.scratchDir ?? join(simlyRoot, 'scratch'),
  };
}
