/** A composed candidate only has an effect when it differs from the original. */
export function hasAcceptedRewrite(originalText: string, composedText: string): boolean {
  return originalText !== composedText;
}
