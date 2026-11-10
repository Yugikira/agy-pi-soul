export function splitBom(text) {
  if (text.startsWith("\uFEFF")) {
    return { bom: "\uFEFF", text: text.slice(1) };
  }
  return { bom: "", text };
}

export function normalizeToLF(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function getLineEndingAt(content, offset) {
  let lineFeed = content.indexOf("\n", offset);
  if (lineFeed === -1) lineFeed = content.lastIndexOf("\n", offset);
  if (lineFeed === -1) return content.includes("\r") ? "\r" : "\n";
  return content[lineFeed - 1] === "\r" ? "\r\n" : "\n";
}

export function applyReplacementsToOriginal(originalContent, replacements) {
  let crlfBefore = 0;
  let nextCrlf = originalContent.indexOf("\r\n");
  const toOriginal = (offset) => {
    while (nextCrlf !== -1 && nextCrlf - crlfBefore < offset) {
      crlfBefore++;
      nextCrlf = originalContent.indexOf("\r\n", nextCrlf + 2);
    }
    return offset + crlfBefore;
  };
  const parts = [];
  let endsWithCr = false;
  const push = (part) => {
    if (part.length === 0) return;
    if (endsWithCr && part[0] === "\n") parts.push("\n");
    parts.push(part);
    endsWithCr = part[part.length - 1] === "\r";
  };
  let position = 0;
  for (const replacement of replacements) {
    const start = toOriginal(replacement.matchIndex);
    push(originalContent.slice(position, start));
    const ending = getLineEndingAt(originalContent, start);
    push(ending === "\n" ? replacement.newText : replacement.newText.replaceAll("\n", ending));
    position = toOriginal(replacement.matchIndex + replacement.matchLength);
  }
  push(originalContent.slice(position));
  return parts.join("");
}
