#!/usr/bin/env node
// automerge-label-fallback.test.mjs — AUTOMERGE-NO-QUEUE-FALLBACK-1 controls.
//
// automerge-label.yml enables native auto-merge, and when that leaves an
// already-green PR untouched it falls back. The fallback used to be
// enqueuePullRequest alone, but this repo's master has no merge queue, so a
// labelled green PR failed with "No merge queue found for branch 'master'"
// and sat unmerged (2026-11-25, #646). The step's own shell is extracted from
// the workflow and run with a stub `gh` on PATH:
//   QUEUE      base has a merge queue        -> enqueuePullRequest, no direct merge
//   GREEN      no queue, CI green            -> one direct squash merge pinned to the head SHA
//   PENDING    no queue, a check still runs  -> no merge, exit 1
//   RED        no queue, a check failed      -> no merge, exit 1
//   SELF       this job's own earlier failed run doesn't count as red
// Zero-dep; temp dir only, writes nothing into the repo. Needs bash + jq.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WF = readFileSync(join(ROOT, '.github/workflows/automerge-label.yml'), 'utf8');
const SELF = 'Enable auto-merge on labeled PR';
const HEAD = 'f00dfeed';

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.error('  ✗ ' + m); } else console.log('  ✓ ' + m); };

/** The `run: |` body of the enqueue step, dedented. */
function stepScript() {
  const start = WF.indexOf('- name: Enable auto-merge / enqueue');
  if (start === -1) throw new Error('enqueue step missing from automerge-label.yml');
  const lines = WF.slice(start).split('\n');
  const runAt = lines.findIndex((l) => /^\s*run:\s*\|\s*$/.test(l));
  const body = [];
  let indent = null;
  for (const l of lines.slice(runAt + 1)) {
    if (l.trim() === '') { body.push(''); continue; }
    const n = l.match(/^\s*/)[0].length;
    if (indent === null) indent = n;
    if (n < indent) break;
    body.push(l.slice(indent));
  }
  return body.join('\n');
}

function run({ queue, checkRuns }) {
  const dir = mkdtempSync(join(tmpdir(), 'automerge-fallback-'));
  try {
    const log = join(dir, 'gh.log');
    const merged = join(dir, 'merged');
    writeFileSync(join(dir, 'checks.json'), JSON.stringify({ check_runs: checkRuns }));
    writeFileSync(join(dir, 'queue.json'), JSON.stringify({ data: { repository: { mergeQueue: queue ? { id: 'MQ_1' } : null } } }));
    const gh = join(dir, 'gh');
    // Native `--auto` is the no-op seen on #646. `gh api` honours --jq the
    // way gh does, by running jq over the canned response.
    writeFileSync(gh, `#!/usr/bin/env bash
echo "$*" >> "${log}"
JQ=""; args=("$@")
for ((i=0;i<\${#args[@]};i++)); do [ "\${args[$i]}" = "--jq" ] && JQ="\${args[$((i+1))]}"; done
emit() { if [ -n "$JQ" ]; then jq -r "$JQ"; else cat; fi; }
case "$1 $2" in
  "pr merge") case "$*" in *--auto*) exit 0 ;; *) touch "${merged}"; exit 0 ;; esac ;;
  "pr view") echo '{"id":"PR_1","headRefOid":"${HEAD}","baseRefName":"master"}'; exit 0 ;;
  "pr comment") exit 0 ;;
esac
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  case "$*" in
    *mergeQueue\\(branch*) emit < "${join(dir, 'queue.json')}" ;;
    *enqueuePullRequest*) touch "${join(dir, 'queued')}"; echo '{"data":{"enqueuePullRequest":{"mergeQueueEntry":{"id":"E1"}}}}' ;;
    *)
      M=false; [ -f "${merged}" ] && M=true
      Q=null; [ -f "${join(dir, 'queued')}" ] && Q='{"id":"E1"}'
      echo "{\\"data\\":{\\"node\\":{\\"merged\\":$M,\\"autoMergeRequest\\":null,\\"mergeQueueEntry\\":$Q}}}" ;;
  esac
  exit 0
fi
if [ "$1" = "api" ]; then case "$2" in *"/check-runs"*) emit < "${join(dir, 'checks.json')}" ;; esac; exit 0; fi
exit 0
`);
    chmodSync(gh, 0o755);
    const script = join(dir, 'step.sh');
    writeFileSync(script, stepScript());
    const r = spawnSync('bash', [script], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_TOKEN: 'stub', PR: '646', REPO: 'owner/repo', SELF_CHECK: SELF },
    });
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
    return { status: r.status, out: r.stdout + r.stderr, calls };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const direct = (calls) => calls.filter((c) => c.startsWith('pr merge') && !c.includes('--auto'));
const enqueued = (calls) => calls.filter((c) => c.includes('enqueuePullRequest'));
const green = [{ name: 'Validate MCP server', status: 'completed', conclusion: 'success' }, { name: 'Deploy', status: 'completed', conclusion: 'skipped' }];

console.log('AUTOMERGE-NO-QUEUE-FALLBACK-1 — automerge-label.yml fallback\n');

{
  const r = run({ queue: true, checkRuns: green });
  ok(r.status === 0, `QUEUE: exits 0 (${r.status})`);
  ok(enqueued(r.calls).length === 1 && direct(r.calls).length === 0, 'QUEUE: enqueues, never merges directly');
}
{
  const r = run({ queue: false, checkRuns: green });
  ok(r.status === 0, `GREEN: exits 0 (${r.status}) ${r.status ? r.out : ''}`);
  ok(enqueued(r.calls).length === 0, 'GREEN: never calls enqueuePullRequest on a queue-less base');
  ok(JSON.stringify(direct(r.calls)) === JSON.stringify([`pr merge 646 -R owner/repo --squash --match-head-commit ${HEAD}`]),
    `GREEN: exactly one squash merge pinned to the head SHA (${direct(r.calls).join(' | ')})`);
}
{
  const r = run({ queue: false, checkRuns: [...green, { name: 'Late check', status: 'in_progress', conclusion: null }] });
  ok(r.status === 1 && direct(r.calls).length === 0, 'PENDING: a running check holds the merge (exit 1, no merge)');
}
{
  const r = run({ queue: false, checkRuns: [...green, { name: 'Lint', status: 'completed', conclusion: 'failure' }] });
  ok(r.status === 1 && direct(r.calls).length === 0, 'RED: a failed check holds the merge (exit 1, no merge)');
}
{
  const r = run({ queue: false, checkRuns: [...green, { name: SELF, status: 'completed', conclusion: 'failure' }, { name: SELF, status: 'in_progress', conclusion: null }] });
  ok(r.status === 0 && direct(r.calls).length === 1, "SELF: this job's own runs, failed or running, don't hold the merge");
}
{
  const r = run({ queue: false, checkRuns: [{ name: 'Deploy', status: 'completed', conclusion: 'skipped' }] });
  ok(r.status === 1 && direct(r.calls).length === 0, 'NONE: no passing check at all holds the merge');
}

if (fail) { console.error(`\n✗ ${fail} assertion(s) failed`); process.exit(1); }
console.log('\n✅ automerge-label fallback: queue path kept, queue-less base merges only when CI is green');
