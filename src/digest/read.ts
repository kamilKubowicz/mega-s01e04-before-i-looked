import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUN_STATUSES, type DigestRow, type NightDigest, type ReadNight, type RunLine, type RunStatus } from './types.js';

// Plan morning-digest § 1. The contract (what a bad line is, sorting, null vs empty) is in
// types.ts; this file only keeps it.

const NIGHT = /^\d{4}-\d{2}-\d{2}$/;
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

export const readNight: ReadNight = (runsDir, night) => {
  if (!NIGHT.test(night)) return null;
  let text: string;
  try {
    text = readFileSync(join(runsDir, `${night}.jsonl`), 'utf8');
  } catch (err) {
    if (isNoSuchFile(err)) return null;
    throw err;
  }
  return digestNight(night, text);
};

/** The whole night from the file's text. Pure: no disk, never throws. */
export function digestNight(night: string, text: string): NightDigest {
  const byJob = new Map<string, DigestRow>();
  const counts: Record<RunStatus, number> = { ok: 0, retry: 0, fail: 0 };
  let badLines = 0;

  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    const line = parseLine(raw);
    if (!line) {
      badLines++;
      continue;
    }
    counts[line.status]++;
    const row = byJob.get(line.job);
    if (!row) {
      byJob.set(line.job, {
        job: line.job,
        owner: line.owner,
        runs: 1,
        retries: line.status === 'retry' ? 1 : 0,
        fails: line.status === 'fail' ? 1 : 0,
        lastStatus: line.status,
        lastError: line.error,
        firstAt: line.at,
        lastAt: line.at,
      });
      continue;
    }
    row.runs++;
    if (line.status === 'retry') row.retries++;
    if (line.status === 'fail') row.fails++;
    row.lastStatus = line.status;
    row.lastAt = line.at;
    if (line.owner !== null) row.owner = line.owner;
    if (line.error !== null) row.lastError = line.error;
  }

  const rows = [...byJob.values()].sort((a, b) => (a.job < b.job ? -1 : a.job > b.job ? 1 : 0));
  return { night, rows, badLines, counts };
}

/** One line of the log, or null when it doesn't fit `RunLine`. */
export function parseLine(raw: string): RunLine | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const o: Record<string, unknown> = { ...value };

  const { at, job, status } = o;
  if (typeof at !== 'string' || !AT.test(at)) return null;
  if (typeof job !== 'string' || job.trim() === '') return null;
  if (!isRunStatus(status)) return null;
  const owner = optionalText(o.owner);
  const error = optionalText(o.error);
  if (owner === undefined || error === undefined) return null;

  return { at, job, status, owner, error };
}

function isRunStatus(v: unknown): v is RunStatus {
  return RUN_STATUSES.some((s) => s === v);
}

// Missing, null or blank → null (it renders as `—`, never as an empty cell); a string is kept
// verbatim; anything else → undefined, which makes the line bad.
function optionalText(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return undefined;
  return v.trim() === '' ? null : v;
}

function isNoSuchFile(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err.code === 'ENOENT' || err.code === 'ENOTDIR');
}
