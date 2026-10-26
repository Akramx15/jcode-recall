// Unicode-aware text normalization and tokenization.
//
// Design goals:
//  - Arabic-first: strip diacritics/tatweel, unify alef/ya/ta-marbuta forms,
//    convert Arabic-Indic digits, and keep Arabic words intact.
//  - Latin: lowercase and keep alphanumerics, including accents.
//  - CJK: keep contiguous runs as single tokens (no per-character explosion).
//  - Deterministic: the same input always yields the same tokens.

const ARABIC_DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g;
const TATWEEL = /\u0640/g;

// Arabic letter unification (applied after diacritic removal + NFKC).
// A single replacement pass is much faster than iterating every character,
// and it only touches the Arabic letters that actually need folding.
const ARABIC_FOLD_RE = /[\u0622\u0623\u0625\u0671\u0672\u0673\u0649\u0626\u0624\u0629\u06C0\u06C2\u06D5]/g;
const ARABIC_FOLD = {
  '\u0623': '\u0627', // أ -> ا
  '\u0625': '\u0627', // إ -> ا
  '\u0622': '\u0627', // آ -> ا
  '\u0671': '\u0627', // ٱ -> ا
  '\u0672': '\u0627',
  '\u0673': '\u0627',
  '\u0649': '\u064A', // ى -> ي
  '\u0626': '\u064A', // ئ -> ي
  '\u0624': '\u0648', // ؤ -> و
  '\u0629': '\u0647', // ة -> ه
  '\u06C0': '\u0647',
  '\u06C2': '\u0647',
  '\u06D5': '\u0647',
};

const ARABIC_INDIC_DIGITS = /[\u0660-\u0669]/g;
const EXTENDED_ARABIC_DIGITS = /[\u06F0-\u06F9]/g;

const TOKEN_RE = /[\p{L}\p{N}]+/gu;
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const NUMERIC_RE = /^\p{N}+$/u;

// Small, opinionated stop list. Kept short so recall stays high.
const STOP_WORDS = new Set([
  // English
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'could',
  'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have', 'he', 'her', 'here',
  'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'me',
  'my', 'no', 'not', 'of', 'on', 'or', 'our', 'out', 'she', 'should', 'so',
  'some', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these',
  'they', 'this', 'those', 'to', 'too', 'up', 'us', 'was', 'we', 'were', 'what',
  'when', 'where', 'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
  // Arabic (normalized forms)
  'في', 'من', 'على', 'الى', 'إلى', 'عن', 'مع', 'هذا', 'هذه', 'ذلك', 'تلك',
  'التي', 'الذي', 'الذين', 'كان', 'كانت', 'يكون', 'هو', 'هي', 'هم', 'انا',
  'أنا', 'نحن', 'انت', 'أنت', 'لا', 'لم', 'لن', 'قد', 'كل', 'بعض', 'او', 'أو',
  'ثم', 'حتى', 'بعد', 'قبل', 'بين', 'عند', 'لكن', 'كما', 'اي', 'أي', 'ما',
  'ولا', 'و', 'ف', 'ب', 'ل', 'ك',
]);

/**
 * Normalize text for matching. Safe for any Unicode input.
 * Steps are intentionally stable and language-agnostic where possible.
 */
export function normalizeText(input) {
  if (input === undefined || input === null) return '';
  let text = String(input);
  if (!text) return '';

  // NFKC folds presentation forms and compatibility characters.
  try {
    text = text.normalize('NFKC');
  } catch {
    // Extremely old runtimes: continue with raw text.
  }

  text = text.toLowerCase();
  text = text.replace(ARABIC_DIACRITICS, '');
  text = text.replace(TATWEEL, '');

  text = text.replace(ARABIC_FOLD_RE, (ch) => ARABIC_FOLD[ch] || ch);

  text = text
    .replace(ARABIC_INDIC_DIGITS, (d) => String.fromCharCode(d.charCodeAt(0) - 0x0660 + 48))
    .replace(EXTENDED_ARABIC_DIGITS, (d) => String.fromCharCode(d.charCodeAt(0) - 0x06f0 + 48));

  return text;
}

export function isStopWord(token) {
  return STOP_WORDS.has(token);
}

/**
 * Tokenize normalized text into weighted-search terms.
 * CJK runs are preserved as single tokens, Arabic/Latin words stay whole.
 */
export function tokenize(input, { keepStopWords = false } = {}) {
  const normalized = normalizeText(input);
  if (!normalized) return [];
  const tokens = [];

  for (const match of normalized.matchAll(TOKEN_RE)) {
    const token = match[0];
    if (!token) continue;
    if (token.length === 1) {
      // Keep single digits and single CJK characters; drop single Latin letters.
      if (!NUMERIC_RE.test(token) && !CJK_RE.test(token)) continue;
    }
    if (!keepStopWords && STOP_WORDS.has(token)) continue;
    tokens.push(token);
  }

  return tokens;
}

/** Tokenize a filesystem path, keeping the full path and its parts. */
export function tokenizePath(p) {
  const posix = String(p ?? '').replace(/\\/g, '/');
  if (!posix) return [];
  const parts = posix.split(/[\/._\-\s]+/).filter(Boolean);
  const tokens = [];
  for (const part of parts) {
    tokens.push(...tokenize(part));
  }
  // The whole path (normalized) is also matchable, e.g. "src/store.js".
  const whole = tokenize(posix.replace(/[\/._\-\s]+/g, ' '));
  if (whole.length > 1) tokens.push(whole.join(''));
  return tokens;
}

/** Normalize for dedupe comparison: whitespace only, case preserved. */
export function normalizeForDedupe(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

/**
 * Normalize for command/tag comparison: lowercase + Arabic normalization.
 */
export function looseKey(text) {
  return normalizeText(String(text ?? '').replace(/\s+/g, ' ').trim());
}

/** True when the string contains CJK characters (used for display hints). */
export function hasCjk(text) {
  return CJK_RE.test(String(text ?? ''));
}

/** Deterministic short slug suitable for a filename. */
export function slugify(text, maxLength = 40) {
  const normalized = normalizeText(String(text ?? '')).trim();
  const slug = normalized
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug || 'project';
}
