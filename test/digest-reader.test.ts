import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readNight } from '../src/digest/read.js';

// runs/ is read-only (AGENTS.md): the real nights are only read, anything else goes in a temp dir.
const tmp = mkdtempSync(join(tmpdir(), 'rig-digest-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function night(name: string, text: string): string {
  writeFileSync(join(tmp, `${name}.jsonl`), text);
  return name;
}

describe('readNight on runs/2026-10-28.jsonl', () => {
  const digest = readNight('runs', '2026-10-28');

  it('reads 5 jobs, sorted by job, and counts the cut-off last line as 1 bad line', () => {
    expect(digest).not.toBeNull();
    expect(digest?.night).toBe('2026-10-28');
    expect(digest?.rows.map((r) => r.job)).toEqual([
      'digest/render',
      'fixtures/refresh',
      'lane/sync',
      'notes/backup',
      'rig/rotate-logs',
    ]);
    expect(digest?.badLines).toBe(1);
  });

  it('counts run lines per status', () => {
    expect(digest?.counts).toEqual({ ok: 10, retry: 4, fail: 1 });
  });

  it('keeps the retried job with its last error and the times as written', () => {
    expect(digest?.rows.find((r) => r.job === 'fixtures/refresh')).toEqual({
      job: 'fixtures/refresh',
      owner: 'rook',
      runs: 4,
      retries: 3,
      fails: 0,
      lastStatus: 'ok',
      lastError: 'upstream 503',
      firstAt: '2026-10-29T01:30:00+01:00',
      lastAt: '2026-10-29T01:37:00+01:00',
    });
  });

  it('keeps the job whose owner is null', () => {
    expect(digest?.rows.find((r) => r.job === 'digest/render')).toEqual({
      job: 'digest/render',
      owner: null,
      runs: 1,
      retries: 0,
      fails: 0,
      lastStatus: 'ok',
      lastError: null,
      firstAt: '2026-10-29T05:41:09+01:00',
      lastAt: '2026-10-29T05:41:09+01:00',
    });
  });

  it('keeps the failed job and spans a job across midnight', () => {
    const backup = digest?.rows.find((r) => r.job === 'notes/backup');
    expect(backup).toMatchObject({ fails: 1, lastStatus: 'fail', lastError: 'quota exceeded', owner: 'lane-07' });
    const sync = digest?.rows.find((r) => r.job === 'lane/sync');
    expect(sync).toMatchObject({
      runs: 8,
      retries: 1,
      lastError: 'lock held',
      firstAt: '2026-10-28T23:00:06+01:00',
      lastAt: '2026-10-29T05:00:04+01:00',
    });
  });
});

describe('readNight on runs/2026-10-27.jsonl', () => {
  it('reads a clean night', () => {
    const digest = readNight('runs', '2026-10-27');
    expect(digest?.rows.map((r) => r.job)).toEqual(['fixtures/refresh', 'lane/sync', 'notes/backup', 'rig/rotate-logs']);
    expect(digest?.badLines).toBe(0);
    expect(digest?.counts).toEqual({ ok: 7, retry: 0, fail: 0 });
  });
});

describe('readNight: no file vs empty file', () => {
  it('returns null for a night with no file', () => {
    expect(readNight(tmp, '2026-01-01')).toBeNull();
  });

  it('returns null when the runs dir itself is missing', () => {
    expect(readNight(join(tmp, 'nope'), '2026-01-01')).toBeNull();
  });

  it('gives zero rows, not null, for an empty file', () => {
    expect(readNight(tmp, night('2026-02-01', ''))).toEqual({
      night: '2026-02-01',
      rows: [],
      badLines: 0,
      counts: { ok: 0, retry: 0, fail: 0 },
    });
  });

  it('treats a night that is not YYYY-MM-DD as no file, even when the path would exist', () => {
    expect(readNight('runs', '../x')).toBeNull();
    // Unchecked, this would resolve to runs/2026-10-28.jsonl.
    expect(readNight('runs/nope', '../2026-10-28')).toBeNull();
    expect(readNight('runs', '2026-10-28.jsonl')).toBeNull();
    expect(readNight('runs', '')).toBeNull();
  });

  it('does not hide other I/O errors as no file', () => {
    mkdirSync(join(tmp, '2026-03-01.jsonl'));
    expect(() => readNight(tmp, '2026-03-01')).toThrow();
  });
});

describe('readNight: bad lines are counted, never thrown', () => {
  it('counts every line that does not fit and keeps the rest', () => {
    const lines = [
      '{"at":"2026-04-01T23:00:00+02:00","job":"a","status":"ok","owner":"rook"}',
      '',
      '   ',
      'not json',
      '[]',
      'null',
      '42',
      '{"at":"2026-04-01T23:00:00","job":"a","status":"ok","owner":"rook"}', // no offset
      '{"at":"2026-04-01T23:00:00Z","job":"","status":"ok","owner":"rook"}', // empty job
      '{"at":"2026-04-01T23:00:00Z","job":"a","status":"skipped","owner":"rook"}', // unknown status
      '{"at":"2026-04-01T23:00:00Z","job":"a","status":"ok","owner":7}', // owner not a string
      '{"at":"2026-04-01T23:00:00Z","job":"a","status":"ok","owner":"rook","error":{}}', // error not a string
      '{"at":"2026-04-02T00:10:00+02:00","job":"a","status":"retry","error":"boom"}\r', // no owner key, CRLF
      '{"at":"2026-04-02T00:20:00+02:00","job":"a","status":"ok","owner":"","error":""}', // blank owner/error
    ];
    const digest = readNight(tmp, night('2026-04-01', lines.join('\n') + '\n'));
    expect(digest?.badLines).toBe(9);
    expect(digest?.counts).toEqual({ ok: 2, retry: 1, fail: 0 });
    expect(digest?.rows).toEqual([
      {
        job: 'a',
        owner: 'rook',
        runs: 3,
        retries: 1,
        fails: 0,
        lastStatus: 'ok',
        lastError: 'boom',
        firstAt: '2026-04-01T23:00:00+02:00',
        lastAt: '2026-04-02T00:20:00+02:00',
      },
    ]);
  });

  it('gives zero rows when no line parses', () => {
    const digest = readNight(tmp, night('2026-05-01', 'garbage\n{"job":\n'));
    expect(digest?.rows).toEqual([]);
    expect(digest?.badLines).toBe(2);
  });
});
