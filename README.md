# jcode-recall

[![ci](https://github.com/Akramx15/jcode-recall/actions/workflows/ci.yml/badge.svg)](https://github.com/Akramx15/jcode-recall/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node: 20+](https://img.shields.io/badge/node-20%2B-brightgreen.svg)](package.json)

طبقة ذاكرة دائمة وبقاء للسياق (context survival) لوكلاء البرمجة: Jcode Desktop وClaude Code وCodex وopencode.
بدون أي اعتماديات وقت التشغيل، بدون شبكة، وبدون استدعاءات LLM. ملفات JSONL محلية فقط.

> الفكرة باختصار: عندما يُضغط سياق الوكيل (compaction) أو تبدأ جلسة جديدة، يستدعي الوكيل `recall_resume`
> فيستعيد الحقائق المثبتة، وآخر checkpoint، والقرارات، والخطوات التالية، بدل أن يبدأ من الصفر.

## لماذا؟

الوكلاء ينسون. نافذة السياق تُملأ، ثم تُضغط، فتضيع قرارات مهمة مثل «استخدمنا argon2 وليس bcrypt»
أو «قاعدة البيانات للإنتاج للقراءة فقط». `jcode-recall` يحفظ هذه الحقائق في ملف محلي صغير،
ويسترجعها بترتيب حتمي وسريع (BM25 مع تعزيز الحداثة والأهمية والتثبيت)، ويعيدها للوكيل في كتلة
منسقة ضمن ميزانية توكنات محددة.

## التثبيت

لا يوجد `npm install` ولا أي حزمة خارجية. Node.js 20 أو أحدث (تم التطوير والاختبار على Node 24).

```sh
git clone https://github.com/Akramx15/jcode-recall.git
cd jcode-recall
npm link          # يضيف الأمر recall إلى PATH، بدون تنزيل اعتماديات
# أو شغّله مباشرة:
node bin/recall.js --help
```

يعمل على Windows وmacOS وLinux. لا يحتاج صلاحيات خاصة.

### Windows (بدون npm link)

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
```

يضيف `recall` إلى PATH للمستخدم الحالي ويطبع كتلة MCP الجاهزة. البديل المباشر:

```bat
bin\recall.cmd --help
```

## البدء السريع

```sh
# احفظ قرارا مع السبب
recall remember "استخدم SQLite WAL لأن الكتابة المتزامنة تحتاج أمان الانهيار" \
  --kind decision --tag db --importance 4

# ابحث
recall search "أمان الكتابة في قاعدة البيانات" --budget 400

# ثبّت حقيقة مهمة لتظهر دائما في الملخص
recall pin <id>

# قبل أن يمتلئ السياق، احفظ checkpoint من المحادثة
recall checkpoint --goal "إتمام تسجيل الدخول" \
  --decision "استخدام argon2" \
  --next "كتابة اختبارات التكامل" \
  --blocker "مفتاح Stripe غير متوفر محليا"

# بعد الضغط أو في جلسة جديدة
recall resume --budget 900

# سياق جاهز للصق من أجل مهمة محددة
recall brief "أضف إعادة المحاولة إلى عامل المهام"
```

قراءة النص من stdin:

```sh
echo "المشروع يستخدم pnpm وليس npm" | recall remember --stdin --kind preference
```

## ربط MCP

الخادم يتحدث JSON-RPC 2.0 بإصدار MCP `2024-11-05` عبر stdio، رسالة JSON واحدة في كل سطر.

### Jcode

أضف إلى `~/.jcode/mcp.json` أو إلى `.mcp.json` داخل المشروع:

```json
{
  "mcpServers": {
    "recall": {
      "command": "node",
      "args": ["C:/Users/You/jcode-recall/bin/recall.js", "mcp"],
      "env": {
        "RECALL_HOME": "C:/Users/You/.jcode/recall"
      }
    }
  }
}
```

إذا كان `recall` على PATH يمكنك استخدام:

```json
{
  "mcpServers": {
    "recall": {
      "command": "recall",
      "args": ["mcp"]
    }
  }
}
```

ثم تحقق عبر `jcode mcp test recall`.

### Claude Code

```sh
claude mcp add recall -- node /absolute/path/to/jcode-recall/bin/recall.js mcp
```

أو أضف نفس كتلة `mcpServers` أعلاه إلى `.mcp.json` في جذر المشروع. للتحقق:

```sh
claude mcp list
```

### الأدوات المتاحة

| الأداة | الوظيفة |
|---|---|
| `recall_remember` | حفظ حقيقة أو قرار أو تفضيل أو مهمة أو ملف أو مقتطف |
| `recall_search` | بحث BM25 مع فلاتر وميزانية توكنات |
| `recall_brief` | كتلة `<recall-context>` جاهزة لمهمة معينة |
| `recall_checkpoint` | حفظ handoff منظم قبل الضغط |
| `recall_resume` | موجز واحد: مثبتات + آخر checkpoint + قرارات + مهام |
| `recall_pin` | تثبيت أو إلغاء تثبيت سجل |
| `recall_forget` | حذف سجل (tombstone في ملف append-only) |
| `recall_stats` | إحصاءات وتشخيص الملفات |

كل أداة تعيد `content: [{type: "text", text: ...}]`. لا يكتب الخادم أي شيء إلى stdout غير JSON-RPC.

## سير العمل عندما يمتلئ السياق

1. **عند بداية الجلسة**: يستدعي الوكيل `recall_resume` أو يشغّل hook `session-start`.
2. **قبل الضغط**: يستدعي `recall_checkpoint` بالهدف والقيود والقرارات والملفات والأوامر
   والخطوات التالية. يمكن للـ hook `pre-compact` أن يفعل ذلك تلقائيا من الـ transcript.
3. **بعد الضغط**: يستدعي `recall_resume` مرة أخرى لاستعادة الملخص. المحتوى يأتي موسوما
   بـ `unverified`، ومع `stale` إذا كان أقدم من 7 أيام.
4. **عند الغموض**: يستدعي `recall_search` بدل التخمين.
5. **لمهمة جديدة**: يستدعي `recall_brief` ليبني سياقا مرتبطا بالمهمة ضمن ميزانية محددة.

مثال إعداد hooks في Claude Code (انظر `hooks.example.json`):

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "recall hook session-start" }] }
    ],
    "PreCompact": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "recall hook pre-compact" }] }
    ],
    "Stop": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "recall hook stop" }] }
    ]
  }
}
```

`pre-compact` يقبل JSON أو JSONL على stdin، ويتسامح مع الأشكال غير المعروفة، ويقرأ
`transcript_path` إذا أرسله العميل. يطبع سطرا قصيرا يحتوي معرف الـ checkpoint.

## الأوامر

```text
recall remember <text> [--kind K] [--tag T] [--file F] [--importance 1-5]
                       [--supersedes <id>] [--stdin] [--global] [--force]
recall search "<query>" [--project X] [--kind K] [--tag T] [--file F]
                        [--limit N] [--budget TOKENS] [--literal] [--all] [--json]
recall brief "<task>" [--budget TOKENS] [--project X] [--all]
recall checkpoint [--goal] [--constraint] [--decision] [--file] [--command|--test]
                  [--open-question] [--next] [--blocker] [--summary|--summary-file]
                  [--messages PATH] [--data JSON] [--json]
recall resume [--project X] [--budget N] [--all] [--json]
recall pin <id> | recall unpin <id>
recall forget <id>
recall list [--project X] [--all] [--kind K] [--tag T] [--file F] [--pinned]
recall stats [--project X] [--json]
recall export --format md|json [--out FILE] [--project X]
recall doctor [--json]
recall mcp
recall hook session-start | pre-compact | stop
```

`--json` متاح لأوامر القراءة الأساسية للإخراج الآلي.

## هوية المشروع والعزل

- هوية المشروع هي المسار الأساسي (canonical) لجذر مستودع git عبر
  `git rev-parse --show-toplevel`، أو المسار المطلق الحالي إذا لم يوجد git.
- اسم المشروع المعروض هو اسم المجلد فقط (label). ملف البيانات يُشتق من بصمة المسار،
  لذلك مستودعان مختلفان اسمهما `app` لا يتشاركان ملفا أبدا.
- `--project <name>` يطابق الأسماء عبر المشاريع، ويعرض `@path` لكل سجل حتى ترى المصدر.
- `--global` يكتب في `global.jsonl` المشترك عمدا (قواعد المؤسسة مثلا). يظهر في الموجز
  موسوما بـ `global`.

## التخزين

المسار الافتراضي `~/.jcode/recall/` ويمكن تغييره عبر `RECALL_HOME`.

```text
~/.jcode/recall/
  global.jsonl
  proj-<slug>-<hash>.jsonl
```

كل سطر سجل JSON واحد:

```json
{"id":"r...","ts":"2026-10-26T12:00:00.000Z","project":"app",
 "projectPath":"C:/work/app","projectKey":"c:/work/app","kind":"decision",
 "text":"Use argon2 for password hashing","tags":["auth"],"files":["src/auth.js"],
 "importance":4,"session":"default","source":"cli","pinned":false}
```

التعديلات والحذف والتثبيت تُلحق كأسطر `_op` (update/delete) ولا يعاد كتابة الملف.
لهذا فإن `forget` قابل للاسترجاع من تاريخ JSONL، لكنه مخفي عن كل الأوامر.
الكتابة محمية بقفل ملف بين العمليات، والقراءة تتجاهل الأسطر التالفة بصمت.

## الخصوصية

- لا اتصال بالشبكة ولا استدعاء لنموذج لغوي. كل شيء محلي وحتمي.
- `remember` يرفض النصوص التي تشبه الأسرار (مفاتيح، كلمات مرور، رموز) إلا مع `--force`.
- الـ checkpoint ينقّي الأسرار تلقائيا ويستبدلها بـ `[redacted:...]` قبل الكتابة.
- لا يجمع المشروع أي telemetry.
- البيانات غير مشفرة على القرص. اعتمد على تشفير القرص وصلاحيات المستخدم.
- استخدم `recall export` للنسخ الاحتياطي، و`recall forget` للحذف المنطقي.

## البنية

```text
bin/recall.js        نقطة الدخول CLI
src/cli.js           تحليل الأوامر والإخراج
src/service.js       العمليات الأساسية المشتركة بين CLI وMCP
src/store.js         JSONL، قفل الملفات، قراءة آمنة، هوية المشروع
src/text.js          تطبيع عربي/Unicode وتقطيع
src/rank.js          BM25 + تعزيزات
src/render.js        كتل Markdown ضمن ميزانية توكنات
src/checkpoint.js    استخراج حتمي من الـ transcript
src/mcp.js           خادم MCP عبر stdio
test/                اختبارات node:test
scripts/mcp-smoke.js اختبار دخان كامل عبر pipe
```

## الاختبارات

```sh
node --test
node scripts/mcp-smoke.js
```

الاختبارات تستخدم `RECALL_HOME` مؤقتا ولا تلمس بياناتك. تغطي: التطبيع العربي، الترتيب،
ميزانية التوكنات، الجولة الكاملة للـ checkpoint، الموجز، MCP عبر pipe، الأسطر التالفة،
عزل المشاريع (مجلدان بنفس الاسم)، والكتابة المتزامنة من عدة عمليات.

## القيود

- الاسترجاع معجمي (lexical) وليس دلاليا. لا embeddings ولا فهم للمعنى. الصياغة المختلفة
  جدا قد لا تتطابق، وهنا يفيد `--literal` أو كلمات مفتاحية أفضل.
- تقدير التوكنات تقريبي (4 أحرف لكل توكن). النص العربي قد يكون أكثر كثافة، لذا اعتبر
  الميزانية حدا أعلى تقريبيا لا دقيقا.
- القفل يعمل على نظام ملفات محلي. لا تستخدم `RECALL_HOME` على مشاركة شبكة غير موثوقة.
- الملفات تنمو ولا تُضغط تلقائيا. `forget` tombstone وليس حذفا فيزيائيا.
- استخراج الـ checkpoint قواعدي (heuristic) ومتحفظ. لا يخترع حقائق، لكنه قد يفوت بعضها،
  لذا مرر الحقول المهمة صراحة عبر الأعلام.
- لا يوجد تكامل خاص بمحرر أو IDE غير CLI وMCP والـ hooks.

## الترخيص

MIT. انظر `LICENSE`.

---

# jcode-recall (English)

A durable memory and context-survival layer for coding agents: Jcode Desktop, Claude Code, Codex and opencode.
Zero runtime dependencies, no network, no LLM calls. Local JSONL files only.

> The idea: when an agent's context is compacted or a new session starts, it calls `recall_resume` and gets
> back pinned facts, the latest checkpoint, decisions and next steps instead of starting from zero.

## Why

Agents forget. The context window fills, compaction drops details, and decisions such as
"we used argon2, not bcrypt" or "production is read-only for agents" disappear. `jcode-recall`
stores those facts in a small local file and retrieves them deterministically and quickly
(BM25 plus recency, importance and pin boosts), then hands them back inside a token budget.

## Install

No `npm install`, no external packages. Node.js 20 or newer (developed and tested on Node 24).

```sh
git clone https://github.com/<you>/jcode-recall.git
cd jcode-recall
npm link          # puts `recall` on PATH, no dependencies installed
# or run it directly:
node bin/recall.js --help
```

Works on Windows, macOS and Linux. No special permissions required.

## Quick start

```sh
recall remember "Use SQLite WAL because concurrent writes need crash safety" \
  --kind decision --tag db --importance 4

recall search "database write safety" --budget 400

recall pin <id>

recall checkpoint --goal "finish login" \
  --decision "use argon2" \
  --next "write integration tests" \
  --blocker "Stripe key is not available locally"

recall resume --budget 900

recall brief "add retry logic to the worker"
```

Reading from stdin:

```sh
echo "This repo uses pnpm, not npm" | recall remember --stdin --kind preference
```

## MCP wiring

The server speaks JSON-RPC 2.0 with MCP `2024-11-05` over stdio, one JSON message per line.

### Jcode

Add to `~/.jcode/mcp.json` or a project `.mcp.json`:

```json
{
  "mcpServers": {
    "recall": {
      "command": "node",
      "args": ["C:/Users/You/jcode-recall/bin/recall.js", "mcp"],
      "env": {
        "RECALL_HOME": "C:/Users/You/.jcode/recall"
      }
    }
  }
}
```

If `recall` is on PATH:

```json
{
  "mcpServers": {
    "recall": {
      "command": "recall",
      "args": ["mcp"]
    }
  }
}
```

Verify with `jcode mcp test recall`.

### Claude Code

```sh
claude mcp add recall -- node /absolute/path/to/jcode-recall/bin/recall.js mcp
```

Or add the same `mcpServers` block to `.mcp.json` at the project root. Verify with `claude mcp list`.

### Tools

| Tool | Purpose |
|---|---|
| `recall_remember` | store a fact, decision, preference, task, artifact or snippet |
| `recall_search` | BM25 search with filters and a token budget |
| `recall_brief` | a ready-to-paste `<recall-context>` block for one task |
| `recall_checkpoint` | save a structured handoff before compaction |
| `recall_resume` | one briefing: pinned + latest checkpoint + decisions + tasks |
| `recall_pin` | pin or unpin a record |
| `recall_forget` | delete a record (append-only tombstone) |
| `recall_stats` | store statistics and file diagnostics |

Every tool returns `content: [{type: "text", text: ...}]`. Nothing except JSON-RPC is
written to stdout.

## When your context fills

1. **Session start**: the agent calls `recall_resume` or runs the `session-start` hook.
2. **Before compaction**: the agent calls `recall_checkpoint` with the goal, constraints,
   decisions, files, commands and next steps. The `pre-compact` hook can do this from the
   transcript automatically.
3. **After compaction**: call `recall_resume` again. Checkpoint content is marked
   `unverified`, and `stale` when older than 7 days.
4. **When unsure**: call `recall_search` instead of guessing.
5. **New task**: call `recall_brief` for task-specific context within a budget.

Claude Code hook configuration (see `hooks.example.json`):

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "recall hook session-start" }] }
    ],
    "PreCompact": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "recall hook pre-compact" }] }
    ],
    "Stop": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "recall hook stop" }] }
    ]
  }
}
```

`pre-compact` accepts JSON or JSONL on stdin, tolerates unknown shapes, and reads
`transcript_path` when a client sends it. It prints one short line with the checkpoint id.

## Commands

```text
recall remember <text> [--kind K] [--tag T] [--file F] [--importance 1-5]
                       [--supersedes <id>] [--stdin] [--global] [--force]
recall search "<query>" [--project X] [--kind K] [--tag T] [--file F]
                        [--limit N] [--budget TOKENS] [--literal] [--all] [--json]
recall brief "<task>" [--budget TOKENS] [--project X] [--all]
recall checkpoint [--goal] [--constraint] [--decision] [--file] [--command|--test]
                  [--open-question] [--next] [--blocker] [--summary|--summary-file]
                  [--messages PATH] [--data JSON] [--json]
recall resume [--project X] [--budget N] [--all] [--json]
recall pin <id> | recall unpin <id>
recall forget <id>
recall list [--project X] [--all] [--kind K] [--tag T] [--file F] [--pinned]
recall stats [--project X] [--json]
recall export --format md|json [--out FILE] [--project X]
recall doctor [--json]
recall mcp
recall hook session-start | pre-compact | stop
```

`--json` is available on the main read commands for machine output.

## Project identity and isolation

- A project's identity is the canonical root of its git repository
  (`git rev-parse --show-toplevel`), or the absolute current directory when there is no git repo.
- The display name is only a label. The data file is derived from a hash of the canonical path,
  so two unrelated repos both named `app` never share a file.
- `--project <name>` matches labels across projects and prints `@path` for each record, so mixed
  provenance stays visible.
- `--global` writes to the shared `global.jsonl` on purpose (for organisation-wide rules). Global
  records are marked `global` in briefings.

## Storage

Default location `~/.jcode/recall/`, overridable with `RECALL_HOME`.

```text
~/.jcode/recall/
  global.jsonl
  proj-<slug>-<hash>.jsonl
```

One JSON record per line:

```json
{"id":"r...","ts":"2026-10-26T12:00:00.000Z","project":"app",
 "projectPath":"C:/work/app","projectKey":"c:/work/app","kind":"decision",
 "text":"Use argon2 for password hashing","tags":["auth"],"files":["src/auth.js"],
 "importance":4,"session":"default","source":"cli","pinned":false}
```

Updates, deletes and pins are appended as `_op` lines (`update` / `delete`); the file is never
rewritten in place. That makes `forget` logically reversible from the JSONL history while every
command hides it. Writes are serialized with a cross-process file lock, and reads skip malformed
lines without throwing.

## Privacy

- No network access and no LLM calls. Everything is local and deterministic.
- `remember` refuses secret-looking text (keys, passwords, tokens) unless `--force` is given.
- Checkpoints redact secrets automatically to `[redacted:...]` before writing.
- No telemetry is collected.
- Data is not encrypted at rest. Rely on full-disk encryption and OS user permissions.
- Use `recall export` for backups and `recall forget` for logical deletion.

## Architecture

```text
bin/recall.js        CLI entry point
src/cli.js           argument parsing and command output
src/service.js       core operations shared by CLI and MCP
src/store.js         JSONL, file locks, crash-safe reads, project identity
src/text.js          Arabic/Unicode normalization and tokenization
src/rank.js          BM25 plus boosts
src/render.js        budgeted Markdown blocks
src/checkpoint.js    deterministic transcript extraction
src/mcp.js           stdio MCP server
test/                node:test suites
scripts/mcp-smoke.js end-to-end pipe smoke test
```

Design rationale and the sources behind it: [`docs/DESIGN.md`](docs/DESIGN.md),
[`docs/RESEARCH.md`](docs/RESEARCH.md). The protocol agents should follow:
[`docs/AGENT-PROTOCOL.md`](docs/AGENT-PROTOCOL.md).

## Tests

```sh
node --test
node scripts/mcp-smoke.js
```

Tests use a temporary `RECALL_HOME` and never touch your data. They cover Arabic normalization,
ranking, token budgets, the full checkpoint round trip, resume, MCP over a pipe, malformed JSONL,
project isolation (two directories with the same basename), and concurrent appends from multiple
processes.

## Limitations

- Retrieval is lexical, not semantic. There are no embeddings, so a very different wording may not
  match. Use `--literal` or better keywords when needed.
- Token estimates are approximate (4 characters per token). Arabic text can be denser, so treat the
  budget as a soft upper bound.
- Locking assumes a local filesystem. Do not point `RECALL_HOME` at an unreliable network share.
- Files grow and are never compacted automatically. `forget` is a tombstone, not physical erasure.
- Checkpoint extraction is heuristic and conservative. It never invents facts, but it can miss some,
  so pass important fields explicitly with flags.
- There is no editor/IDE integration beyond the CLI, MCP and hooks.

## License

MIT. See `LICENSE`.
