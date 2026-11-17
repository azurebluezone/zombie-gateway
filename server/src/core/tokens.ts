/**
 * Token estimation.
 *
 * This is an estimator, never a tokenizer: the gateway does not ship a BPE table
 * and must not pretend to. Two rules keep it useful:
 *  - it is called an estimate everywhere it surfaces (headers, logs, usage);
 *  - real usage from the upstream is always preferred, and disagreement between
 *    the two is logged instead of smoothed over.
 */

/**
 * Latin prose lands near 4 chars/token; Indic scripts tokenise far worse.
 *
 * The two rates are applied per character class, not per string. Judging the
 * whole text by its first non-ASCII byte made one em dash double the estimate
 * for 700 characters of English, which is the kind of invented number this
 * project is trying not to publish.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let wide = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 127) wide += 1;
    else ascii += 1;
  }
  return Math.max(1, Math.ceil(ascii / 4 + wide / 2));
}
