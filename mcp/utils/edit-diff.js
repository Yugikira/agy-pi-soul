import * as Diff from "diff";

/** Number of lines as `text.split("\n").length` counts them, without building the array. */
function countLines(text) {
  return countLineFeeds(text, 0, text.length) + 1;
}

function countLineFeeds(text, start, end) {
  let count = 0;
  for (let index = text.indexOf("\n", start); index !== -1 && index < end; index = text.indexOf("\n", index + 1)) {
    count++;
  }
  return count;
}

/** Start of the line that contains `offset`. */
function lineStartBefore(text, offset) {
  // lastIndexOf treats a negative position as 0 and would find a line feed at offset 0.
  return offset === 0 ? 0 : text.lastIndexOf("\n", offset - 1) + 1;
}

/**
 * Unchanged lines diffed on each side of a replacement. Well above the 4 context lines shown, so jsdiff
 * aligns a change within its window as it would over the whole file.
 */
const DIFF_WINDOW_MARGIN_LINES = 32;

/** Whole-line windows with margin around the replacements, which are sorted and disjoint; overlapping windows merge. */
function getDiffWindows(baseContent, replacements) {
  const windows = [];
  // Offset and line deltas of the replacements before the current one, and a line-counting cursor.
  let offsetDelta = 0;
  let lineDelta = 0;
  let cursorOffset = 0;
  let cursorLine = 0;
  for (const replacement of replacements) {
    const matchEnd = replacement.matchIndex + replacement.matchLength;
    let start = lineStartBefore(baseContent, replacement.matchIndex);
    for (let i = 0; i < DIFF_WINDOW_MARGIN_LINES && start > 0; i++) {
      start = lineStartBefore(baseContent, start - 1);
    }
    let end = matchEnd;
    for (let i = 0; i <= DIFF_WINDOW_MARGIN_LINES && end < baseContent.length; i++) {
      const lineFeed = baseContent.indexOf(
        "\n",
        i === 0 ? Math.max(matchEnd - 1, replacement.matchIndex) : end
      );
      end = lineFeed === -1 ? baseContent.length : lineFeed + 1;
    }
    const replacementOffsetDelta = replacement.newText.length - replacement.matchLength;
    const replacementLineDelta =
      countLineFeeds(replacement.newText, 0, replacement.newText.length) -
      countLineFeeds(baseContent, replacement.matchIndex, matchEnd);
    const previous = windows.at(-1);
    if (previous && start <= previous.oldEnd) {
      previous.oldEnd = Math.max(previous.oldEnd, end);
      previous.newEnd = previous.oldEnd + offsetDelta + replacementOffsetDelta;
    } else {
      cursorLine += countLineFeeds(baseContent, cursorOffset, start);
      cursorOffset = start;
      windows.push({
        oldStart: start,
        oldEnd: end,
        oldLine: cursorLine,
        newStart: start + offsetDelta,
        newEnd: end + offsetDelta + replacementOffsetDelta,
        newLine: cursorLine + lineDelta,
      });
    }
    offsetDelta += replacementOffsetDelta;
    lineDelta += replacementLineDelta;
  }
  return windows;
}

/** Format jsdiff line parts as display diff lines, numbering from the given 1-based old and new lines. */
function formatDisplayDiff(parts, oldStartLine, newStartLine, lineNumWidth, contextLines) {
  const output = [];
  let oldLineNum = oldStartLine;
  let newLineNum = newStartLine;
  let lastWasChange = false;
  let firstChangedLine;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const raw = part.value.split("\n");
    if (raw[raw.length - 1] === "") {
      raw.pop();
    }
    if (part.added || part.removed) {
      // Capture the first changed line (in the new file)
      if (firstChangedLine === undefined) {
        firstChangedLine = newLineNum;
      }
      for (const line of raw) {
        if (part.added) {
          const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
          output.push(`+${lineNum} ${line}`);
          newLineNum++;
        } else {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
          output.push(`-${lineNum} ${line}`);
          oldLineNum++;
        }
      }
      lastWasChange = true;
    } else {
      // Context lines - only show a few before/after changes
      const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
      const hasLeadingChange = lastWasChange;
      const hasTrailingChange = nextPartIsChange;
      if (hasLeadingChange && hasTrailingChange) {
        if (raw.length <= contextLines * 2) {
          for (const line of raw) {
            const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
            output.push(` ${lineNum} ${line}`);
            oldLineNum++;
            newLineNum++;
          }
        } else {
          const leadingLines = raw.slice(0, contextLines);
          const trailingLines = raw.slice(raw.length - contextLines);
          const skippedLines = raw.length - leadingLines.length - trailingLines.length;
          for (const line of leadingLines) {
            const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
            output.push(` ${lineNum} ${line}`);
            oldLineNum++;
            newLineNum++;
          }
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += skippedLines;
          newLineNum += skippedLines;
          for (const line of trailingLines) {
            const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
            output.push(` ${lineNum} ${line}`);
            oldLineNum++;
            newLineNum++;
          }
        }
      } else if (hasLeadingChange) {
        const shownLines = raw.slice(0, contextLines);
        const skippedLines = raw.length - shownLines.length;
        for (const line of shownLines) {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
          output.push(` ${lineNum} ${line}`);
          oldLineNum++;
          newLineNum++;
        }
        if (skippedLines > 0) {
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += skippedLines;
          newLineNum += skippedLines;
        }
      } else if (hasTrailingChange) {
        const skippedLines = Math.max(0, raw.length - contextLines);
        if (skippedLines > 0) {
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += skippedLines;
          newLineNum += skippedLines;
        }
        for (const line of raw.slice(skippedLines)) {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
          output.push(` ${lineNum} ${line}`);
          oldLineNum++;
          newLineNum++;
        }
      } else {
        // Skip these context lines entirely
        oldLineNum += raw.length;
        newLineNum += raw.length;
      }
      lastWasChange = false;
    }
  }
  return { output, firstChangedLine };
}

/**
 * Diff an edit only around its replacements, so time and memory follow the size of the change instead of
 * the file. Returns the display diff, a windowed unified patch, and the first changed line (1-based).
 */
export function generateEditDiff(filePath, baseContent, newContent, replacements, contextLines = 4) {
  const lineNumWidth = String(Math.max(countLines(baseContent), countLines(newContent))).length;
  const skipMarker = ` ${"".padStart(lineNumWidth, " ")} ...`;
  const output = [];
  const hunks = [];
  let firstChangedLine;
  for (const window of getDiffWindows(baseContent, replacements)) {
    const oldText = baseContent.slice(window.oldStart, window.oldEnd);
    const newText = newContent.slice(window.newStart, window.newEnd);
    const shown = formatDisplayDiff(
      Diff.diffLines(oldText, newText),
      window.oldLine + 1,
      window.newLine + 1,
      lineNumWidth,
      contextLines
    );
    firstChangedLine ??= shown.firstChangedLine;
    // Both windows around a run of unchanged lines mark it as skipped; the whole-file diff shows one marker.
    if (output.at(-1) === skipMarker && shown.output[0] === skipMarker) {
      shown.output.shift();
    }
    // A loop, not push(...lines): spreading a replacement of many lines overflows the call stack.
    for (const line of shown.output) {
      output.push(line);
    }
    const patch = Diff.structuredPatch(filePath, filePath, oldText, newText, undefined, undefined, {
      context: contextLines,
    });
    for (const hunk of patch.hunks) {
      hunks.push({
        ...hunk,
        oldStart: hunk.oldStart + window.oldLine,
        newStart: hunk.newStart + window.newLine,
      });
    }
  }
  const patch = Diff.formatPatch(
    { oldFileName: filePath, newFileName: filePath, oldHeader: undefined, newHeader: undefined, hunks },
    Diff.FILE_HEADERS_ONLY
  );
  return { diff: output.join("\n"), patch, firstChangedLine };
}

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
      throw new Error(getEmptyOldTextError(filePath, i, normalizedEdits.length));
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
      throw new Error(getNotFoundError(filePath, i, normalizedEdits.length));
    }
    const occurrences = countOccurrences(replacementBaseContent, edit.oldText);
    if (occurrences > 1) {
      throw new Error(getDuplicateError(filePath, i, normalizedEdits.length, occurrences));
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
      throw new Error(
        `edits[${prev.editIndex}] and edits[${curr.editIndex}] overlap in ${filePath}. Merge them into one edit or target disjoint regions.`
      );
    }
  }

  const baseContent = normalizedContent;
  const replacements = usedFuzzyMatch
    ? widenReplacementsToLines(normalizedContent, replacementBaseContent, matchedEdits)
    : matchedEdits;

  const newContent = applyReplacements(baseContent, replacements);
  if (baseContent === newContent) {
    throw new Error(getNoChangeError(filePath, normalizedEdits.length));
  }

  return { baseContent, newContent, replacements };
}

function getNotFoundError(filePath, editIndex, totalEdits) {
  if (totalEdits === 1) {
    return `Could not find the exact text in ${filePath}. The old text must match exactly including all whitespace and newlines.`;
  }
  return `Could not find edits[${editIndex}] in ${filePath}. The oldText must match exactly including all whitespace and newlines.`;
}

function getDuplicateError(filePath, editIndex, totalEdits, occurrences) {
  if (totalEdits === 1) {
    return `Found ${occurrences} occurrences of the text in ${filePath}. The text must be unique. Please provide more context to make it unique.`;
  }
  return `Found ${occurrences} occurrences of edits[${editIndex}] in ${filePath}. Each oldText must be unique. Please provide more context to make it unique.`;
}

function getEmptyOldTextError(filePath, editIndex, totalEdits) {
  if (totalEdits === 1) {
    return `oldText must not be empty in ${filePath}.`;
  }
  return `edits[${editIndex}].oldText must not be empty in ${filePath}.`;
}

function getNoChangeError(filePath, totalEdits) {
  if (totalEdits === 1) {
    return `No changes made to ${filePath}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`;
  }
  return `No changes made to ${filePath}. The replacements produced identical content.`;
}
