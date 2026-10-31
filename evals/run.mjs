#!/usr/bin/env node
// Rubric eval runner. Grades exported chat transcripts against evals/tasks.json using the
// Worker's /judge endpoint, and reports pass@3 plus per-task scores.
//
//   node evals/run.mjs --transcripts evals/transcripts --worker https://webagent.amos-donn.workers.dev
//   node evals/run.mjs --validate          # no network: check the suite itself
//
// Transcript naming: evals/transcripts/<taskId>-<attempt>.md, e.g. t04-1.md, t04-2.md, t04-3.md.
// Export a chat from the panel (☰ → Export .md) after each real run. A task passes if any attempt
// scores at least THRESHOLD, which is what pass@3 measures.
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const THRESHOLD = 0.8;
const args = process.argv.slice(2);
const flag = (name, fallback) => { const index = args.indexOf(name); return index === -1 ? fallback : args[index + 1]; };

const tasks = JSON.parse(await readFile(join(HERE, 'tasks.json'), 'utf8'));

if (args.includes('--validate')) {
  const problems = [];
  if (tasks.length !== 30) problems.push(`expected 30 tasks, found ${tasks.length}`);
  const ids = new Set();
  for (const task of tasks) {
    if (!/^t\d{2}$/.test(task.id || '')) problems.push(`bad id ${task.id}`);
    if (ids.has(task.id)) problems.push(`duplicate id ${task.id}`);
    ids.add(task.id);
    if (!task.goal || task.goal.length < 10) problems.push(`${task.id}: goal too short`);
    if (!/^https?:\/\//.test(task.url || '')) problems.push(`${task.id}: bad url`);
    if (!Array.isArray(task.rubric) || task.rubric.length < 3) problems.push(`${task.id}: needs at least 3 rubric points`);
  }
  if (problems.length) { console.error('Suite problems:\n- ' + problems.join('\n- ')); process.exit(1); }
  console.log(`Suite OK: ${tasks.length} tasks, ${tasks.reduce((sum, task) => sum + task.rubric.length, 0)} rubric points.`);
  process.exit(0);
}

const worker = (flag('--worker', process.env.WORKER_URL || 'https://webagent.amos-donn.workers.dev')).replace(/\/$/, '');
const dir = flag('--transcripts', join(HERE, 'transcripts'));
const only = flag('--task', '');

let files = [];
try { files = await readdir(dir); } catch { console.error(`No transcripts directory at ${dir}. Export chats from the panel first.`); process.exit(1); }

async function judge(task, transcript) {
  const response = await fetch(`${worker}/judge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal: task.goal, rubric: task.rubric, transcript }) });
  const out = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(out.error || `Judge failed (${response.status}).`);
  return out;
}

const rows = [];
for (const task of tasks) {
  if (only && task.id !== only) continue;
  const attempts = files.filter(file => file.startsWith(`${task.id}-`) && file.endsWith('.md')).sort();
  if (!attempts.length) { rows.push({ id: task.id, attempts: 0, best: null, passed: false }); continue; }
  let best = 0;
  for (const file of attempts.slice(0, 3)) {
    const transcript = await readFile(join(dir, file), 'utf8');
    const result = await judge(task, transcript);
    best = Math.max(best, result.score);
    console.log(`${task.id}/${file}: score ${result.score.toFixed(2)} · ${result.notes || ''}`);
  }
  rows.push({ id: task.id, attempts: Math.min(attempts.length, 3), best, passed: best >= THRESHOLD });
}

const scored = rows.filter(row => row.attempts > 0);
const passed = scored.filter(row => row.passed).length;
console.log('\nTask   attempts  best   pass');
for (const row of rows) console.log(`${row.id}   ${String(row.attempts).padEnd(8)}  ${row.best === null ? '  -  ' : row.best.toFixed(2)}   ${row.passed ? 'yes' : row.attempts ? 'no' : 'not run'}`);
console.log(`\npass@3: ${passed}/${scored.length || 0} scored tasks (${scored.length}/${tasks.length} tasks have transcripts). Threshold ${THRESHOLD}.`);
process.exit(0);
