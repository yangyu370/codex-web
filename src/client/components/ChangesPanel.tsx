import { AlertTriangle, FileDiff, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { TurnDiffSummary, VisibleItem } from "../../shared/protocol";
import { parseUnifiedDiff } from "../diff";

interface ChangesPanelProps {
  turnDiff?: TurnDiffSummary;
  items: VisibleItem[];
}

export function ChangesPanel({ turnDiff, items }: ChangesPanelProps) {
  const fileItems = items.filter((item) => item.type === "fileChange");
  const source = turnDiff?.diff ?? fileItems.flatMap((item) =>
    item.changes?.map((change) => change.diff) ?? (item.diff ? [item.diff] : []),
  ).filter(Boolean).join("\n");
  const parsed = useMemo(() => source ? parseUnifiedDiff(source) : undefined, [source]);
  const [selectedPath, setSelectedPath] = useState<string>();
  const selected = parsed?.files.find((file) => displayPath(file) === selectedPath)
    ?? parsed?.files[0];

  useEffect(() => {
    if (parsed?.files.length && !parsed.files.some((file) => displayPath(file) === selectedPath)) {
      setSelectedPath(displayPath(parsed.files[0]!));
    }
  }, [parsed, selectedPath]);

  if (!source) {
    const failed = fileItems.some((item) => item.status === "failed");
    const running = fileItems.some((item) => item.status === "running");
    return (
      <div className="changes-state">
        {running ? <LoaderCircle className="spin" size={18} /> : failed ? <AlertTriangle size={18} /> : <FileDiff size={18} />}
        <strong>{running ? "Changes are still being collected" : failed ? "The file change could not be loaded" : "No changes to inspect"}</strong>
        <p>{running ? "The diff will appear when Codex reports it." : failed ? "Check Activity for the originating error." : "Run a task or request a review to populate this panel."}</p>
      </div>
    );
  }

  if (!parsed?.parsed || !selected) {
    return (
      <div className="changes-raw">
        <span className="changes-raw__label">Raw diff</span>
        <pre>{source}</pre>
      </div>
    );
  }

  return (
    <div className="changes-viewer">
      {turnDiff?.truncated || fileItems.some((item) => item.truncated || item.changes?.some((change) => change.truncated)) ? (
        <div className="changes-warning"><AlertTriangle size={13} /> Diff truncated</div>
      ) : null}
      <div className="changes-file-list" aria-label="Changed files">
        {parsed.files.map((file) => {
          const path = displayPath(file);
          return (
            <button
              aria-label={`${path}, ${file.additions} additions, ${file.deletions} deletions`}
              aria-selected={path === displayPath(selected)}
              key={`${file.oldPath}:${file.newPath}`}
              onClick={() => setSelectedPath(path)}
              type="button"
            >
              <span>{path}</span>
              <small aria-label={`${file.additions} addition${file.additions === 1 ? "" : "s"}, ${file.deletions} deletion${file.deletions === 1 ? "" : "s"}`}>
                <b>+{file.additions}</b><i>−{file.deletions}</i>
              </small>
            </button>
          );
        })}
      </div>
      <div className="diff-document">
        <div className="diff-document__title">
          <FileDiff size={14} /> <code>{displayPath(selected)}</code>
          <span>{selected.kind}</span>
        </div>
        {selected.hunks.map((hunk, hunkIndex) => (
          <section className="diff-hunk" key={`${hunk.oldStart}:${hunk.newStart}:${hunkIndex}`}>
            <div className="diff-hunk__header">@@ −{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@ {hunk.header}</div>
            {hunk.lines.map((line, lineIndex) => (
              <div className={`diff-line diff-line--${line.kind}`} key={lineIndex}>
                <span>{line.oldLine ?? ""}</span>
                <span>{line.newLine ?? ""}</span>
                <code><b aria-hidden="true">{line.kind === "add" ? "+" : line.kind === "delete" ? "−" : " "}</b>{line.text}</code>
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

function displayPath(file: { oldPath: string; newPath: string }): string {
  return file.newPath === "/dev/null" ? file.oldPath : file.newPath;
}
