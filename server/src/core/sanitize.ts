/**
 * Prompt hygiene.
 *
 * Pasted documents, model output and SDK payloads can carry invisible
 * characters. They are used as carriers: watermarking, hidden instructions,
 * and occasionally a plain bug (a zero-width joiner inside an identifier makes
 * two identical-looking strings unequal).
 *
 * The design rule is "report before remove":
 *  - the scan counts what it found, by kind, before anything is dropped;
 *  - removal never silently changes meaning: a single ZWJ/ZWNJ between letters
 *    is legitimate in Bengali, Persian and emoji sequences, so it survives;
 *  - bidi overrides, Unicode tag characters and control bytes are removed
 *    unconditionally, because no prose or code needs them.
 *
 * The sanitizer cleans bytes. It never interprets content, and it never treats
 * text as an instruction. That separation is the point: data stays data.
 */

import { GatewayError } from "./errors.ts";

export type SanitizeMode = "off" | "report" | "strip";

export interface SanitizeReport {
  mode: SanitizeMode;
  /** Characters that qualified for removal (found by a scan of the input). */
  detected: number;
  /** Characters actually removed (0 in report/off mode). */
  removed: number;
  /** Per-kind counts, so a log line explains what was found. */
  kinds: Record<string, number>;
  /** Runs of two or more zero-width characters: no linguistic purpose. */
  runs: number;
  /** Eight or more consecutive invisible characters: a byte carrier. */
  hiddenPayload: boolean;
  /** Trailing double-space steganography (markdown side channel). */
  trailingMark: boolean;
  /** Unicode tag block characters (the classic hidden-instruction vector). */
  tags: number;
  /** Bidi controls and isolates. */
  bidi: number;
  /** Sanitising two object keys produced the same name; originals were kept. */
  keyCollision: boolean;
}

const EMPTY_REPORT: SanitizeReport = {
  mode: "strip",
  detected: 0,
  removed: 0,
  kinds: {},
  runs: 0,
  hiddenPayload: false,
  trailingMark: false,
  tags: 0,
  bidi: 0,
  keyCollision: false,
};

/** Fast path: printable ASCII plus tab/LF/CR cannot contain any carrier. */
const ASCII_SAFE = /^[\x09\x0A\x0D\x20-\x7E]*$/;

const BIDI = new Set<number>();
for (let code = 0x202a; code <= 0x202e; code += 1) BIDI.add(code);
for (let code = 0x2066; code <= 0x2069; code += 1) BIDI.add(code);
BIDI.add(0x200e);
BIDI.add(0x200f);
BIDI.add(0x061c);

const WORD_JOINER = new Set<number>();
for (let code = 0x2060; code <= 0x2064; code += 1) WORD_JOINER.add(code);
for (let code = 0x206a; code <= 0x206f; code += 1) WORD_JOINER.add(code);

const FILLERS = new Set([0x115f, 0x1160, 0x3164, 0xffa0, 0x180e]);

const KIND_LABEL: Record<string, string> = {
  zw: "zero-width",
  bidi: "bidi-control",
  "word-joiner": "invisible-operator",
  tag: "unicode-tag",
  filler: "hangul-filler",
  "soft-hyphen": "soft-hyphen",
  bom: "byte-order-mark",
  control: "control-byte",
};

/**
 * Scripts in which ZWJ/ZWNJ changes shaping or word form. Kept as an allow-list
 * so that sprinkling a lone ZWNJ through Latin text cannot pass as orthography.
 */
const JOINING_SCRIPT =
  /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}\p{Script=Thai}\p{Script=Lao}\p{Script=Tibetan}\p{Script=Myanmar}\p{Script=Khmer}\p{Script=Mongolian}\p{Script=Hangul}]/u;

/** Letters, marks and emoji can legitimately sit on both sides of a ZWJ/ZWNJ. */
function joinable(code: number): boolean {
  if (code >= 0x1f000) return true; // emoji and pictographs
  if (code >= 0xfe00 && code <= 0xfe0f) return true; // variation selectors
  const char = String.fromCodePoint(code);
  if (!/[\p{L}\p{M}]/u.test(char)) return false; // ASCII, punctuation, spaces
  // A single ZWNJ between two Latin letters is a carrier, not orthography:
  // no Latin-script language uses it for shaping. The joining scripts do.
  return JOINING_SCRIPT.test(char);
}

function classify(code: number): string | null {
  if (code >= 0x200b && code <= 0x200d) return "zw";
  if (BIDI.has(code)) return "bidi";
  if (WORD_JOINER.has(code)) return "word-joiner";
  if (code >= 0xe0000 && code <= 0xe007f) return "tag";
  if (FILLERS.has(code)) return "filler";
  if (code === 0x00ad) return "soft-hyphen";
  if (code === 0xfeff) return "bom";
  if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return "control";
  if (code === 0x7f) return "control";
  if (code >= 0x80 && code <= 0x9f) return "control";
  return null;
}

function bump(report: SanitizeReport, kind: string): void {
  const label = KIND_LABEL[kind] ?? kind;
  report.kinds[label] = (report.kinds[label] ?? 0) + 1;
}

/**
 * Two or more lines ending in exactly two spaces is markdown's hard line break;
 * a sustained pattern across a long document is a side channel, not formatting.
 */
export function detectTrailingMark(text: string): boolean {
  const lines = text.split(/\r?\n/);
  if (lines.length < 12) return false;
  const marked = lines.filter((line) => /[^ \t] {2,}$/.test(line)).length;
  return marked >= Math.ceil(lines.length * 0.4);
}

/**
 * One pass to classify, one pass to decide. Splitting the passes matters: the
 * ZWJ/ZWNJ judgement needs both neighbours, and a decision made without the
 * right neighbour would strip real Bengali orthography.
 */
function scan(text: string): { report: SanitizeReport; drop: Set<number> } {
  const report: SanitizeReport = { ...EMPTY_REPORT, kinds: {} };

  const points: number[] = [];
  const kinds: Array<string | null> = [];
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    points.push(code);
    kinds.push(classify(code));
  }

  const drop = new Set<number>();
  let streak = 0;

  let index = 0;
  while (index < points.length) {
    const kind = kinds[index];

    if (!kind) {
      streak = 0;
      index += 1;
      continue;
    }

    if (kind !== "zw") {
      report.detected += 1;
      bump(report, kind);
      if (kind === "tag") report.tags += 1;
      if (kind === "bidi") report.bidi += 1;
      drop.add(index);

      streak += 1;
      if (streak >= 8) report.hiddenPayload = true;

      index += 1;
      continue;
    }

    let end = index;
    while (end < points.length && kinds[end] === "zw") end += 1;
    const length = end - index;

    for (let position = index; position < end; position += 1) {
      report.detected += 1;
      bump(report, "zw");
    }
    if (length >= 2) report.runs += 1;
    streak += length;
    if (streak >= 8) report.hiddenPayload = true;

    if (length === 1) {
      const code = points[index] as number;
      const previous = points[index - 1];
      const next = points[index + 1];
      const orthographic =
        code !== 0x200b &&
        typeof previous === "number" &&
        typeof next === "number" &&
        joinable(previous) &&
        joinable(next);
      if (!orthographic) drop.add(index);
    } else {
      for (let position = index; position < end; position += 1) drop.add(position);
    }

    index = end;
  }

  report.trailingMark = detectTrailingMark(text);
  return { report, drop };
}

function apply(text: string, drop: Set<number>): string {
  if (drop.size === 0) return text;
  let out = "";
  let index = 0;
  for (const char of text) {
    if (!drop.has(index)) out += char;
    index += 1;
  }
  return out;
}

export function sanitizeText(
  input: string,
  mode: SanitizeMode = "strip",
): { text: string; report: SanitizeReport } {
  const text = typeof input === "string" ? input : String(input ?? "");
  if (mode === "off" || text.length === 0) {
    return { text, report: emptyReport(mode) };
  }

  if (ASCII_SAFE.test(text)) {
    // Trailing double-space marks are pure ASCII, so the fast path may not skip
    // them. The prefilter keeps ordinary single-spaced documents cheap.
    const report = emptyReport(mode);
    if (text.includes("\n") && /[^ \t] {2,}(\r?\n|$)/.test(text)) {
      report.trailingMark = detectTrailingMark(text);
    }
    return { text, report };
  }

  const { report, drop } = scan(text);
  const shouldStrip = mode === "strip";
  report.mode = mode;
  report.removed = shouldStrip ? drop.size : 0;
  return { text: shouldStrip ? apply(text, drop) : text, report };
}

/** Cheap scan for callers that only need the report (headers, logs, admin). */
export function scanText(input: string): SanitizeReport {
  return sanitizeText(input, "report").report;
}

export function emptyReport(mode: SanitizeMode = "strip"): SanitizeReport {
  return { ...EMPTY_REPORT, mode, kinds: {} };
}

export function mergeReports(target: SanitizeReport, source: SanitizeReport): SanitizeReport {
  target.detected += source.detected;
  target.removed += source.removed;
  target.runs += source.runs;
  target.tags += source.tags;
  target.bidi += source.bidi;
  target.hiddenPayload = target.hiddenPayload || source.hiddenPayload;
  target.trailingMark = target.trailingMark || source.trailingMark;
  target.keyCollision = target.keyCollision || source.keyCollision;
  for (const [kind, count] of Object.entries(source.kinds)) {
    target.kinds[kind] = (target.kinds[kind] ?? 0) + count;
  }
  return target;
}

export function isSuspicious(report: SanitizeReport): boolean {
  return (
    report.hiddenPayload ||
    report.runs > 0 ||
    report.tags > 0 ||
    report.bidi > 0 ||
    report.detected >= 3
  );
}

/**
 * Deep sanitizer for request JSON.
 *
 * Keys are cleaned as well, because a tool name or an argument name is a string
 * too. A key collision is never resolved by dropping one side: the original key
 * is kept and the collision is reported, so the caller can see that the payload
 * tried to collapse two fields into one.
 *
 * Depth is capped: an unbounded walk over attacker-supplied JSON is a stack
 * exhaustion vector, and no chat payload legitimately nests 64 levels deep.
 */
const MAX_JSON_DEPTH = 64;

export function sanitizeJson<T>(
  value: T,
  mode: SanitizeMode = "strip",
): { value: T; report: SanitizeReport } {
  const report = emptyReport(mode);
  if (mode === "off") return { value, report };

  const walk = (node: unknown, depth: number): unknown => {
    if (depth > MAX_JSON_DEPTH) {
      throw new GatewayError({
        message: `Request body nesting exceeds ${MAX_JSON_DEPTH} levels`,
        status: 400,
        code: "invalid_request_error",
      });
    }
    if (typeof node === "string") {
      const result = sanitizeText(node, mode);
      mergeReports(report, result.report);
      return result.text;
    }
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));
    if (typeof node === "object" && node !== null) {
      const source = node as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(source)) {
        const cleaned = sanitizeText(key, mode);
        mergeReports(report, cleaned.report);
        const finalKey = cleaned.text;
        if (finalKey !== key && Object.prototype.hasOwnProperty.call(source, finalKey)) {
          report.keyCollision = true;
          out[key] = walk(item, depth + 1);
          continue;
        }
        out[finalKey] = walk(item, depth + 1);
      }
      return out;
    }
    return node;
  };

  return { value: walk(value, 0) as T, report };
}

/** One compact header value: counts, never content. */
export function reportHeader(report: SanitizeReport): string {
  if (report.mode === "off") return "off";
  if (report.detected === 0 && !report.trailingMark) return "clean";
  const kinds = Object.entries(report.kinds)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, count]) => `${kind}:${count}`)
    .join(",");
  const flags = [
    report.hiddenPayload ? "hidden-payload" : null,
    report.trailingMark ? "trailing-mark" : null,
    report.keyCollision ? "key-collision" : null,
  ]
    .filter(Boolean)
    .join("+");
  return [kinds || null, flags || null].filter(Boolean).join(";");
}
