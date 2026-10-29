import { useEffect, useRef, useState } from "react";
import { ArrowLeftIcon, ChevronRightIcon, FileCodeIcon, FolderIcon, GitCompareArrowsIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { request } from "../api";
import type { Project } from "../types";
import { Button } from "./ui/button";
import { CopyButton } from "./MessageBody";

type Entry = { name: string; path: string; type?: string; kind?: string; isDirectory?: boolean };
const isDirectory = (entry: Entry) => entry.type === "directory" || entry.kind === "directory" || Boolean(entry.isDirectory);

export function FilePanel({ token, project, root, close }: { token: string; project: Project; root: string; close: () => void }) {
  const [tab, setTab] = useState<"files" | "diff">("files");
  const [selectedRoot, setSelectedRoot] = useState(root);
  const [directory, setDirectory] = useState(root);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [selectedFile, setSelectedFile] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const fileRequest = useRef<AbortController | null>(null);
  useEffect(() => () => fileRequest.current?.abort(), [project.id, selectedRoot, directory, tab]);

  // The pane follows the selected project/root and reads local data while open.
  useEffect(() => { setSelectedRoot(root); setDirectory(root); setSelectedFile(""); setText(""); }, [project.id, root]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setTruncated(false);
    const query = new URLSearchParams({ projectId: project.id, root: selectedRoot });
    if (tab === "files") query.set("path", directory);
    const url = tab === "diff" ? `/api/diff?${query}` : `/api/files?${query}`;
    request<{ entries?: Entry[]; files?: Entry[]; diff?: string; truncated?: boolean }>(token, url, "GET", undefined, controller.signal).then(value => {
      if (tab === "files") { setEntries(value.entries || value.files || []); setTruncated(Boolean(value.truncated)); }
      else { setText(value.diff || ""); setTruncated(Boolean(value.truncated)); }
    }).catch(reason => { if (!controller.signal.aborted) setError(reason.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token, project.id, selectedRoot, directory, tab, revision]);

  async function openEntry(entry: Entry) {
    const path = entry.path || `${directory.replace(/\/$/, "")}/${entry.name}`;
    if (isDirectory(entry)) { setDirectory(path); setSelectedFile(""); setText(""); return; }
    fileRequest.current?.abort();
    const controller = new AbortController(); fileRequest.current = controller;
    setLoading(true); setError("");
    try {
      const result = await request<{ path: string; text: string; truncated?: boolean }>(token, `/api/file?${new URLSearchParams({ projectId: project.id, path })}`, "GET", undefined, controller.signal);
      if (controller.signal.aborted) return;
      setSelectedFile(result.path || path); setText(result.text); setTruncated(Boolean(result.truncated));
    } catch (reason) { if (!controller.signal.aborted) setError((reason as Error).message); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }

  return <aside className="file-panel" aria-label="Local files and changes"><header className="file-panel-header"><div className="panel-tabs" role="tablist" aria-label="Workspace view"><button role="tab" aria-selected={tab === "files"} onClick={() => { setTab("files"); setText(""); }}><FileCodeIcon />Files</button><button role="tab" aria-selected={tab === "diff"} onClick={() => { setTab("diff"); setSelectedFile(""); }}><GitCompareArrowsIcon />Changes</button></div><Button size="icon-xs" variant="ghost-muted" aria-label="Close files panel" onClick={close}><XIcon /></Button></header>
    {project.roots.length > 1 && <label className="root-picker"><span>Root</span><select value={selectedRoot} onChange={event => { setSelectedRoot(event.target.value); setDirectory(event.target.value); setSelectedFile(""); setText(""); }}>{project.roots.map(path => <option value={path} key={path}>{path}</option>)}</select></label>}
    <div className="file-pathbar">{tab === "files" && directory !== selectedRoot && <Button variant="ghost-muted" size="icon-xs" aria-label="Parent directory" onClick={() => { const parent = directory.replace(/\/[^/]+\/?$/, "") || "/"; setDirectory(parent.length >= selectedRoot.length ? parent : selectedRoot); setSelectedFile(""); }}><ArrowLeftIcon /></Button>}<span title={selectedFile || directory}>{selectedFile ? selectedFile.slice(selectedRoot.length + 1) : directory === selectedRoot ? project.name : directory.slice(selectedRoot.length + 1)}</span><Button variant="ghost-muted" size="icon-xs" aria-label="Refresh workspace view" onClick={() => { if (selectedFile && tab === "files") void openEntry({ name: selectedFile, path: selectedFile }); else setRevision(value => value + 1); }}><RefreshCwIcon /></Button></div>
    {error && <div className="panel-error" role="alert">{error}<Button variant="outline" size="sm" onClick={() => setRevision(value => value + 1)}>Retry</Button></div>}
    {loading && <p className="panel-note" role="status">Loading local files…</p>}
    {tab === "files" && !selectedFile && <div className="file-list">{entries.map(entry => <button key={entry.path || entry.name} onClick={() => void openEntry(entry)}>{isDirectory(entry) ? <FolderIcon /> : <FileCodeIcon />}<span>{entry.name}</span>{isDirectory(entry) && <ChevronRightIcon />}</button>)}{truncated && <p className="panel-note">Partial listing — this directory exceeds the local entry limit.</p>}{!loading && !error && !entries.length && <p className="panel-note">This directory is empty.</p>}</div>}
    {(selectedFile || tab === "diff") && <div className="file-content">{text && <div className="file-content-actions"><CopyButton text={text} label={tab === "diff" ? "Copy diff" : "Copy file"} />{selectedFile && <Button size="xs" variant="ghost-muted" onClick={() => { setSelectedFile(""); setText(""); }}>Back to files</Button>}</div>}{truncated && <p className="panel-note">Partial preview — content exceeds the local viewing limit.</p>}{tab === "diff" ? text ? <pre className="diff-text">{text.split("\n").map((line, i) => <span key={i} className={line.startsWith("+") && !line.startsWith("+++") ? "diff-added" : line.startsWith("-") && !line.startsWith("---") ? "diff-removed" : line.startsWith("@@") ? "diff-hunk" : ""}>{line}</span>)}</pre> : !loading && !error && <div className="clean-workspace"><GitCompareArrowsIcon /><strong>No local changes</strong><span>Working tree changes appear here.</span></div> : <pre className="source-text"><code>{text}</code></pre>}</div>}
  </aside>;
}
