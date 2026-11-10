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

export function normalizeForFuzzyMatch(text) {
  return text
    .normalize("NFKC")
    // Strip trailing whitespace per line
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    // Smart single quotes → '
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    // Smart double quotes → "
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    // Various dashes/hyphens → -
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    // Special spaces → regular space
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

export function fuzzyFindText(content, oldText) {
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return {
      found: true,
      index: exactIndex,
      matchLength: oldText.length,
      usedFuzzyMatch: false,
      contentForReplacement: content,
    };
  }
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
  if (fuzzyIndex === -1) {
    return {
      found: false,
      index: -1,
      matchLength: 0,
      usedFuzzyMatch: false,
      contentForReplacement: content,
    };
  }
  return {
    found: true,
    index: fuzzyIndex,
    matchLength: fuzzyOldText.length,
    usedFuzzyMatch: true,
    contentForReplacement: fuzzyContent,
  };
}

export function countOccurrences(content, oldText) {
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  return fuzzyContent.split(fuzzyOldText).length - 1;
}

function splitLinesWithEndings(content) {
  return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

function getLineSpans(content) {
  let offset = 0;
  return splitLinesWithEndings(content).map((line) => {
    const span = { start: offset, end: offset + line.length };
    offset = span.end;
    return span;
  });
}

function getReplacementLineRange(lines, replacement) {
  const replacementStart = replacement.matchIndex;
  const replacementEnd = replacement.matchIndex + replacement.matchLength;
  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (replacementStart >= line.start && replacementStart < line.end) {
      startLine = i;
      break;
    }
  }
  if (startLine === -1) {
    throw new Error("Replacement range is outside the base content.");
  }
  let endLine = startLine;
  while (endLine < lines.length && lines[endLine].end < replacementEnd) {
    endLine++;
  }
  if (endLine >= lines.length) {
    throw new Error("Replacement range is outside the base content.");
  }
  return { startLine, endLine: endLine + 1 };
}

function applyReplacements(content, replacements, offset = 0) {
  let result = content;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const replacement = replacements[i];
    const matchIndex = replacement.matchIndex - offset;
    result =
      result.substring(0, matchIndex) + replacement.newText + result.substring(matchIndex + replacement.matchLength);
  }
  return result;
}

function widenReplacementsToLines(originalContent, baseContent, replacements) {
  const originalLines = getLineSpans(originalContent);
  const baseLines = getLineSpans(baseContent);
  if (originalLines.length !== baseLines.length) {
    throw new Error("Cannot preserve unchanged lines because the base content has a different line count.");
  }
  const groups = [];
  const sortedReplacements = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
  for (const replacement of sortedReplacements) {
    const range = getReplacementLineRange(baseLines, replacement);
    const current = groups[groups.length - 1];
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine);
      current.replacements.push(replacement);
      continue;
    }
    groups.push({ ...range, replacements: [replacement] });
  }
  return groups.map((group) => {
    const groupStartOffset = baseLines[group.startLine].start;
    const groupEndOffset = baseLines[group.endLine - 1].end;
    const originalStart = originalLines[group.startLine].start;
    return {
      matchIndex: originalStart,
      matchLength: originalLines[group.endLine - 1].end - originalStart,
      newText: applyReplacements(baseContent.slice(groupStartOffset, groupEndOffset), group.replacements, groupStartOffset),
    };
  });
}

export function applyEditsToNormalizedContent(normalizedContent, edits, filePath = "") {
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLF(String(edit.oldText ?? "")),
    newText: normalizeToLF(String(edit.newText ?? "")),
  }));

  for (let i = 0; i < normalizedEdits.length; i++) {
    if (normalizedEdits[i].oldText.length === 0) {
      throw new Error(`oldText must not be empty${filePath ? ` in ${filePath}` : ""}.`);
    }
  }

  const initialMatches = normalizedEdits.map((edit) => fuzzyFindText(normalizedContent, edit.oldText));
  const usedFuzzyMatch = initialMatches.some((match) => match.usedFuzzyMatch);
  const replacementBaseContent = usedFuzzyMatch ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;

  const matchedEdits = [];
  for (let i = 0; i < normalizedEdits.length; i++) {
    const edit = normalizedEdits[i];
    const matchResult = fuzzyFindText(replacementBaseContent, edit.oldText);
    if (!matchResult.found) {
      const errPrefix = normalizedEdits.length === 1
        ? `Could not find exact match for 'oldText'${filePath ? ` in ${filePath}` : ""}:\n${edit.oldText}`
        : `Could not find edits[${i}]${filePath ? ` in ${filePath}` : ""}:\n${edit.oldText}`;
      throw new Error(errPrefix);
    }
    const occurrences = countOccurrences(replacementBaseContent, edit.oldText);
    if (occurrences > 1) {
      const errPrefix = normalizedEdits.length === 1
        ? `Found ${occurrences} occurrences of 'oldText'${filePath ? ` in ${filePath}` : ""}. The text must be unique. Please provide more context to disambiguate:\n${edit.oldText}`
        : `Found ${occurrences} occurrences of edits[${i}]${filePath ? ` in ${filePath}` : ""}. Each oldText must be unique. Please provide more context to disambiguate:\n${edit.oldText}`;
      throw new Error(errPrefix);
    }
    matchedEdits.push({
      editIndex: i,
      matchIndex: matchResult.index,
      matchLength: matchResult.matchLength,
      newText: edit.newText,
    });
  }

  matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matchedEdits.length; i++) {
    const prev = matchedEdits[i - 1];
    const curr = matchedEdits[i];
    if (prev.matchIndex + prev.matchLength > curr.matchIndex) {
      throw new Error(`Overlapping edits detected between edit[${prev.editIndex}] and edit[${curr.editIndex}]. Merge nearby edits into a single block.`);
    }
  }

  const baseContent = normalizedContent;
  const replacements = usedFuzzyMatch
    ? widenReplacementsToLines(normalizedContent, replacementBaseContent, matchedEdits)
    : matchedEdits;

  const newContent = applyReplacements(baseContent, replacements);
  if (baseContent === newContent) {
    throw new Error(`Replacement produced identical content${filePath ? ` for ${filePath}` : ""}. No changes made.`);
  }

  return { baseContent, newContent, replacements };
}
