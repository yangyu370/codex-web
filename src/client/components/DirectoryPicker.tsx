import { ArrowLeft, ChevronRight, Folder, HardDrive, Server, X } from "lucide-react";

import type { DirectoryListing } from "../../shared/protocol";

interface DirectoryPickerProps {
  listing?: DirectoryListing;
  loading: boolean;
  error?: string;
  onClose: () => void;
  onNavigate: (path?: string) => void;
  onSelect: (path: string) => void;
}

export function DirectoryPicker({
  listing,
  loading,
  error,
  onClose,
  onNavigate,
  onSelect,
}: DirectoryPickerProps) {
  return (
    <div className="directory-picker-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section
        aria-label="Choose a server directory"
        aria-modal="true"
        className="directory-picker"
        role="dialog"
      >
        <header className="directory-picker__header">
          <span className="directory-picker__host-icon"><Server size={17} /></span>
          <div>
            <h2>Choose a server folder</h2>
            <p>This path belongs to the machine running Codex.</p>
          </div>
          <button aria-label="Close directory browser" className="directory-picker__close" onClick={onClose} type="button">
            <X size={17} />
          </button>
        </header>

        {listing ? (
          <div className="directory-picker__roots" aria-label="Server roots">
            {listing.roots.map((root) => (
              <button
                data-active={root.path === listing.current.path}
                key={root.path}
                onClick={() => onNavigate(root.path)}
                type="button"
              >
                <HardDrive size={13} /> {root.name}
              </button>
            ))}
          </div>
        ) : null}

        <div className="directory-picker__location">
          <button
            aria-label="Go to parent directory"
            disabled={loading || !listing?.parent}
            onClick={() => onNavigate(listing?.parent)}
            type="button"
          >
            <ArrowLeft size={15} />
          </button>
          <code>{listing?.current.path ?? "Loading server folders…"}</code>
        </div>

        <div className="directory-picker__list" aria-busy={loading}>
          {error ? <p className="directory-picker__error" role="alert">{error}</p> : null}
          {loading ? <p className="directory-picker__empty">Loading folders…</p> : null}
          {!loading && !error && listing?.directories.length === 0 ? (
            <p className="directory-picker__empty">No child folders</p>
          ) : null}
          {!loading && !error ? listing?.directories.map((directory) => (
            <button key={directory.path} onClick={() => onNavigate(directory.path)} title={directory.path} type="button">
              <span><Folder size={16} /> {directory.name}</span>
              <ChevronRight size={15} />
            </button>
          )) : null}
        </div>

        <footer className="directory-picker__footer">
          <span>{listing?.truncated ? "Showing the first 200 folders" : "Folders on Codex host"}</span>
          <button className="directory-picker__cancel" onClick={onClose} type="button">Cancel</button>
          <button
            className="directory-picker__select"
            disabled={!listing || loading}
            onClick={() => listing && onSelect(listing.current.path)}
            type="button"
          >
            Use this folder
          </button>
        </footer>
      </section>
    </div>
  );
}
