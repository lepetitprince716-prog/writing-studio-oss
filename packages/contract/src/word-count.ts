/**
 * Manuscript word count for a mixed CJK / Latin document. Zero-dependency leaf
 * module: both apps import it via the './word-count' subpath so the contract
 * barrel (and zod) stays out of the web entry chunk.
 *
 * Rule: each CJK ideograph counts as one; every run
 * of Latin letters / digits counts as one word. Whitespace and punctuation
 * between them are not counted.
 *
 * Examples:
 *   countManuscriptWords('你好world')        === 3   // 你 好 + "world"
 *   countManuscriptWords('第3章 The End')    === 5   // 第 章 + "3" "The" "End"
 *   countManuscriptWords('  空 格  a b  ')   === 4   // 空 格 + "a" "b"
 */

const CJK = /[㐀-䶿一-鿿]/gu;
const LATIN_WORD = /[0-9A-Za-zÀ-ɏ]+/gu;

export function countManuscriptWords(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0;
  const rest = text.replace(CJK, ' ');
  return cjk + (rest.match(LATIN_WORD)?.length ?? 0);
}
