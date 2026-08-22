export interface ParsedDiffLine {
  kind: "context" | "add" | "delete" | "meta";
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface ParsedDiffHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: ParsedDiffLine[];
}

export interface ParsedDiffFile {
  oldPath: string;
  newPath: string;
  kind: "add" | "modify" | "delete" | "rename";
  additions: number;
  deletions: number;
  hunks: ParsedDiffHunk[];
}

export interface ParsedDiff {
  files: ParsedDiffFile[];
  raw: string;
  parsed: boolean;
}

interface MutableFile {
  oldPath: string;
  newPath: string;
  renamed: boolean;
  additions: number;
  deletions: number;
  hunks: ParsedDiffHunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export function parseUnifiedDiff(source: string): ParsedDiff {
  const files: MutableFile[] = [];
  let file: MutableFile | undefined;
  let hunk: ParsedDiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;

  for (const line of source.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const paths = parseDiffGitPaths(line.slice("diff --git ".length));
      if (!paths) {
        file = undefined;
        hunk = undefined;
        continue;
      }
      file = {
        oldPath: stripGitPrefix(paths[0]),
        newPath: stripGitPrefix(paths[1]),
        renamed: false,
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      files.push(file);
      hunk = undefined;
      continue;
    }
    if (!file) continue;

    if (line.startsWith("rename from ")) {
      file.oldPath = decodePath(line.slice("rename from ".length));
      file.renamed = true;
      continue;
    }
    if (line.startsWith("rename to ")) {
      file.newPath = decodePath(line.slice("rename to ".length));
      file.renamed = true;
      continue;
    }
    if (line.startsWith("--- ")) {
      file.oldPath = parseHeaderPath(line.slice(4));
      hunk = undefined;
      continue;
    }
    if (line.startsWith("+++ ")) {
      file.newPath = parseHeaderPath(line.slice(4));
      hunk = undefined;
      continue;
    }
    if (line.startsWith("@@")) {
      const match = HUNK_HEADER.exec(line);
      if (!match) {
        hunk = undefined;
        continue;
      }
      oldLine = Number(match[1]);
      newLine = Number(match[3]);
      hunk = {
        header: (match[5] ?? "").trim(),
        oldStart: oldLine,
        oldCount: match[2] === undefined ? 1 : Number(match[2]),
        newStart: newLine,
        newCount: match[4] === undefined ? 1 : Number(match[4]),
        lines: [],
      };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;

    if (line.startsWith("\\ ")) {
      hunk.lines.push({ kind: "meta", text: line.slice(2) });
    } else if (line.startsWith("+")) {
      hunk.lines.push({ kind: "add", text: line.slice(1), newLine });
      newLine += 1;
      file.additions += 1;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ kind: "delete", text: line.slice(1), oldLine });
      oldLine += 1;
      file.deletions += 1;
    } else if (line.startsWith(" ")) {
      hunk.lines.push({ kind: "context", text: line.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }

  const parsedFiles = files
    .filter((entry) => entry.hunks.length > 0)
    .map((entry): ParsedDiffFile => ({
      oldPath: entry.oldPath,
      newPath: entry.newPath,
      kind: fileKind(entry),
      additions: entry.additions,
      deletions: entry.deletions,
      hunks: entry.hunks,
    }));
  if (parsedFiles.length === 0) {
    return { files: [], raw: source, parsed: false };
  }
  return { files: parsedFiles, raw: source, parsed: true };
}

function fileKind(file: MutableFile): ParsedDiffFile["kind"] {
  if (file.oldPath === "/dev/null") return "add";
  if (file.newPath === "/dev/null") return "delete";
  if (file.renamed || file.oldPath !== file.newPath) return "rename";
  return "modify";
}

function parseDiffGitPaths(source: string): [string, string] | undefined {
  const tokens = tokenizePaths(source);
  if (tokens.length < 2) return undefined;
  return [tokens[0] ?? "", tokens[1] ?? ""];
}

function tokenizePaths(source: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < source.length && tokens.length < 2) {
    while (source[index] === " ") index += 1;
    if (index >= source.length) break;
    if (source[index] === '"') {
      let token = "";
      index += 1;
      while (index < source.length) {
        const character = source[index] ?? "";
        index += 1;
        if (character === '"') break;
        if (character === "\\" && index < source.length) {
          token += decodeEscape(source[index] ?? "");
          index += 1;
        } else {
          token += character;
        }
      }
      tokens.push(token);
    } else {
      const start = index;
      while (index < source.length && source[index] !== " ") index += 1;
      tokens.push(source.slice(start, index));
    }
  }
  return tokens;
}

function parseHeaderPath(source: string): string {
  const path = source.startsWith('"')
    ? tokenizePaths(source)[0] ?? ""
    : source.split("\t", 1)[0] ?? "";
  return stripGitPrefix(path);
}

function decodePath(source: string): string {
  const trimmed = source.trim();
  return trimmed.startsWith('"') ? tokenizePaths(trimmed)[0] ?? "" : trimmed;
}

function decodeEscape(character: string): string {
  if (character === "n") return "\n";
  if (character === "r") return "\r";
  if (character === "t") return "\t";
  return character;
}

function stripGitPrefix(value: string): string {
  return value.startsWith("a/") || value.startsWith("b/") ? value.slice(2) : value;
}
