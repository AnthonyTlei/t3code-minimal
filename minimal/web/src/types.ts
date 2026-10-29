export type Project = { id: string; name: string; roots: string[] };
export type Message = { id: string; role: "user" | "assistant" | "system"; text: string; kind?: string; status?: string; details?: unknown };
export type PendingRequest = { id?: string | number; requestId?: string | number; method?: string; params?: Record<string, unknown>; allowedDecisions?: unknown[] };
export type Chat = { id: string; projectId: string; title: string; archived: boolean; status: string; model?: string; reasoning?: string; workspaceRoot?: string; nativeThreadId?: string; messages: Message[]; pendingRequests: PendingRequest[]; error?: string };
export type Snapshot = { projects: Project[]; chats: Chat[]; settings: { theme: "system" | "light" | "dark" }; roots: string[] };
export type Model = { id: string; name: string; reasoning: { effort: string; description?: string }[]; defaultReasoning?: string; isDefault?: boolean };
export type Capabilities = { models: Model[]; policyControls: false; additionalRoots: false };
