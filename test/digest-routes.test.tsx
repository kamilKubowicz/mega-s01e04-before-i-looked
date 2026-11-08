import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { NightDigest } from '../src/digest/types.js';

// Fixtures live in a temp runs dir; the real runs/ is never read or written.
const GOOD_NIGHT = '2026-10-28';
const EMPTY_NIGHT = '2026-10-29';
const BAD_NIGHT = '2026-10-30';
const MISSING_NIGHT = '2026-01-01';

const good = [
  '{"at":"2026-10-28T23:00:00+01:00","job":"zeta/last","status":"ok","owner":"rook"}',
  '{"at":"2026-10-28T23:01:00+01:00","job":"alpha/first","status":"retry","owner":null,"error":"upstream 503"}',
  '{"at":"2026-10-28T23:02:00+01:00","job":"alpha/first","status":"retry","owner":null,"error":"upstream 503"}',
  '{"at":"2026-10-28T23:03:00+01:00","job":"alpha/first","status":"retry","owner":null}',
  '{"at":"2026-10-28T23:04:00+01:00","job":"mid/fail","status":"fail","owner":"lane-07","error":"quota"}',
];

const JOBS_IN_ORDER = ['alpha/first', 'mid/fail', 'zeta/last'];

let runsDir: string;
let config: { adapter: string; installed: string; beatEverySeconds: number; runsDir: string };

beforeAll(() => {
  runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-'));
  fs.writeFileSync(path.join(runsDir, `${GOOD_NIGHT}.jsonl`), good.join('\n') + '\n');
  fs.writeFileSync(path.join(runsDir, `${EMPTY_NIGHT}.jsonl`), '');
  fs.writeFileSync(
    path.join(runsDir, `${BAD_NIGHT}.jsonl`),
    [
      '{"at":"2026-10-30T23:00:00+01:00","job":"zeta/last","status":"ok","owner":"rook"}',
      '{"at":"2026-10-30T23:01:00+01:00","job":"alpha/first","status":"ok","owner":"rook"',
      '{"at":"2026-10-30T23:02:00+01:00","job":"alpha/first","status":"ok","owner":"rook"}',
    ].join('\n') + '\n',
  );
  config = { adapter: 'shim', installed: '2026-10-29T14:06:00+01:00', beatEverySeconds: 60, runsDir };
});

afterAll(() => {
  fs.rmSync(runsDir, { recursive: true, force: true });
});

/** The `<tr>` segments of the page that mention a job, one per job expected. */
function rowsFor(html: string, job: string): string[] {
  return html
    .split('<tr')
    .slice(1)
    .filter((segment) => segment.includes(job));
}

describe('GET /digest/:night (page)', () => {
  it('answers 200 with one row per job, in job order', async () => {
    const res = await createApp(config).request(`/digest/${GOOD_NIGHT}`);
    const html = await res.text();
    expect(res.status).toBe(200);

    for (const job of JOBS_IN_ORDER) {
      expect(rowsFor(html, job)).toHaveLength(1);
    }
    const positions = JOBS_IN_ORDER.map((job) => html.indexOf(job));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('marks a row with retries >= 3 or any fail as warn, and no other', async () => {
    const html = await (await createApp(config).request(`/digest/${GOOD_NIGHT}`)).text();
    expect(rowsFor(html, 'alpha/first')[0]).toContain('class="warn"');
    expect(rowsFor(html, 'mid/fail')[0]).toContain('class="warn"');
    expect(rowsFor(html, 'zeta/last')[0]).not.toContain('class="warn"');
  });

  it('renders a null owner as —', async () => {
    const html = await (await createApp(config).request(`/digest/${GOOD_NIGHT}`)).text();
    expect(rowsFor(html, 'alpha/first')[0]).toContain('—');
    expect(rowsFor(html, 'zeta/last')[0]).toContain('rook');
  });

  it('answers 404 with "no run log for <night>" for a night with no file', async () => {
    const res = await createApp(config).request(`/digest/${MISSING_NIGHT}`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain(`no run log for ${MISSING_NIGHT}`);
  });

  it('renders "nothing ran" for an empty night', async () => {
    const res = await createApp(config).request(`/digest/${EMPTY_NIGHT}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('nothing ran');
  });

  it('shows the good jobs and the bad-line count for a night with a bad line', async () => {
    const res = await createApp(config).request(`/digest/${BAD_NIGHT}`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(rowsFor(html, 'zeta/last')).toHaveLength(1);
    expect(rowsFor(html, 'alpha/first')).toHaveLength(1);
    expect(html).toContain('1 line(s) did not parse');
  });

  it('answers 404 for names that are not YYYY-MM-DD', async () => {
    const app = createApp(config);
    expect((await app.request('/digest/..%2Fsecret')).status).toBe(404);
    expect((await app.request('/digest/2026-10-28.jsonl')).status).toBe(404);
  });
});

describe('GET /api/digest/:night (JSON)', () => {
  it('answers 200 with the NightDigest, rows sorted by job', async () => {
    const res = await createApp(config).request(`/api/digest/${GOOD_NIGHT}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as NightDigest;
    expect(body).toEqual({
      night: GOOD_NIGHT,
      rows: [
        {
          job: 'alpha/first',
          owner: null,
          runs: 3,
          retries: 3,
          fails: 0,
          lastStatus: 'retry',
          lastError: 'upstream 503',
          firstAt: '2026-10-28T23:01:00+01:00',
          lastAt: '2026-10-28T23:03:00+01:00',
        },
        {
          job: 'mid/fail',
          owner: 'lane-07',
          runs: 1,
          retries: 0,
          fails: 1,
          lastStatus: 'fail',
          lastError: 'quota',
          firstAt: '2026-10-28T23:04:00+01:00',
          lastAt: '2026-10-28T23:04:00+01:00',
        },
        {
          job: 'zeta/last',
          owner: 'rook',
          runs: 1,
          retries: 0,
          fails: 0,
          lastStatus: 'ok',
          lastError: null,
          firstAt: '2026-10-28T23:00:00+01:00',
          lastAt: '2026-10-28T23:00:00+01:00',
        },
      ],
      badLines: 0,
      counts: { ok: 1, retry: 3, fail: 1 },
    });
  });

  it('answers 404 with { error, night } for a night with no file', async () => {
    const res = await createApp(config).request(`/api/digest/${MISSING_NIGHT}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no run log', night: MISSING_NIGHT });
  });

  it('answers 200 with no rows and badLines 0 for an empty night', async () => {
    const res = await createApp(config).request(`/api/digest/${EMPTY_NIGHT}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as NightDigest;
    expect(body.rows).toEqual([]);
    expect(body.badLines).toBe(0);
  });

  it('counts the bad line and keeps the good jobs', async () => {
    const res = await createApp(config).request(`/api/digest/${BAD_NIGHT}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as NightDigest;
    expect(body.badLines).toBe(1);
    expect(body.rows.map((row) => row.job)).toEqual(['alpha/first', 'zeta/last']);
  });

  it('answers 404 for names that are not YYYY-MM-DD', async () => {
    const app = createApp(config);
    expect((await app.request('/api/digest/..%2Fsecret')).status).toBe(404);
    expect((await app.request('/api/digest/2026-10-28.jsonl')).status).toBe(404);
  });

  it('lists the same jobs in the same order as the page', async () => {
    const app = createApp(config);
    const html = await (await app.request(`/digest/${GOOD_NIGHT}`)).text();
    const body = (await (await app.request(`/api/digest/${GOOD_NIGHT}`)).json()) as NightDigest;
    const pageOrder = JOBS_IN_ORDER.map((job) => html.indexOf(job));
    expect(pageOrder).toEqual([...pageOrder].sort((a, b) => a - b));
    expect(body.rows.map((row) => row.job)).toEqual(JOBS_IN_ORDER);
  });
});
