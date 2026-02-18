/**
 * Parse git diff output into hunks for selective staging
 */

export interface Hunk {
  /** 0-based index of the hunk in the diff */
  index: number;
  /** Header line: @@ -oldStart,oldCount +newStart,newCount @@ */
  header: string;
  /** Full hunk content including header (valid git patch) */
  content: string;
  /** Start line in new file (1-based) */
  newStart: number;
  /** Line count in new file */
  newCount: number;
}

export interface ParsedDiff {
  /** Diff header (e.g. "diff --git a/file b/file") */
  header: string;
  /** File path from diff header */
  filePath: string;
  /** Individual hunks */
  hunks: Hunk[];
}

const HUNK_HEADER_REGEX = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a git diff string into hunks
 */
export function parseDiff(
  diff: string,
  relativePath?: string,
): ParsedDiff | null {
  const lines = diff.split('\n');
  const headerLines: string[] = [];
  let filePath = relativePath || '';
  const hunks: Hunk[] = [];
  let currentHunk: { header: string; lines: string[] } | null = null;
  let inHunkSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hunkMatch = line.match(HUNK_HEADER_REGEX);

    if (hunkMatch) {
      inHunkSection = true;
      if (currentHunk) {
        hunks.push(createHunk(hunks.length, currentHunk));
      }
      const newStart = parseInt(hunkMatch[3], 10);
      const newCount = parseInt(hunkMatch[4] || '1', 10);
      currentHunk = {
        header: line,
        lines: [line],
      };
      (currentHunk as {
        newStart?: number;
        newCount?: number;
      }).newStart = newStart;
      (currentHunk as {
        newStart?: number;
        newCount?: number;
      }).newCount = newCount;
    } else if (currentHunk) {
      currentHunk.lines.push(line);
    } else if (!inHunkSection) {
      headerLines.push(line);
      if (line.startsWith('diff --git')) {
        const pathMatch = line.match(/diff --git a\/(.+?) b\//);
        if (pathMatch) {
          filePath = pathMatch[1];
        }
      }
    }
  }
  const header = headerLines.join('\n');

  if (currentHunk) {
    hunks.push(createHunk(hunks.length, currentHunk));
  }

  if (hunks.length === 0 && !diff.trim()) {
    return null;
  }

  return { header, filePath, hunks };
}

function createHunk(
  index: number,
  hunk: {
    header: string;
    lines: string[];
    newStart?: number;
    newCount?: number;
  },
): Hunk {
  const newStart = hunk.newStart ?? 1;
  const newCount = hunk.newCount ?? 1;
  return {
    index,
    header: hunk.header,
    content:
      hunk.lines.join('\n') +
      (hunk.lines[hunk.lines.length - 1] === '' ? '' : '\n'),
    newStart,
    newCount,
  };
}

/**
 * Build a full git patch from diff header + selected hunks
 */
export function buildPatch(header: string, hunks: Hunk[]): string {
  const parts = [header];
  for (const hunk of hunks) {
    parts.push(hunk.content);
  }
  return parts.join('\n') + '\n';
}
