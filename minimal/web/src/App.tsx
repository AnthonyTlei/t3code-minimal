import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArchiveIcon, ArrowUpIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, CircleAlertIcon, CircleCheckIcon, CircleDotIcon, FileCodeIcon, FolderIcon, FolderPlusIcon, GitBranchIcon, MenuIcon, MessageSquareIcon, MoonIcon, PlusIcon, SearchIcon, SettingsIcon, ShieldCheckIcon, SquareIcon, SquarePenIcon, SunIcon, XIcon } from "lucide-react";
import { ApiError, events, initialToken, request, saveToken } from "./api";
import type { Capabilities, Chat, Project, Snapshot } from "./types";
import { T3Wordmark } from "./components/T3Wordmark";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { Badge } from "./components/ui/badge";
import { Kbd } from "./components/ui/kbd";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogDescription, DialogPanel, DialogFooter } from "./components/ui/dialog";
import { MessageBody, CopyButton } from "./components/MessageBody";
import { PendingRequests } from "./components/PendingRequests";
import { FilePanel } from "./components/FilePanel";

const empty: Snapshot = { projects: [], chats: [], roots: [], settings: { theme: "system" } };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "The local request failed.";
const working = (chat?: Chat) => Boolean(chat && ["starting", "running", "streaming", "cancelling", "waiting", "awaiting_approval", "awaiting_input"].includes(chat.status));

function statusLabel(chat: Chat) {
  if (chat.pendingRequests?.length) return "Needs your input";
  const labels: Record<string, string> = { starting: "Starting", running: "Working", streaming: "Working", cancelling: "Cancelling", idle: "Ready", completed: "Done", cancelled: "Stopped", interrupted: "Interrupted", error: "Error", failed: "Error" };
  return labels[chat.status] || chat.status || "Ready";
}

function StatusGlyph({ chat }: { chat: Chat }) {
  return chat.pendingRequests?.length || ["error", "failed"].includes(chat.status) ? <CircleAlertIcon className="status-attention" /> : working(chat) ? <CircleDotIcon className="status-working" /> : <CircleCheckIcon className="status-idle" />;
}

function RootChoice({ roots, value, onChange, label = "Working directory" }: { roots: string[]; value: string; onChange: (value: string) => void; label?: string }) {
  return <label className="field-label">{label}<select value={value} onChange={event => onChange(event.target.value)} required>{roots.map(root => <option key={root} value={root}>{root}</option>)}</select></label>;
}

export function App() {
  const [token, setToken] = useState(initialToken);
  const [tokenDraft, setTokenDraft] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot>(empty);
  const [selectedChatId, setSelectedChatId] = useState(() => sessionStorage.getItem("t3-minimal-selected-chat") || "");
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [connection, setConnection] = useState<"connecting" | "connected" | "disconnected">("connecting");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [dialog, setDialog] = useState<"project" | "chat" | "settings" | "rename" | "worktree" | null>(null);
  const [name, setName] = useState("");
  const [projectRoots, setProjectRoots] = useState<string[]>([]);
  const [chatRoot, setChatRoot] = useState("");
  const [worktreeBranch, setWorktreeBranch] = useState("");
  const [prompt, setPrompt] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [capabilitiesLoading, setCapabilitiesLoading] = useState(false);
  const [capabilitiesError, setCapabilitiesError] = useState("");
  const [capabilitiesVisible, setCapabilitiesVisible] = useState(false);
  const timeline = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const chat = snapshot.chats.find(item => item.id === selectedChatId);
  const project = snapshot.projects.find(item => item.id === (chat?.projectId || selectedProjectId)) || snapshot.projects[0];
  const root = chat?.workspaceRoot || project?.roots[0] || "";
  const dialogProject = snapshot.projects.find(item => item.id === selectedProjectId) || project;

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const value = await request<Snapshot>(token, "/api/bootstrap", "GET", undefined, signal);
    if (!signal?.aborted) setSnapshot({ ...empty, ...value });
    return value;
  }, [token]);

  const handleError = useCallback((reason: unknown) => {
    setError(errorMessage(reason));
    if (reason instanceof ApiError && reason.status === 401) { saveToken(""); setToken(""); setSnapshot(empty); }
  }, []);

  // Keep the local snapshot synchronized with authenticated server events.
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      setConnection("connecting");
      try {
        await refresh(controller.signal);
        if (controller.signal.aborted) return;
        setConnection("connected"); setError("");
        await events(token, controller.signal, event => {
          const value = event as Partial<Snapshot> & { type?: string; snapshot?: Snapshot; chat?: Chat };
          if (value.type === "snapshot") setSnapshot({ ...empty, ...(value.snapshot || value as Snapshot) });
          else if (value.type === "chat" && value.chat) setSnapshot(current => ({ ...current, chats: current.chats.some(chat => chat.id === value.chat!.id) ? current.chats.map(chat => chat.id === value.chat!.id ? value.chat! : chat) : [...current.chats, value.chat!] }));
        });
      } catch (reason) {
        if (controller.signal.aborted) return;
        setConnection("disconnected");
        if (reason instanceof ApiError && reason.status === 401) handleError(reason);
        else { setError(errorMessage(reason)); reconnect = setTimeout(() => void connect(), 2000); }
      }
    };
    void connect();
    return () => { controller.abort(); if (reconnect) clearTimeout(reconnect); };
  }, [token, refresh, handleError]);

  // Theme is a local preference; system changes are reflected while selected.
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.classList.toggle("dark", snapshot.settings.theme === "dark" || snapshot.settings.theme === "system" && media.matches);
    apply(); media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [snapshot.settings.theme]);

  // Focus and drafts belong to the selected conversation rather than a streamed snapshot.
  useEffect(() => {
    setPrompt(drafts[selectedChatId] || "");
    setCapabilities(null); setCapabilitiesError(""); setCapabilitiesVisible(false);
    if (selectedChatId) sessionStorage.setItem("t3-minimal-selected-chat", selectedChatId);
  }, [selectedChatId]);

  // Follow streaming output only while the reader is already near the end.
  useEffect(() => {
    const element = timeline.current;
    if (element && element.scrollHeight - element.scrollTop - element.clientHeight < 240) element.scrollTop = element.scrollHeight;
  }, [chat?.messages]);

  const selectChat = useCallback((value: Chat) => { setSelectedChatId(value.id); setSelectedProjectId(value.projectId); setSidebarOpen(false); }, []);

  function openNewChat(target: Project = project) {
    if (!target) { setName(""); setProjectRoots([]); setDialog("project"); return; }
    setSelectedProjectId(target.id); setName(""); setChatRoot(target.roots[0] || ""); setDialog("chat");
  }

  // Keyboard commands act on the same controls as their visible counterparts.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") { event.preventDefault(); openNewChat(); }
      if ((event.metaKey || event.ctrlKey) && event.key === ",") { event.preventDefault(); setDialog("settings"); }
      if (event.key === "Escape") setSidebarOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [project]);

  async function mutate(path: string, method: string, body: unknown) {
    setBusy(true); setError("");
    try { const value = await request<unknown>(token, path, method, body); await refresh(); return value; }
    catch (reason) { handleError(reason); throw reason; }
    finally { setBusy(false); }
  }

  async function submitDialog(event: FormEvent) {
    event.preventDefault();
    try {
      if (dialog === "project") {
        const value = await mutate("/api/projects", "POST", { name: name.trim(), roots: projectRoots }) as { id?: string; project?: Project };
        setSelectedProjectId(value.project?.id || value.id || ""); setSelectedChatId("");
      } else if (dialog === "chat" && dialogProject) {
        const value = await mutate("/api/chats", "POST", { projectId: dialogProject.id, title: name.trim() || "New chat", workspaceRoot: chatRoot }) as Chat & { chat?: Chat };
        const created = value.chat || value;
        if (!created.id) throw new Error("The server did not return the new chat.");
        selectChat(created);
      } else if (dialog === "rename" && chat) await mutate(`/api/chats/${encodeURIComponent(chat.id)}`, "PATCH", { title: name.trim() });
      else if (dialog === "worktree" && dialogProject) {
        const value = await mutate("/api/worktrees", "POST", { projectId: dialogProject.id, root: chatRoot, destination: name.trim(), ...(worktreeBranch.trim() ? { branch: worktreeBranch.trim() } : {}) }) as { project: Project };
        setSelectedProjectId(value.project.id); setSelectedChatId(""); setFilesOpen(false);
      }
      setDialog(null);
    } catch (reason) { handleError(reason); }
  }

  async function send(event?: FormEvent) {
    event?.preventDefault();
    if (!chat || !prompt.trim() || busy || working(chat) || chat.archived) return;
    const text = prompt.trim();
    try {
      await mutate(`/api/chats/${encodeURIComponent(chat.id)}/messages`, "POST", { text, ...(chat.model ? { model: chat.model } : {}), ...(chat.reasoning ? { reasoning: chat.reasoning } : {}) });
      setPrompt(""); setDrafts(current => ({ ...current, [chat.id]: "" }));
    } catch { /* Preserve the draft on failure. */ }
  }

  async function loadCapabilities() {
    if (!chat) return;
    setCapabilitiesVisible(true); setCapabilitiesLoading(true); setCapabilitiesError("");
    try { setCapabilities(await request<Capabilities>(token, `/api/capabilities?${new URLSearchParams({ chatId: chat.id })}`)); }
    catch (reason) { setCapabilitiesError(errorMessage(reason)); }
    finally { setCapabilitiesLoading(false); }
  }

  if (!token) return <main className="auth-page"><div className="auth-card"><div className="brand"><T3Wordmark aria-label="T3" /><span>Code</span><Badge variant="outline" size="sm">Local</Badge></div><h1>Your workspace, on this machine.</h1><p>Enter the local access token shown by the server launcher.</p><form onSubmit={event => { event.preventDefault(); const value = tokenDraft.trim(); if (value) { saveToken(value); setToken(value); setTokenDraft(""); } }}><label className="field-label">Access token<Input type="password" autoComplete="off" spellCheck={false} value={tokenDraft} onChange={event => setTokenDraft(event.target.value)} autoFocus /></label><Button type="submit" disabled={!tokenDraft.trim()}>Connect locally</Button></form>{error && <p role="alert" className="error-text">{error}</p>}<div className="auth-note"><ShieldCheckIcon /><span>Stored in this tab’s session. No additional account.</span></div></div></main>;

  const filteredChats = snapshot.chats.filter(item => Boolean(item.archived) === showArchived && item.title.toLowerCase().includes(search.toLowerCase()));
  const selectedModel = capabilities?.models.find(model => model.id === chat?.model);

  return <div className="app-shell">
    {sidebarOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}
    <aside className={`app-sidebar ${sidebarOpen ? "is-open" : ""}`} aria-label="Projects and chats">
      <header className="sidebar-header"><div className="brand"><T3Wordmark aria-label="T3" /><span>Code</span><Badge variant="outline" size="sm">Local</Badge></div><Button size="icon-xs" variant="ghost-muted" aria-label="New project" title="New project" onClick={() => { setName(""); setProjectRoots([]); setDialog("project"); }}><FolderPlusIcon /></Button></header>
      <div className="sidebar-actions"><Button variant="outline" size="sm" onClick={() => openNewChat()}><SquarePenIcon />New chat<span className="shortcut-hint"><Kbd>⌘ N</Kbd></span></Button><div className="search-control"><SearchIcon /><input aria-label="Search chats" placeholder="Search chats…" value={search} onChange={event => setSearch(event.target.value)} /></div></div>
      <nav className="project-list">{snapshot.projects.map(item => <section className="project-group" key={item.id}><div className="project-heading"><button aria-expanded={!collapsed[item.id]} onClick={() => { setSelectedProjectId(item.id); setCollapsed(current => ({ ...current, [item.id]: !current[item.id] })); }}><FolderIcon /><span>{item.name}</span>{collapsed[item.id] ? <ChevronRightIcon /> : <ChevronDownIcon />}</button><Button size="icon-xs" variant="ghost-muted" aria-label={`New chat in ${item.name}`} onClick={() => openNewChat(item)}><PlusIcon /></Button></div>{!collapsed[item.id] && <div className="thread-list">{filteredChats.filter(itemChat => itemChat.projectId === item.id).map(itemChat => <button key={itemChat.id} className={`thread-row ${chat?.id === itemChat.id ? "selected" : ""}`} aria-current={chat?.id === itemChat.id ? "page" : undefined} onClick={() => selectChat(itemChat)}><StatusGlyph chat={itemChat} /><span>{itemChat.title}</span>{working(itemChat) && <small>Working</small>}{itemChat.pendingRequests?.length > 0 && <span className="attention-dot" aria-label="Needs input" />}</button>)}{!filteredChats.some(itemChat => itemChat.projectId === item.id) && <p className="empty-project">{showArchived ? "No archived chats" : "No chats yet"}</p>}</div>}</section>)}{!snapshot.projects.length && <div className="sidebar-empty"><FolderIcon /><p>Add a project to get started.</p></div>}</nav>
      <footer className="sidebar-footer"><button className={showArchived ? "active" : ""} onClick={() => setShowArchived(value => !value)}><ArchiveIcon /><span>{showArchived ? "Back to active chats" : "Archived chats"}</span></button><button onClick={() => setDialog("settings")}><SettingsIcon /><span>Settings</span></button><div className="connection-status"><span className={`connection-dot ${connection}`} /><span>{connection === "connected" ? "Connected locally" : connection === "connecting" ? "Connecting…" : "Reconnecting…"}</span></div></footer>
    </aside>
    <main className="workspace"><header className="workspace-header"><Button className="mobile-menu" variant="ghost-muted" size="icon-sm" aria-label="Open navigation" onClick={() => setSidebarOpen(true)}><MenuIcon /></Button><div className="workspace-breadcrumb"><span>{project?.name || "Workspace"}</span>{chat && <><ChevronRightIcon /><button onClick={() => { setName(chat.title); setDialog("rename"); }} title="Rename chat">{chat.title}</button></>}</div><div className="workspace-header-actions">{chat && <><Button variant="ghost-muted" size="icon-sm" aria-label="Rename chat" title="Rename chat" disabled={busy} onClick={() => { setName(chat.title); setDialog("rename"); }}><SquarePenIcon /></Button><Button variant="ghost-muted" size="icon-sm" aria-label={chat.archived ? "Unarchive chat" : "Archive chat"} title={chat.archived ? "Unarchive chat" : "Archive chat"} disabled={busy || working(chat)} onClick={() => void mutate(`/api/chats/${encodeURIComponent(chat.id)}`, "PATCH", { archived: !chat.archived }).catch(() => {})}><ArchiveIcon /></Button></>}{project && <><Button variant="ghost-muted" size="icon-sm" aria-label="Create worktree" title="Create worktree" onClick={() => { setName(""); setSelectedProjectId(project.id); setChatRoot(root); setWorktreeBranch(""); setDialog("worktree"); }}><GitBranchIcon /></Button><Button variant={filesOpen ? "secondary" : "ghost-muted"} size="icon-sm" aria-label="Toggle local files and changes" title="Files and changes" onClick={() => setFilesOpen(value => !value)}><FileCodeIcon /></Button></>}</div></header>
      {error && <div className="error-banner" role="alert"><CircleAlertIcon /><span>{error}</span><Button variant="ghost-muted" size="icon-xs" aria-label="Dismiss error" onClick={() => setError("")}><XIcon /></Button></div>}
      <div className="workspace-body"><section className="chat-column">{chat ? <>
        <div className="timeline" ref={timeline} aria-label="Chat messages"><div className="timeline-inner">{!chat.messages?.length && <div className="chat-empty"><MessageSquareIcon /><h1>What are we working on?</h1><p>Ask Codex to explore, explain, or change this workspace.</p><div className="workspace-root-label"><FolderIcon /><span>{root}</span></div></div>}{chat.messages?.map(message => <article key={message.id} className={`message message-${message.role} ${message.kind && message.kind !== "text" ? "message-activity" : ""}`} aria-label={`${message.role} message`}><div className="message-meta"><span>{message.role === "assistant" ? "Codex" : message.role === "user" ? "You" : "Activity"}</span>{message.kind && message.kind !== "text" && <Badge size="sm" variant="secondary">{message.kind.replaceAll("_", " ")}</Badge>}<CopyButton text={message.text} label="Copy message" /></div><MessageBody text={message.text} /></article>)}
          {chat.error && <p className="chat-error" role="alert">{chat.error}</p>}
          <PendingRequests requests={chat.pendingRequests || []} disabled={busy || connection !== "connected"} respond={(requestId, result) => void mutate(`/api/chats/${encodeURIComponent(chat.id)}/responses`, "POST", { requestId, result }).catch(() => {})} />
          {working(chat) && <div className="turn-status" role="status"><StatusGlyph chat={chat} /><span>{statusLabel(chat)}</span><span className="turn-status-rule" /></div>}
        </div></div>
        <div className="composer-area">{chat.archived ? <div className="archived-notice"><ArchiveIcon /><span>This chat is archived.</span><Button size="sm" variant="outline" onClick={() => void mutate(`/api/chats/${encodeURIComponent(chat.id)}`, "PATCH", { archived: false }).catch(() => {})}>Unarchive</Button></div> : <form className="composer" onSubmit={event => void send(event)}><Textarea ref={composer} unstyled aria-label="Message Codex" placeholder="Ask anything, or describe a change…" value={prompt} disabled={connection !== "connected"} onChange={event => { const value = event.target.value; setPrompt(value); setDrafts(current => ({ ...current, [chat.id]: value })); }} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} /><div className="composer-toolbar"><button type="button" className="model-trigger" onClick={() => { if (capabilitiesVisible) setCapabilitiesVisible(false); else void loadCapabilities(); }} disabled={busy || working(chat)} aria-expanded={capabilitiesVisible}>{chat.model || "CLI default"}<ChevronDownIcon />{chat.reasoning && <span>· {chat.reasoning}</span>}</button><div className="composer-send-group">{working(chat) ? <Button variant="outline" size="icon-sm" aria-label="Stop response" title="Stop response" disabled={busy || chat.status === "cancelling"} onClick={() => void mutate(`/api/chats/${encodeURIComponent(chat.id)}/cancel`, "POST", {}).catch(() => {})}><SquareIcon /></Button> : <Button type="submit" size="icon-sm" aria-label="Send message" title="Send message" disabled={busy || !prompt.trim() || connection !== "connected"}><ArrowUpIcon /></Button>}</div></div>{capabilitiesVisible && <div className="model-controls">{capabilitiesLoading ? <p role="status">Reading permitted CLI capabilities…</p> : capabilitiesError ? <p role="alert">{capabilitiesError}<Button size="xs" variant="outline" onClick={() => void loadCapabilities()}>Retry</Button></p> : capabilities && <><label>Model<select aria-label="Model" value={chat.model || ""} onChange={event => void mutate(`/api/chats/${encodeURIComponent(chat.id)}`, "PATCH", { model: event.target.value || null, reasoning: null }).catch(() => {})}><option value="">CLI default</option>{capabilities.models.map(model => <option value={model.id} key={model.id}>{model.name || model.id}</option>)}</select></label><label>Reasoning<select aria-label="Reasoning" disabled={!selectedModel} value={chat.reasoning || ""} onChange={event => void mutate(`/api/chats/${encodeURIComponent(chat.id)}`, "PATCH", { reasoning: event.target.value || null }).catch(() => {})}><option value="">CLI default</option>{selectedModel?.reasoning?.map(reasoning => <option key={reasoning.effort} value={reasoning.effort}>{reasoning.effort}</option>)}</select></label><p>Choices come from the installed CLI. Enterprise controls remain in effect.</p></>}</div>}</form>}<div className="composer-footnote"><span title={root}><FolderIcon />{root.split("/").filter(Boolean).slice(-1)[0] || "Workspace"}</span><span>{chat.pendingRequests?.length ? "Needs your input" : statusLabel(chat)}<span className="keyboard-hint"> · Shift Enter for a new line</span></span></div></div>
      </> : <div className="welcome"><div className="welcome-mark"><T3Wordmark aria-hidden /></div><span className="welcome-eyebrow">YOUR LOCAL WORKSPACE</span><h1>Make room for good work.</h1><p>Projects, conversations, and code.<br />Local history. Your approved Codex workflow.</p><div className="welcome-actions"><Button onClick={() => openNewChat()}><SquarePenIcon />{project ? "Start a chat" : "Add your first project"}</Button>{project && <Button variant="outline" onClick={() => { setName(""); setProjectRoots([]); setDialog("project"); }}><FolderPlusIcon />Add project</Button>}</div><div className="welcome-detail"><ShieldCheckIcon /><span>Your installed Codex. Your existing controls.</span></div></div>}</section>{filesOpen && project && <FilePanel token={token} project={project} root={root} close={() => setFilesOpen(false)} />}</div>
    </main>
    <Dialog open={dialog !== null} onOpenChange={open => { if (!open && !busy) setDialog(null); }}><DialogPopup bottomStickOnMobile={false}><DialogHeader><DialogTitle>{dialog === "project" ? "Add a project" : dialog === "chat" ? "New chat" : dialog === "rename" ? "Rename chat" : dialog === "worktree" ? "Create a worktree" : "Local settings"}</DialogTitle><DialogDescription>{dialog === "project" ? "Choose explicit directories from the server’s authorized roots." : dialog === "chat" ? "Start an independent conversation in this project." : dialog === "worktree" ? "Use a separate checkout for work in one repository." : dialog === "rename" ? "Give this conversation a useful name." : "Preferences are saved on this machine."}</DialogDescription></DialogHeader>
      {dialog === "settings" ? <><DialogPanel><fieldset className="theme-options"><legend>Appearance</legend>{(["system", "light", "dark"] as const).map(theme => <button key={theme} aria-pressed={snapshot.settings.theme === theme} disabled={busy} onClick={() => void mutate("/api/settings", "PATCH", { theme }).catch(() => {})}>{theme === "dark" ? <MoonIcon /> : theme === "light" ? <SunIcon /> : <SettingsIcon />}<span>{theme[0].toUpperCase() + theme.slice(1)}</span>{snapshot.settings.theme === theme && <CheckIcon />}</button>)}</fieldset><section className="settings-note"><ShieldCheckIcon /><div><strong>Approved CLI controls</strong><p>Authentication, endpoints, sandboxing, approvals, skills and MCP configuration belong to your installed Codex.</p></div></section><section className="settings-note"><GitBranchIcon /><div><strong>Chats share files</strong><p>Separate chats do not isolate workspaces. A worktree isolates one repository, not additional roots or other repositories.</p></div></section></DialogPanel><DialogFooter><Button variant="outline" onClick={() => { saveToken(""); setToken(""); setSnapshot(empty); setDialog(null); }}>Disconnect this tab</Button><Button onClick={() => setDialog(null)}>Done</Button></DialogFooter></> : <form onSubmit={event => void submitDialog(event)}><DialogPanel><label className="field-label">{dialog === "worktree" ? "Destination directory" : dialog === "chat" ? "Chat name (optional)" : "Name"}<Input value={name} onChange={event => setName(event.target.value)} autoFocus placeholder={dialog === "worktree" ? "/authorized/root/new-checkout" : dialog === "chat" ? "New chat" : dialog === "project" ? "Project name" : "Conversation name"} required={dialog !== "chat"} /></label>
        {dialog === "project" && <fieldset className="authorized-roots"><legend>Authorized roots</legend>{snapshot.roots.map(path => <label key={path}><input type="checkbox" checked={projectRoots.includes(path)} onChange={event => setProjectRoots(current => event.target.checked ? [...current, path] : current.filter(item => item !== path))} /><span>{path}</span></label>)}{!snapshot.roots.length && <p>No authorized roots are configured. Restart the server launcher with explicit local roots.</p>}<p>Directories outside this list are unavailable.</p></fieldset>}
        {(dialog === "chat" || dialog === "worktree") && dialogProject && <RootChoice roots={dialogProject.roots} value={chatRoot} onChange={setChatRoot} label={dialog === "worktree" ? "Repository root" : "Working directory"} />}
        {dialog === "chat" && dialogProject && dialogProject.roots.length > 1 && <p className="field-note">The chat starts in the selected root. Additional roots remain available for local viewing; CLI access follows its existing policy.</p>}
        {dialog === "worktree" && <label className="field-label">New branch (optional)<Input value={worktreeBranch} onChange={event => setWorktreeBranch(event.target.value)} placeholder="feature/my-change" /></label>}
        {(dialog === "chat" || dialog === "worktree") && <div className="workspace-warning"><GitBranchIcon /><p>Chats share files. A worktree isolates one repository; other roots and repositories remain shared.</p></div>}
        {error && <p className="error-text" role="alert">{error}</p>}
      </DialogPanel><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setDialog(null)}>Cancel</Button><Button type="submit" disabled={busy || dialog === "project" && (!name.trim() || !projectRoots.length) || dialog === "rename" && !name.trim() || dialog === "worktree" && !name.trim()}>{busy ? "Saving…" : dialog === "project" ? "Add project" : dialog === "chat" ? "Create chat" : dialog === "worktree" ? "Create worktree" : "Save name"}</Button></DialogFooter></form>}
    </DialogPopup></Dialog>
  </div>;
}
