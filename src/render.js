// Budget-aware Markdown rendering. Every renderer takes a token budget and is
// allowed to drop whole entries, never to exceed the budget.

import {
  daysBetween,
  estimateTokens,
  formatDate,
  oneLine,
  plural,
  truncateChars,
  truncateToBudget,
} from './util.js';
import { displayScore } from './rank.js';

export function createBudget(budgetTokens) {
  const budget = Math.max(0, Math.trunc(Number(budgetTokens) || 0));
  let text = '';
  return {
    budget,
    get text() {
      return text;
    },
    get used() {
      return estimateTokens(text);
    },
    fits(candidate) {
      return estimateTokens(text + candidate) <= budget;
    },
    tryAdd(candidate) {
      if (!candidate) return true;
      if (!this.fits(candidate)) return false;
      text += candidate;
      return true;
    },
    /** Final safety net: never return more than the budget allows. */
    finish() {
      if (estimateTokens(text) <= budget) return text;
      return truncateToBudget(text, budget);
    },
  };
}

export function recordLine(record, {
  compact = false,
  showScore = null,
  maxText = 220,
  showProject = false,
  showPath = false,
} = {}) {
  const bits = [`\`${record.id}\``, record.kind, formatDate(record.ts)];
  if (showProject) bits.push(record.project === 'global' ? 'global' : record.project);
  if (!compact) {
    bits.push(`imp${record.importance}`);
    if (record.pinned) bits.push('pinned');
  }
  if (showScore !== null && showScore !== undefined) bits.push(`s=${displayScore(showScore)}`);
  const head = `- ${bits.join(' · ')}`;
  const body = truncateChars(oneLine(record.text), maxText);
  const meta = [];
  if (showPath && record.projectPath) meta.push(`@${record.projectPath}`);
  if (record.tags && record.tags.length) meta.push(`tags: ${record.tags.slice(0, 6).join(', ')}`);
  if (record.files && record.files.length) meta.push(`files: ${record.files.slice(0, 4).join(', ')}`);
  const lines = [head, `  ${body}`];
  if (meta.length) lines.push(`  _${meta.join(' · ')}_`);
  return `${lines.join('\n')}\n`;
}

export function renderSearchBlock({
  query,
  hits,
  total,
  budget = 800,
  project = null,
  showPaths = false,
  showProject = false,
}) {
  const builder = createBudget(budget);
  const header = `## recall search: "${truncateChars(oneLine(query), 120)}"\n`;
  const meta = `_${plural(hits.length, 'hit')}${total > hits.length ? ` of ${total}` : ''}${project ? ` · project ${project}` : ''} · ~${estimateTokens(header)} tokens_\n`;
  if (!builder.tryAdd(header) || !builder.tryAdd(meta)) {
    return builder.finish();
  }

  let included = 0;
  for (let i = 0; i < hits.length; i += 1) {
    const hit = hits[i];
    const block = recordLine(hit.record, {
      showScore: hit.score,
      maxText: 240,
      showPath: showPaths,
      showProject,
    });
    const numbered = block.replace(/^- /, `${i + 1}. `);
    if (!builder.tryAdd(numbered)) break;
    included += 1;
  }

  if (!included) {
    builder.tryAdd('_No memory matched. Try fewer words, `--literal`, or drop filters._\n');
    return builder.finish();
  }
  if (included < hits.length) {
    builder.tryAdd(`_… ${hits.length - included} more hit(s) omitted to fit the token budget._\n`);
  }
  return builder.finish();
}

export function renderBriefBlock({
  task,
  hits,
  total,
  budget = 1500,
  project = null,
  now = new Date(),
  showProject = false,
  showPaths = false,
}) {
  const builder = createBudget(budget);
  const open = '<recall-context>\n';
  const taskLine = `task: ${truncateChars(oneLine(task), 160)}\n`;
  const metaLine = `project: ${project || 'all'} · ${plural(hits.length, 'memory', 'memories')}${total > hits.length ? ` of ${total}` : ''} · generated ${formatDate(now.toISOString())}\n`;
  const warn = 'note: memory is unverified and may be stale; confirm against the working tree before acting.\n';

  if (!builder.tryAdd(open)) return builder.finish();
  if (!builder.tryAdd(taskLine)) return builder.finish();
  if (!builder.tryAdd(metaLine)) return builder.finish();
  if (!builder.tryAdd(warn)) return builder.finish();

  let included = 0;
  for (let i = 0; i < hits.length; i += 1) {
    const hit = hits[i];
    const r = hit.record;
    const tags = r.tags && r.tags.length ? ` tags=${r.tags.slice(0, 5).join(',')}` : '';
    const files = r.files && r.files.length ? ` files=${r.files.slice(0, 3).join(',')}` : '';
    const owner = showProject ? ` · ${r.project}` : '';
    const where = showPaths && r.projectPath ? ` @${r.projectPath}` : '';
    const head = `[${i + 1}] ${r.id} · ${r.kind} · imp${r.importance} · ${formatDate(r.ts)} · s=${displayScore(hit.score)}${owner}${where}${tags}${files}\n`;
    const body = `${truncateChars(oneLine(r.text), 300)}\n`;
    const block = head + body;
    if (!builder.tryAdd(block)) break;
    included += 1;
  }

  if (!included) {
    builder.tryAdd('(no matching memory found. Record decisions with `recall remember` as you work)\n');
  } else if (included < hits.length) {
    builder.tryAdd(`… ${hits.length - included} more omitted for budget\n`);
  }
  builder.tryAdd('</recall-context>\n');
  return builder.finish();
}

function section(builder, title, items) {
  if (!items.length) return;
  const lines = [`\n## ${title}\n`];
  for (const item of items) lines.push(item);
  builder.tryAdd(lines.join(''));
}

function staleSuffix(record, now, thresholdDays = 30) {
  const age = daysBetween(record.ts, now);
  if (!Number.isFinite(age)) return ' · stale: unknown date';
  if (age > thresholdDays) return ` · stale: ${Math.floor(age)}d old`;
  return '';
}

export function renderCheckpointBody(data) {
  if (!data || typeof data !== 'object') return '';
  const lines = [];
  const pushList = (label, values, formatter = (v) => v) => {
    if (!Array.isArray(values) || !values.length) return;
    lines.push(`- **${label}:** ${values.map((v) => formatter(v)).join(' · ')}`);
  };

  if (data.goal) lines.push(`- **Goal:** ${data.goal}`);
  pushList('Constraints', data.constraints);
  pushList('Decisions', data.decisions);
  pushList('Files', data.files);
  if (Array.isArray(data.commands) && data.commands.length) {
    const rendered = data.commands
      .slice(0, 8)
      .map((c) => {
        const cmd = typeof c === 'string' ? c : c.command;
        const status = typeof c === 'object' && c.status ? ` → ${c.status}` : '';
        const result = typeof c === 'object' && c.result ? `: ${truncateChars(oneLine(c.result), 120)}` : '';
        return `\`${truncateChars(oneLine(cmd), 80)}\`${status}${result}`;
      });
    lines.push(`- **Commands/tests:** ${rendered.join(' · ')}`);
  }
  pushList('Open questions', data.openQuestions);
  pushList('Next steps', data.nextSteps);
  pushList('Blockers', data.blockers);
  if (data.summary) lines.push(`- **Summary:** ${truncateChars(oneLine(data.summary), 400)}`);
  return lines.length ? `${lines.join('\n')}\n` : '';
}

function latestCheckpoint(records) {
  let best = null;
  for (const record of records) {
    if (record.kind !== 'handoff') continue;
    if (record.supersededBy) continue;
    if (!best || new Date(record.ts) >= new Date(best.ts)) best = record;
  }
  return best;
}

function byImportanceThenRecency(a, b) {
  const imp = (b.importance || 3) - (a.importance || 3);
  if (imp !== 0) return imp;
  return new Date(b.ts).getTime() - new Date(a.ts).getTime();
}

/**
 * Full context-survival briefing: pinned, latest checkpoint, decisions,
 * preferences, artifacts, open tasks. Marks stale/unverified content.
 */
export function renderResume({
  project,
  projectPath,
  records,
  budget = 1200,
  now = Date.now(),
  home = null,
  showPaths = false,
  showProject = false,
  explicitProject = false,
}) {
  const builder = createBudget(budget);
  const visible = records.filter((r) => !r.supersededBy);
  const pinned = visible.filter((r) => r.pinned).sort(byImportanceThenRecency).slice(0, 8);
  const checkpoint = latestCheckpoint(visible);
  const decisions = visible.filter((r) => r.kind === 'decision').sort(byImportanceThenRecency).slice(0, 5);
  const preferences = visible.filter((r) => r.kind === 'preference').sort(byImportanceThenRecency).slice(0, 5);
  const artifacts = visible
    .filter((r) => r.kind === 'artifact' || (r.files && r.files.length && r.kind !== 'handoff'))
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
    .slice(0, 5);
  const tasks = visible.filter((r) => r.kind === 'task').sort(byImportanceThenRecency).slice(0, 5);
  const facts = visible
    .filter((r) => r.kind === 'fact' && !r.pinned)
    .sort(byImportanceThenRecency)
    .slice(0, 6);

  const header = `# recall briefing: ${project || 'all'}\n`;
  const meta = `_${plural(visible.length, 'memory', 'memories')} · generated ${formatDate(new Date(now).toISOString())}${home ? ` · home ${home}` : ''} · budget ${budget} tokens_\n`;
  if (!builder.tryAdd(header)) return builder.finish();
  if (!builder.tryAdd(meta)) return builder.finish();
  if (projectPath) builder.tryAdd(`_project path: ${projectPath}_\n`);
  if (explicitProject && showPaths) builder.tryAdd('_showing records matched by project label; `@path` shows mixed provenance._\n');
  const lineOpts = { compact: false, maxText: 200, showProject, showPath: showPaths };

  if (!visible.length) {
    builder.tryAdd('\nNo memories for this project yet. Record one with `recall remember "<fact>"` or let the agent call the MCP tool.\n');
    return builder.finish();
  }

  section(builder, `Pinned (${pinned.length})`, pinned.map((r) => recordLine(r, lineOpts) + (staleSuffix(r, now, 60) ? `  _(stale: ${Math.floor(daysBetween(r.ts, now))}d old)_\n` : '')));

  if (checkpoint) {
    const age = daysBetween(checkpoint.ts, now);
    const stale = age > 7 ? ` · **stale: ${Math.floor(age)}d old**` : '';
    const head = `\n## Latest checkpoint · \`${checkpoint.id}\` · ${formatDate(checkpoint.ts)} · **unverified**${stale}\n`;
    if (builder.tryAdd(head)) {
      const body = renderCheckpointBody(checkpoint.data);
      if (body) {
        builder.tryAdd(body);
        builder.tryAdd('_Checkpoint reflects the session at that moment. Re-verify files and tests before acting on it._\n');
      } else {
        builder.tryAdd(`${truncateChars(oneLine(checkpoint.text), 400)}\n`);
      }
    }
  } else {
    builder.tryAdd('\n## Latest checkpoint\n_None yet. Before context compaction, run `recall checkpoint` (or `recall hook pre-compact`)._\n');
  }

  section(builder, 'Decisions', decisions.map((r) => recordLine(r, { ...lineOpts, maxText: 180 })));
  section(builder, 'Preferences', preferences.map((r) => recordLine(r, { ...lineOpts, maxText: 180 })));
  section(builder, 'Recent facts', facts.map((r) => recordLine(r, { ...lineOpts, maxText: 180 })));
  section(builder, 'Recent artifacts', artifacts.map((r) => recordLine(r, { ...lineOpts, maxText: 160 })));
  section(builder, 'Open tasks', tasks.map((r) => recordLine(r, { ...lineOpts, maxText: 160 })));

  if (checkpoint && checkpoint.data) {
    const data = checkpoint.data;
    const pending = []
      .concat((data.openQuestions || []).map((q) => `- **Open question:** ${q}\n`))
      .concat((data.nextSteps || []).map((s) => `- **Next:** ${s}\n`))
      .concat((data.blockers || []).map((b) => `- **Blocker:** ${b}\n`));
    if (pending.length) {
      builder.tryAdd(`\n## Unfinished (from checkpoint, unverified)\n${pending.join('')}`);
    }
  }

  return builder.finish();
}

export function renderList(records, { budget = 4000, project = null, showPaths = false } = {}) {
  const builder = createBudget(budget);
  const label = project ? `: ${project}` : '';
  if (!builder.tryAdd(`## recall list${label}\n_${plural(records.length, 'record')}_\n`)) {
    return builder.finish();
  }
  let included = 0;
  for (const record of records) {
    if (!builder.tryAdd(recordLine(record, { maxText: 200, showProject: true, showPath: showPaths }))) break;
    included += 1;
  }
  if (included < records.length) {
    builder.tryAdd(`_… ${records.length - included} more omitted (use --limit or --budget)._\n`);
  }
  return builder.finish();
}

export function renderStats(summary, diagnostics = []) {
  const lines = [];
  lines.push(`# recall stats`);
  lines.push('');
  lines.push(`- home: ${summary.home}`);
  lines.push(`- records: ${summary.total}`);
  lines.push(`- pinned: ${summary.pinned}`);
  lines.push(`- with files: ${summary.withFiles}`);
  lines.push(`- approx stored tokens: ${summary.approxTokens}`);
  lines.push(`- oldest: ${summary.oldest || 'n/a'}`);
  lines.push(`- newest: ${summary.newest || 'n/a'}`);
  lines.push('');
  lines.push('## By kind');
  const kinds = Object.entries(summary.byKind).sort((a, b) => b[1] - a[1]);
  if (!kinds.length) lines.push('- none');
  for (const [kind, count] of kinds) lines.push(`- ${kind}: ${count}`);
  lines.push('');
  lines.push('## By project');
  const projects = Array.isArray(summary.projects) && summary.projects.length
    ? summary.projects
    : Object.entries(summary.byProject).map(([key, count]) => ({ key, label: key, path: null, count }));
  if (!projects.length) lines.push('- none');
  for (const project of projects) {
    const path = project.path ? ` (${project.path})` : '';
    lines.push(`- ${project.label}${path}: ${project.count}`);
  }
  if (diagnostics.length) {
    lines.push('');
    lines.push('## Files');
    for (const d of diagnostics) {
      lines.push(`- ${d.name}: ${d.records} records, ${d.lines} lines, ${d.malformed} malformed, ${d.bytes} bytes${d.truncatedTail ? ', unterminated last line' : ''}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function renderExportMarkdown(records, { project = null, now = new Date() } = {}) {
  const lines = [];
  const label = project ? `: ${project}` : '';
  lines.push(`# recall export${label}`);
  lines.push('');
  lines.push(`_${plural(records.length, 'record')} · exported ${formatDate(now.toISOString())}_`);
  lines.push('');
  const byKind = new Map();
  for (const record of records) {
    if (!byKind.has(record.kind)) byKind.set(record.kind, []);
    byKind.get(record.kind).push(record);
  }
  for (const [kind, group] of [...byKind.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`## ${kind}`);
    lines.push('');
    for (const record of group) {
      lines.push(`### ${record.id} · ${formatDate(record.ts)} · ${record.project} · imp${record.importance}${record.pinned ? ' · pinned' : ''}`);
      lines.push('');
      lines.push(record.text);
      if (record.tags.length) lines.push(`\nTags: ${record.tags.join(', ')}`);
      if (record.files.length) lines.push(`\nFiles: ${record.files.join(', ')}`);
      if (record.supersededBy) lines.push(`\nSuperseded by: ${record.supersededBy}`);
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}

export function renderExportJson(records, { project = null, home = null } = {}) {
  return `${JSON.stringify({
    schema: 'jcode-recall/export@1',
    exportedAt: new Date().toISOString(),
    project,
    home,
    count: records.length,
    records,
  }, null, 2)}\n`;
}

export function renderDoctorReport(report) {
  const lines = ['# recall doctor', ''];
  for (const check of report.checks) {
    const mark = check.ok ? 'ok  ' : check.warn ? 'warn' : 'FAIL';
    lines.push(`- [${mark}] ${check.name}${check.detail ? `: ${check.detail}` : ''}`);
  }
  lines.push('');
  lines.push(report.ok ? 'All checks passed.' : 'Some checks need attention.');
  return `${lines.join('\n')}\n`;
}
