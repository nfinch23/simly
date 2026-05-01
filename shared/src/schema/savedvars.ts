/**
 * SavedVariables schema written by the addon and read by the desktop app.
 * Mirrors SCOPE.md section 4 verbatim. Bump SAVEDVARS_SCHEMA_VERSION on any
 * breaking change; the desktop must refuse unknown versions.
 */

export const SAVEDVARS_SCHEMA_VERSION = 1;

export type Region = 'us' | 'eu' | 'kr' | 'tw' | 'cn';

export interface SavedVarsCharacter {
  name: string;
  realm: string;
  region: Region;
  class: string;
  spec: string;
  level: number;
}

export interface SavedVarsRequest {
  id: string;
  queued_at: number;
}

export interface SimlyDB {
  schema_version: number;
  exported_at: number;
  character: SavedVarsCharacter;
  simc_export: string;
  requests: SavedVarsRequest[];
}
