/**
 * ROUND-72 (R72-a): TASK HINTS — the deterministic task→skill matcher.
 *
 * The owner's R72 directive ("the agent accesses [skills] … on the basis of
 * the task") needed a bridge between WHAT the user just said and WHICH of
 * the advertised skills (prompt SKILLS section, R61/R70-b progressive
 * disclosure) the turn is actually about. This module is that bridge — and
 * it is deliberately DUMB:
 *
 *   · NO LLM, no async, no cost, no latency — pure deterministic string
 *     matching over the turn's user message and each skill's one-line
 *     description (house preference: honest, testable, zero-latency; an
 *     extra model call per turn just to pick a skill would be the opposite).
 *   · The R71 skills round made every builtin description TRIGGER-RICH by
 *     convention ("Use when … 'my test fails' … NOT for …"): quoted phrases
 *     are the verbatim user phrasings, so the matcher's strongest signal is
 *     exactly the one the descriptions were written to carry.
 *   · The output is ADVICE, never a side effect: the caller (prompts.ts)
 *     renders one "Task signal: …" line into the SKILLS section. Nothing is
 *     auto-loaded — progressive disclosure stays the contract (read_skill
 *     FIRST, body on demand); the hint only raises the odds the model opens
 *     the right skill on turn one.
 *
 * SCORING (per skill, against the incoming message):
 *
 *   · QUOTED PHRASES — every 'single' or "double" quoted string in the
 *     description (≥2 chars, deduped). A phrase that appears in the message
 *     (case-insensitive substring — "word-boundary-ish" on purpose: 'deploy'
 *     may also surface inside "deployment", which is a signal, not noise)
 *     scores its WORD COUNT × 5. Phrase hits are the strong signal, and any
 *     one of them alone qualifies the skill.
 *   · TOKENS — the description lowercased, split on non-alphanumerics, tokens
 *     shorter than 3 chars dropped, a STOPWORDS set of grammatical glue
 *     dropped (the/and/for/use/when/this/that/with/your/you/not/are/was/
 *     into/from/they/them/its/… — every R71 description opens "Use when the
 *     user says…"; without the stopword filter those words would match every
 *     message). Each token present as a WHOLE WORD in the message scores 1.
 *   · A skill qualifies with total score ≥ 2 OR ≥1 phrase hit; survivors sort
 *     by score desc, then name asc (deterministic ties); the TOP 2 are
 *     returned (a longer shortlist would just be a second skill list — the
 *     advisory line is one sentence).
 *
 * HYGIENE:
 *   · Empty/whitespace message → no hints (nothing to match); no skills →
 *     no hints. The matcher never invents a signal.
 *   · The message is capped at 8,000 chars before matching (defensive: a
 *     pasted log wall must not turn into a quadratic scan).
 *   · Contractions are flattened on BOTH sides before matching ("don't" →
 *     "dont"): an apostrophe between two letters is a contraction, never a
 *     quote delimiter — so the quoted phrase 'don't hallucinate' extracts
 *     as ONE phrase and still meets a message that spells it the same way,
 *     while a bare 'don' fragment can never leak out of "don't".
 *   · Hints are EPHEMERAL: computed per turn in prepareTurn (runtime.ts),
 *     rendered into that turn's system prompt, never persisted. They also
 *     inherit the resolver's gating for free — hints are scored against the
 *     EFFECTIVE skills (resolveEffectiveSkills: computer-use master switch,
 *     per-agent allowlist), so a dark skill is never recommended.
 *
 * ROUND-73 (R73-b): the same deterministic matcher now serves the TASK-MODE
 * tier — computeModeHints scores mode descriptions (R73-a wrote them in the
 * same trigger-rich convention) and feeds the TASK MODES section's mode
 * signal line. The scoring core was EXTRACTED into scoreQualified (shared,
 * unchanged algorithm); computeTaskHints keeps its exact signature,
 * behavior, and tie-break (name asc) — the r72 suite must stay green
 * UNMODIFIED. computeModeHints ties break by id asc (switch_mode addresses
 * ids). Same constants, same hygiene rules, same top-2 discipline.
 */
/** One scored match: the skill's name and its deterministic signal score. */
export interface TaskHint {
  skillName: string;
  score: number;
}

/** ROUND-73 (R73-b): the MODE sibling — one scored match carrying the task
 *  mode's id (switch_mode addresses ids, not names). Same scorer, same
 *  constants; only the tie-break key differs (id asc, not name asc). */
export interface ModeHint {
  modeId: string;
  score: number;
}

/** The advisory line is one sentence — two names is already a shortlist. */
const MAX_HINTS = 2;
/** Below this total a skill is noise, not signal (one token hit ≠ a match). */
const SCORE_THRESHOLD = 2;
/** Phrase weight per word — 'this bug' (2 words) out-scores any token pile. */
const PHRASE_WORD_WEIGHT = 5;
/** Defensive cap on the message text considered (a pasted log wall). */
const MESSAGE_CHAR_CAP = 8_000;
/** Tokens shorter than this are glue ("is", "to", "go") — no signal. */
const MIN_TOKEN_LEN = 3;

/**
 * Grammatical glue dropped from token scoring (phrases bypass this — a
 * quoted 'what changed?' is verbatim phrasing and scores as a phrase).
 * Curated for the R71-style description convention: every description opens
 * "Use when the user says …", so those words must not match everything.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "use", "used", "uses", "using", "when", "this", "that",
  "these", "those", "with", "without", "your", "yours", "you", "not", "are",
  "was", "were", "been", "being", "its", "into", "from", "they", "them",
  "their", "there", "here", "has", "have", "had", "but", "all", "can",
  "will", "would", "should", "could", "may", "might", "must", "does", "did",
  "than", "then", "too", "very", "just", "only", "also", "more", "most",
  "some", "any", "each", "every", "both", "few", "other", "others", "such",
  "own", "same", "what", "which", "who", "whom", "whose", "why", "how",
  "where", "while", "because", "until", "against", "between", "through",
  "during", "before", "after", "above", "below", "over", "under", "again",
  "further", "once", "about", "out", "off", "down", "nor", "yet", "per",
  "via", "one", "two", "who",
]);

/** Flatten contractions: an apostrophe between two letters joins the word
 * ("don't" → "dont", typographic ’ included) — see the module header. */
function flattenContractions(text: string): string {
  return text.replace(/([a-zA-Z])['’]([a-zA-Z])/g, "$1$2");
}

/**
 * The quoted phrases of a (lowercased, contraction-flattened) description —
 * single '…' and double "…" runs of ≥2 chars, deduped, each carrying at
 * least one letter or digit (punctuation-only fragments are noise).
 */
function extractQuotedPhrases(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /'([^']{2,})'|"([^"]{2,})"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const phrase = (match[1] ?? match[2] ?? "").trim();
    if (phrase === "" || seen.has(phrase)) continue;
    if (!/[a-z0-9]/.test(phrase)) continue;
    seen.add(phrase);
    out.push(phrase);
  }
  return out;
}

/** Unique scoring tokens of a lowercased text: ≥3 chars, not stopwords. */
function tokenize(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[^a-z0-9]+/)) {
    if (raw.length < MIN_TOKEN_LEN || STOPWORDS.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/**
 * ROUND-73 (R73-b): the SHARED SCORER CORE — message prep (cap, contraction
 * flattening, lowercasing, whole-word set), quoted-phrase scoring (word
 * count × 5, any hit qualifies), and token scoring (≥3 chars, no stopwords,
 * whole-word membership = 1). This is EXACTLY the algorithm computeTaskHints
 * ran since R72-a, extracted so the mode matcher (computeModeHints) reuses
 * the same deterministic core byte-for-byte. Returns the QUALIFIED entries
 * in INPUT order (index + score) — the public wrappers own the field they
 * surface (skillName vs modeId), the tie-break key, and the top-N slice.
 * Empty item list → []; empty/whitespace message → [].
 */
function scoreQualified(
  userMessage: string,
  items: ReadonlyArray<{ description: string }>,
): Array<{ index: number; score: number }> {
  if (items.length === 0) return [];
  const capped = userMessage.slice(0, MESSAGE_CHAR_CAP);
  if (capped.trim() === "") return [];

  // Both sides normalized the SAME way: contraction-flattened + lowercased.
  const message = flattenContractions(capped).toLowerCase();
  // Whole-word token membership for the message (tokens are alphanumeric, so
  // Set membership ≡ a \b-bounded match on the lowercased message).
  const messageWords = new Set(message.split(/[^a-z0-9]+/));

  const qualified: Array<{ index: number; score: number }> = [];
  for (let i = 0; i < items.length; i++) {
    const description = flattenContractions(items[i]!.description).toLowerCase();
    let score = 0;
    let phraseHit = false;

    for (const phrase of extractQuotedPhrases(description)) {
      if (!message.includes(phrase)) continue;
      const words = phrase.split(/\s+/).filter((word) => word !== "");
      score += Math.max(words.length, 1) * PHRASE_WORD_WEIGHT;
      phraseHit = true;
    }

    for (const token of tokenize(description)) {
      if (messageWords.has(token)) score += 1;
    }

    if (phraseHit || score >= SCORE_THRESHOLD) {
      qualified.push({ index: i, score });
    }
  }
  return qualified;
}

/**
 * Score every skill's description against the incoming user message and
 * return the top hints (score desc, then name asc; at most 2). Pure and
 * synchronous — no LLM, no I/O, no side effects. Empty or whitespace-only
 * message → []; no skills → [].
 */
export function computeTaskHints(
  userMessage: string,
  skills: ReadonlyArray<{ name: string; description: string }>,
): TaskHint[] {
  const hints: TaskHint[] = scoreQualified(userMessage, skills).map((q) => ({
    skillName: skills[q.index]!.name,
    score: q.score,
  }));
  hints.sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.skillName < b.skillName ? -1 : a.skillName > b.skillName ? 1 : 0,
  );
  return hints.slice(0, MAX_HINTS);
}

/**
 * ROUND-73 (R73-b): the mode matcher — the R72-a scorer applied to TASK-MODE
 * descriptions (R73-a wrote them in the same trigger-rich convention, so
 * 'fix this bug' surfaces the debug POSTURE exactly like it surfaces the
 * debugging skill). Same constants (top-2, threshold ≥ 2, phrases × 5);
 * ties break by id ASC (switch_mode addresses ids — the deterministic
 * order the picker and the advisory line can both rely on). Pure and
 * synchronous; hints are per-turn EPHEMERAL. Empty message → []; no modes → [].
 */
export function computeModeHints(
  userMessage: string,
  modes: ReadonlyArray<{ id: string; description: string }>,
): ModeHint[] {
  const hints: ModeHint[] = scoreQualified(userMessage, modes).map((q) => ({
    modeId: modes[q.index]!.id,
    score: q.score,
  }));
  hints.sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.modeId < b.modeId ? -1 : a.modeId > b.modeId ? 1 : 0,
  );
  return hints.slice(0, MAX_HINTS);
}
