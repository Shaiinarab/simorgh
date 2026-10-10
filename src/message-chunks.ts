// ── The outbound message splitter ────────────────────────────────────────────
//
// One splitter, two gateways. Telegram's 4096-char ceiling and Discord's 2000-char
// ceiling are different numbers over the same question — "how do we deliver an answer
// longer than the platform allows?" — and the answer must exist exactly once.
//
// It lived inside `telegram.ts`, and ADR-0008's door-3 pattern would have copied it
// into `discord.ts`. Two copies of one algorithm is the failure this repo documents
// in `ledger.ts`: nothing compares them, so a fix to one silently misses the other,
// and nothing goes red. The limit stays a parameter because it is a property of the
// platform, not of the splitting.
//
// Preference order is deliberate, and mirrors what a human would do: break at the last
// newline inside the window, but refuse a break so deep into the window that the
// fragment would read as a truncation (`maxChars * 0.6`). Past that, hard-cut at the
// limit — an ugly break beats a lost tail, which is why the chunks are asserted
// lossless by the tests rather than merely "short enough".
//
// An empty string yields one empty chunk, because that is what the original Telegram
// implementation did and both call sites already substitute a fallback before calling
// ("No answer returned."). The behaviour is preserved deliberately: this extraction is
// a refactor, and a refactor that also moves a boundary is a change wearing a
// refactor's clothes.

export function splitOutgoingMessage(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf("\n", maxChars);
    if (cut < Math.floor(maxChars * 0.6)) cut = maxChars;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
