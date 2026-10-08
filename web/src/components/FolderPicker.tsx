import { useCallback, useEffect, useRef, useState } from "react";
import { Clock, CornerLeftUp, Eye, EyeOff, Folder, FolderPlus, GitBranch, House, LoaderCircle, X } from "lucide-react";
import type { FolderListing } from "../../../shared/protocol.ts";
import { recentFolders, rememberFolder } from "../recentFolders.ts";
import { api, useStore } from "../store.ts";
import { basename, Button, IconButton } from "./ui.tsx";

/** Breadcrumbs, with the home folder shown as "~". */
function crumbs(path: string, home: string): { label: string; path: string }[] {
  const underHome = path === home || path.startsWith(`${home}/`);
  const base = underHome ? home : "";
  const parts = path.slice(base.length).split("/").filter(Boolean);
  const out = [{ label: underHome ? "~" : "/", path: underHome ? home : "/" }];
  let current = base;
  for (const part of parts) {
    current = `${current}/${part}`;
    out.push({ label: part, path: current });
  }
  return out;
}

export function FolderPicker({
  initialPath,
  initialShowHidden = false,
  recents = true,
  onSelect,
  onClose,
}: {
  initialPath: string;
  initialShowHidden?: boolean;
  /** Offer and remember recently used working folders. */
  recents?: boolean;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const store = useStore();
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [pathInput, setPathInput] = useState(initialPath);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showHidden, setShowHidden] = useState(initialShowHidden);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [nativeBusy, setNativeBusy] = useState(false);
  const [active, setActive] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);
  const recent = recents ? recentFolders() : [];

  const open = useCallback(
    async (path?: string, hidden = showHidden) => {
      setLoading(true);
      setError("");
      try {
        const next = await api.listFolder(path, hidden);
        setListing(next);
        setPathInput(next.path);
        setActive(-1);
        listRef.current?.scrollTo({ top: 0 });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [showHidden],
  );

  useEffect(() => {
    // Fall back to the default folder if the starting path doesn't exist.
    void api.listFolder(initialPath || undefined, showHidden).then(
      (first) => {
        setListing(first);
        setPathInput(first.path);
      },
      () => void open(),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const choose = (path: string) => {
    if (recents) rememberFolder(path);
    onSelect(path);
  };

  const create = async () => {
    if (!listing || !newName.trim()) return;
    try {
      const { path } = await api.createFolder(listing.path, newName);
      setCreating(false);
      setNewName("");
      await open(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const pickNatively = async () => {
    setNativeBusy(true);
    setError("");
    try {
      const result = await api.pickFolderNatively(listing?.path);
      if (result.path) choose(result.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setNativeBusy(false);
    }
  };

  const entries = listing?.entries ?? [];

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLButtonElement) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.max(0, Math.min(entries.length - 1, active + (e.key === "ArrowDown" ? 1 : -1)));
      setActive(next);
      listRef.current?.children[next]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && entries[active]) {
      e.preventDefault();
      void open(entries[active].path);
    } else if (e.key === "Backspace" && listing?.parent) {
      e.preventDefault();
      void open(listing.parent);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal folder-picker" role="dialog" aria-label="Choose a folder" onKeyDown={onListKey}>
        <div className="modal-head">
          <div>
            <h2>Choose a folder</h2>
            <div className="muted small">{store.server?.localOnly ? "On this computer" : "On the server running Teamlet"}</div>
          </div>
          <IconButton icon={X} label="Close" onClick={onClose} />
        </div>

        <form
          className="path-bar"
          onSubmit={(e) => {
            e.preventDefault();
            void open(pathInput);
          }}
        >
          <IconButton icon={CornerLeftUp} label="Up one level" type="button" disabled={!listing?.parent} onClick={() => listing?.parent && void open(listing.parent)} />
          <IconButton icon={House} label="Home" type="button" onClick={() => void open(listing?.home)} />
          <IconButton
            icon={showHidden ? EyeOff : Eye}
            label={showHidden ? "Hide hidden folders" : "Show hidden folders"}
            type="button"
            className={showHidden ? "toggled" : ""}
            onClick={() => {
              setShowHidden(!showHidden);
              void open(listing?.path, !showHidden);
            }}
          />
          <span className="input-wrap grow">
            <input value={pathInput} onChange={(e) => setPathInput(e.target.value)} spellCheck={false} aria-label="Folder path" />
            {loading && <LoaderCircle size={14} className="spin input-icon" />}
          </span>
        </form>

        {listing && (
          <nav className="crumbs" aria-label="Current folder">
            {crumbs(listing.path, listing.home).map((crumb, index, all) => (
              <span key={crumb.path} className="crumb">
                {index > 0 && all[0].label !== "/" ? <span className="crumb-sep">/</span> : index > 1 && <span className="crumb-sep">/</span>}
                <button disabled={index === all.length - 1} onClick={() => void open(crumb.path)}>
                  {crumb.label}
                </button>
              </span>
            ))}
          </nav>
        )}

        {recent.length > 0 && (
          <div className="recent-row">
            <Clock size={13} className="muted" />
            {recent.map((path) => (
              <button key={path} className="recent-chip" title={path} onClick={() => void open(path)}>
                {basename(path)}
              </button>
            ))}
          </div>
        )}

        <div className="folder-list" ref={listRef} role="listbox" tabIndex={0} aria-label="Subfolders">
          {creating && (
            <form
              className="folder-row new"
              onSubmit={(e) => {
                e.preventDefault();
                void create();
              }}
            >
              <FolderPlus size={16} />
              <input
                autoFocus
                placeholder="New folder name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setCreating(false))}
              />
              <Button size="sm" variant="primary" type="submit" disabled={!newName.trim()}>
                Create
              </Button>
            </form>
          )}
          {entries.map((entry, index) => (
            <div
              key={entry.path}
              role="option"
              aria-selected={index === active}
              className={`folder-row ${index === active ? "active" : ""}`}
              onClick={() => void open(entry.path)}
              onMouseEnter={() => setActive(index)}
            >
              <Folder size={16} className="folder-icon" />
              <span className="folder-name">{entry.name}</span>
              {entry.git && (
                <span className="git-badge" title="Git repository">
                  <GitBranch size={11} /> git
                </span>
              )}
              <button
                className="row-select"
                onClick={(e) => {
                  e.stopPropagation();
                  choose(entry.path);
                }}
              >
                Select
              </button>
            </div>
          ))}
          {listing && !entries.length && !creating && <div className="folder-empty">No subfolders here.</div>}
          {listing?.truncated && <div className="folder-empty">Showing the first {entries.length} folders. Type a path to go further.</div>}
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className="folder-foot">
          <Button variant="ghost" size="sm" icon={FolderPlus} onClick={() => setCreating(true)} disabled={!listing}>
            New folder
          </Button>
          {store.server?.nativeFolderPicker && (
            <Button variant="ghost" size="sm" onClick={() => void pickNatively()} disabled={nativeBusy}>
              {nativeBusy ? "Waiting for Finder…" : "Choose in Finder…"}
            </Button>
          )}
          <span className="grow" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!listing} onClick={() => listing && choose(listing.path)}>
            Use “{listing ? basename(listing.path) : "…"}”
          </Button>
        </div>
      </div>
    </div>
  );
}
