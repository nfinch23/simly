import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cpus } from 'node:os';
import type { SimcPaths } from './simc-paths';

/** Subset the runner actually needs — `installRoot` is irrelevant once the binary is located. */
export type RunnerPaths = Pick<SimcPaths, 'binPath' | 'scratchDir'>;

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
  /**
   * Full parsed json2 output. Typed loosely (`unknown`) so each scan
   * casts to its own narrowed view — profileset scans use this.profilesets,
   * stat-weights scans dig into `sim.players[0].scale_factors`, future
   * scans can read whatever they need without us extending this type.
   */
  rawJson: unknown;
}

export interface RunSimcOptions {
  paths: RunnerPaths;
  profileScript: string;
  iterations?: number;
  threads?: number;
  scratchTag?: string;
  /**
   * Optional progress callback. Receives every non-empty line SimC
   * prints to stdout/stderr while running, plus a synthetic
   * `__exit__` line on close. Lets the queue update the window title
   * and log progress without waiting for the subprocess to finish.
   * Lines are pre-trimmed; use the `stream` field to filter (`stdout`
   * / `stderr` / `meta`) when relevant.
   */
  onProgress?: (event: { stream: 'stdout' | 'stderr' | 'meta'; line: string }) => void;
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
  const onProgress = opts.onProgress;
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(paths.binPath, [inputPath], { windowsHide: true });

    // Buffer line fragments per stream — SimC chunks output mid-line, so
    // we only emit a progress line when we see a newline. Anything left
    // in the buffer at close gets flushed.
    let stdoutBuf = '';
    let stderrBuf = '';
    const emitLines = (
      stream: 'stdout' | 'stderr',
      buf: string,
      forceFlush: boolean,
    ): string => {
      const parts = buf.split(/\r?\n/);
      const remainder = forceFlush ? '' : parts.pop() ?? '';
      for (const raw of parts) {
        const line = raw.trim();
        if (line.length === 0) continue;
        if (onProgress) onProgress({ stream, line });
      }
      return remainder;
    };

    child.stdout.on('data', (chunk: Buffer) => {
      const s = chunk.toString();
      stdout.push(s);
      stdoutBuf = emitLines('stdout', stdoutBuf + s, false);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const s = chunk.toString();
      stderr.push(s);
      stderrBuf = emitLines('stderr', stderrBuf + s, false);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (stdoutBuf.length > 0) emitLines('stdout', stdoutBuf, true);
      if (stderrBuf.length > 0) emitLines('stderr', stderrBuf, true);
      resolve(code ?? -1);
    });
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
    rawJson: json,
  };
}
