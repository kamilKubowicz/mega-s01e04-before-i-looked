// Plan morning-digest § 1: the contract of the run log reader. Every part of § 2 (page, JSON,
// board link, route tests) builds against this file alone. The reader itself lives in
// src/digest/read.ts and is imported as:
//
//   import { readNight } from './digest/read.js'; // readNight: ReadNight
//
// All of it is plain JSON-safe data (strings, numbers, null, arrays; no Date, no undefined), so
// the page and `c.json()` serve the very same values and can never disagree (ADR 0001).

/** The statuses a run line can carry, in the order the board shows them. */
export const RUN_STATUSES = ['ok', 'retry', 'fail'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * One line of `runs/<night>.jsonl` that parsed. Any other line is bad: counted in
 * `NightDigest.badLines`, never thrown. A line parses when it is a JSON object with
 * - `at`: ISO 8601 date-time with an offset (`Z` or `±hh:mm`), kept verbatim;
 * - `job`: non-empty string;
 * - `status`: one of `RUN_STATUSES`;
 * - `owner`: string or `null` (a missing key reads as `null`);
 * - `error`, optional: string or `null` (a missing key reads as `null`).
 * Other keys are ignored. Blank lines (such as after the final newline) are skipped, not counted.
 */
export type RunLine = {
  at: string;
  job: string;
  status: RunStatus;
  owner: string | null;
  error: string | null;
};

/**
 * One row per job in a night. "First" and "most recent" mean file order: the log is appended as
 * jobs run, so file order is time order. The reader never re-sorts by `at`, never does offset
 * arithmetic and never converts to UTC.
 */
export type DigestRow = {
  /** Job name as in the log. Unique within a night. */
  job: string;
  /**
   * Owner from the most recent line of this job that names one; `null` when no line does. The
   * row is kept either way; the view renders `null` as `—`.
   */
  owner: string | null;
  /** Parsed lines of this job: every attempt counts, retries and fails included. Always >= 1. */
  runs: number;
  /** Lines of this job with status `retry`. The page marks the row at 3 or more. */
  retries: number;
  /** Lines of this job with status `fail`. The page marks the row when > 0 (any `fail`). */
  fails: number;
  /** Status of this job's most recent line. */
  lastStatus: RunStatus;
  /**
   * `error` of the most recent line of this job that has one, or `null` when no line does. It can
   * be set while `lastStatus` is `ok`: the error of an earlier retry stays visible.
   */
  lastError: string | null;
  /** `at` of this job's first line, verbatim with its offset. */
  firstAt: string;
  /** `at` of this job's most recent line, verbatim with its offset. Equals `firstAt` if runs is 1. */
  lastAt: string;
};

/**
 * Parsed run lines per status for a whole night, not jobs per last status: each line counts once
 * under its own `status`. So `ok + retry + fail` is the sum of `runs` over the rows, and bad lines
 * are in none of them.
 */
export type StatusCounts = Record<RunStatus, number>;

/** What `readNight` returns for a night whose file exists. */
export type NightDigest = {
  /** The night asked for, `YYYY-MM-DD`; the file read was `<runsDir>/<night>.jsonl`. */
  night: string;
  /**
   * One row per job, already sorted ascending by `job` with plain string comparison (code-unit
   * order, not locale). The page and the JSON use this order as-is. Empty when the file is empty
   * or no line in it parsed: the page renders "nothing ran" (and `badLines` if > 0).
   */
  rows: DigestRow[];
  /** Lines that did not parse (see `RunLine`). 0 for a clean night. */
  badLines: number;
  /** Run lines per status (see `StatusCounts`); the board shows them beside the night's link. */
  counts: StatusCounts;
};

/**
 * Reads one night's run log. Synchronous, like rig's other file reads.
 *
 * - `runsDir`: the runs directory, as `RigConfig.runsDir` (`'runs'`), or a temp dir in tests.
 * - `night`: must match `YYYY-MM-DD`. Anything else (`../x`, `2026-10-28.jsonl`, `''`) is no file:
 *   `null`, without touching the disk, so no path traversal.
 * - Returns `null` when there is no file for the night (the routes answer 404), else a
 *   `NightDigest`. An empty file is not "no file": it gives `rows: []`, `badLines: 0`,
 *   all counts 0 (the page renders "nothing ran").
 * - Never throws over file content. I/O errors other than "no such file" (e.g. permission
 *   denied) are not hidden as `null`; they propagate.
 *
 * Example, `readNight('runs', '2026-10-28')`: `badLines: 1` (the cut-off last line),
 * `counts: { ok: 10, retry: 4, fail: 1 }`, rows in this order (times are
 * `2026-10-29Thh:mm:ss+01:00` unless written in full):
 *
 *   job              owner    runs retries fails lastStatus lastError        firstAt .. lastAt
 *   digest/render    null        1       0     0 ok         null             05:41:09 .. 05:41:09
 *   fixtures/refresh rook        4       3     0 ok         upstream 503     01:30:00 .. 01:37:00
 *   lane/sync        rook        8       1     0 ok         lock held        2026-10-28T23:00:06+01:00 .. 05:00:04
 *   notes/backup     lane-07     1       0     1 fail       quota exceeded   04:00:01 .. 04:00:01
 *   rig/rotate-logs  lane-07     1       0     0 ok         null             2026-10-28T23:00:02+01:00 (both)
 */
export type ReadNight = (runsDir: string, night: string) => NightDigest | null;
