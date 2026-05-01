import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cpus } from 'node:os';
import type { SimcPaths } from './simc-paths';

export interface ProfilesetResult {
  name: string;
  mean: number;
  stddev: number;
  iterations: number;
}

export interface SimcRunResult {
  simcVersion: string;
  gitRevision: string;
  buildDate: string;
  profilesets: ProfilesetResult[];
  rawJsonPath: string;
}

export interface RunSimcOptions {
  paths: SimcPaths;
  profileScript: string;
  iterations?: number;
  threads?: number;
  scratchTag?: string;
}

interface SimcJson2 {
  version: string;
  git_revision: string;
  build_date: string;
  sim: {
    profilesets?: {
      results: Array<{
        name: string;
        mean: number;
        stddev: number;
        iterations: number;
      }>;
    };
  };
}

export async function runSimc(opts: RunSimcOptions): Promise<SimcRunResult> {
  const { paths, profileScript } = opts;
  const iterations = opts.iterations ?? 1000;
  const threads = opts.threads ?? Math.max(1, Math.floor(cpus().length / 2));
  const tag = opts.scratchTag ?? `run-${Date.now()}`;

  if (!existsSync(paths.binPath)) {
    throw new Error(
      `SimC binary not found at ${paths.binPath}. Drop a build into %LOCALAPPDATA%\\Simly\\simc\\current\\ or override the path.`,
    );
  }

  await mkdir(paths.scratchDir, { recursive: true });
  const inputPath = join(paths.scratchDir, `${tag}.simc`);
  const outputPath = join(paths.scratchDir, `${tag}.json`);

  // SimC respects the last value for repeated keys, so we always append our
  // own iterations/threads/json2 lines after the user-supplied script. This
  // way the caller can still override by putting them at the very end.
  const fullScript = [
    profileScript.trim(),
    '',
    `iterations=${iterations}`,
    `threads=${threads}`,
    `json2=${outputPath}`,
    '',
  ].join('\n');

  await writeFile(inputPath, fullScript, 'utf8');

  const stderr: string[] = [];
  const stdout: string[] = [];
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(paths.binPath, [inputPath], { windowsHide: true });
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? -1));
  });

  if (exitCode !== 0) {
    throw new Error(
      `simc exited with code ${exitCode}. stderr:\n${stderr.join('').slice(-2000)}\nstdout tail:\n${stdout.join('').slice(-1000)}`,
    );
  }

  if (!existsSync(outputPath)) {
    throw new Error(
      `simc finished cleanly but did not write JSON output at ${outputPath}. stdout tail:\n${stdout.join('').slice(-1000)}`,
    );
  }

  const json = JSON.parse(await readFile(outputPath, 'utf8')) as SimcJson2;
  const results = json.sim.profilesets?.results ?? [];

  return {
    simcVersion: json.version,
    gitRevision: json.git_revision,
    buildDate: json.build_date,
    profilesets: results.map((r) => ({
      name: r.name,
      mean: r.mean,
      stddev: r.stddev,
      iterations: r.iterations,
    })),
    rawJsonPath: outputPath,
  };
}
