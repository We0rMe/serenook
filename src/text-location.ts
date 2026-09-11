export interface TextMatch { start: number; end: number }

/** Map normalized matches back to original UTF-16 offsets, including emoji and ligatures. */
export function locateText(text: string, terms: string[]): TextMatch | null {
  const starts: number[] = [], ends: number[] = [];
  let normalized = "";
  for (const part of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    const value = part.segment.normalize("NFKC");
    normalized += value;
    for (let i = 0; i < value.toLocaleLowerCase().length; i++) {
      starts.push(part.index);
      ends.push(part.index + part.segment.length);
    }
  }
  normalized = normalized.toLocaleLowerCase();
  let result: TextMatch | null = null;
  for (const term of terms) {
    const needle = term.normalize("NFKC").toLocaleLowerCase();
    if (!needle) continue;
    const index = normalized.indexOf(needle);
    if (index >= 0 && (!result || starts[index] < result.start)) {
      result = { start: starts[index], end: ends[index + needle.length - 1] };
    }
  }
  return result;
}

export function textExcerpt(text: string, match: TextMatch | null): string {
  const start = Math.max(0, (match?.start ?? 0) - 18);
  return `${start ? "…" : ""}${text.slice(start, start + 90).replace(/\s+/g, " ")}${text.length > start + 90 ? "…" : ""}`;
}

export function revealTextareaMatch(input: HTMLTextAreaElement, match: TextMatch): void {
  // A plain-text mirror measures wrapped lines without changing the actual page.
  const mirror = document.createElement("div");
  const style = getComputedStyle(input);
  Object.assign(mirror.style, {
    position: "fixed", left: "-10000px", top: "0", visibility: "hidden",
    width: `${input.clientWidth}px`, boxSizing: "border-box", whiteSpace: "pre-wrap",
    overflowWrap: "anywhere", font: style.font, lineHeight: style.lineHeight,
    letterSpacing: style.letterSpacing, padding: style.padding, tabSize: style.tabSize,
  });
  mirror.append(document.createTextNode(input.value.slice(0, match.start)));
  const marker = document.createElement("span");
  marker.textContent = input.value.slice(match.start, match.end) || "\u200b";
  mirror.append(marker, document.createTextNode(input.value.slice(match.end)));
  document.body.append(mirror);
  const top = marker.offsetTop;
  mirror.remove();
  input.focus({ preventScroll: true });
  input.setSelectionRange(match.start, match.end);
  input.scrollTop = Math.max(0, top - input.clientHeight / 2);
}

export function textFingerprint(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${text.length}:${hash >>> 0}`;
}
