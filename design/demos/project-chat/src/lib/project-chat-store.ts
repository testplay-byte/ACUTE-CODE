'use client';

import { create } from 'zustand';

// ============================================================
// TYPES
// ============================================================

export type ChatPanelPosition = 'right' | 'left' | 'center';
export type PanelId = 'explorer';

export interface FileNode {
  id: string;
  name: string;
  type: 'file' | 'folder';
  lang?: string;
  lines?: number;
  children?: FileNode[];
}

export interface TodoItem {
  id: number;
  text: string;
  done: boolean;
}

export interface ActionPill {
  icon: 'file' | 'search' | 'edit' | 'terminal';
  label: string;
  duration: string;
}

export interface CodeDiff {
  fileName: string;
  additions: string;
  context?: string;
  deletions?: string;
  status: 'applied' | 'pending';
}

export type MessageType = 'user' | 'ai' | 'thought' | 'actions' | 'diff';

export interface ChatMessage {
  id: string;
  type: MessageType;
  content: string;
  actions?: ActionPill[];
  diff?: CodeDiff;
  timestamp?: string;
}

export interface PanelConfig {
  id: PanelId;
  label: string;
  icon: string;
  defaultCollapsed: boolean;
}

export interface ModelOption {
  id: string;
  name: string;
  provider: string;
  description: string;
}

// ============================================================
// MOCK DATA
// ============================================================

export const MODEL_OPTIONS: ModelOption[] = [
  { id: 'claude-4', name: 'Claude 4', provider: 'Anthropic', description: 'Most capable model' },
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'OpenAI', description: 'Fast & reliable' },
  { id: 'gemini-2.5', name: 'Gemini 2.5 Pro', provider: 'Google', description: 'Long context window' },
  { id: 'llama-3.1', name: 'Llama 3.1 405B', provider: 'Meta', description: 'Open weights' },
];

export const MOCK_FILES: FileNode[] = [
  {
    id: 'src', name: 'src', type: 'folder', children: [
      {
        id: 'components', name: 'components', type: 'folder', children: [
          { id: 'header.tsx', name: 'Header.tsx', type: 'file', lang: 'tsx', lines: 84 },
          { id: 'sidebar.tsx', name: 'Sidebar.tsx', type: 'file', lang: 'tsx', lines: 126 },
          { id: 'chat.tsx', name: 'ChatArea.tsx', type: 'file', lang: 'tsx', lines: 210 },
        ],
      },
      {
        id: 'lib', name: 'lib', type: 'folder', children: [
          { id: 'store.ts', name: 'store.ts', type: 'file', lang: 'ts', lines: 95 },
          { id: 'api.ts', name: 'api.ts', type: 'file', lang: 'ts', lines: 142 },
          { id: 'utils.ts', name: 'utils.ts', type: 'file', lang: 'ts', lines: 56 },
        ],
      },
      {
        id: 'app', name: 'app', type: 'folder', children: [
          { id: 'layout.tsx', name: 'layout.tsx', type: 'file', lang: 'tsx', lines: 42 },
          { id: 'page.tsx', name: 'page.tsx', type: 'file', lang: 'tsx', lines: 18 },
          { id: 'globals.css', name: 'globals.css', type: 'file', lang: 'css', lines: 120 },
        ],
      },
    ],
  },
  { id: 'package.json', name: 'package.json', type: 'file', lang: 'json', lines: 38 },
  { id: 'tsconfig.json', name: 'tsconfig.json', type: 'file', lang: 'json', lines: 22 },
  { id: 'README.md', name: 'README.md', type: 'file', lang: 'md', lines: 45 },
  { id: '.env.local', name: '.env.local', type: 'file', lang: 'env', lines: 8 },
];

export const MOCK_CODE = `import { NextRequest, NextResponse } from 'next/server';
import { RateLimiter } from './rate-limit';
import { AuthGuard } from './auth.guard';

export function createMiddleware(options: {
  windowMs: number;
  max: number;
  keyGenerator?: (req: NextRequest) => string;
}) {
  const limiter = new RateLimiter(options);
  const guard = new AuthGuard();

  return async (req: NextRequest, res: NextResponse) => {
    const key = options.keyGenerator?.(req) ?? req.ip ?? 'unknown';
    const { remaining, resetTime } = await limiter.check(key);

    res.headers.set('X-RateLimit-Remaining', String(remaining));
    res.headers.set('X-RateLimit-Reset', String(resetTime));

    if (remaining <= 0) {
      return NextResponse.json(
        { error: 'Too many requests', retryAfter: resetTime },
        { status: 429 }
      );
    }

    const user = await guard.verify(req);
    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    return NextResponse.next();
  };
}`;

export const MOCK_MESSAGES: ChatMessage[] = [
  {
    id: 'm1',
    type: 'user',
    content: 'Add rate limiting to the auth middleware. Use a sliding window algorithm with Redis backend.',
    timestamp: '2:34 PM',
  },
  {
    id: 'm2',
    type: 'thought',
    content: 'Check existing auth guard implementation. Prefer sliding window over fixed counter for smoother burst handling. Need a flexible key generator that supports IP-based and user-based limiting.',
  },
  {
    id: 'm3',
    type: 'actions',
    content: '',
    actions: [
      { icon: 'file', label: 'read middleware.ts', duration: '42ms' },
      { icon: 'search', label: 'search auth usage', duration: '18ms' },
      { icon: 'file', label: 'read rate-limit.ts', duration: '31ms' },
    ],
  },
  {
    id: 'm4',
    type: 'ai',
    content: "I've analyzed the current middleware setup. Here's my implementation plan:\n\n1. **Sliding window rate limiter** with configurable time windows\n2. **Redis store adapter** for distributed rate limiting\n3. **Key generator** supporting IP and user-based keys\n4. **Rate limit headers** (X-RateLimit-Remaining, X-RateLimit-Reset)\n\nThe implementation protects against burst abuse while keeping the API responsive.",
  },
  {
    id: 'm5',
    type: 'diff',
    content: '',
    diff: {
      fileName: 'middleware.ts',
      additions: '+12',
      deletions: '-2',
      status: 'applied',
    },
  },
];

export const MOCK_TODO_ITEMS: TodoItem[] = [
  { id: 1, text: 'Audit current auth flow', done: true },
  { id: 2, text: 'Implement sliding window algorithm', done: true },
  { id: 3, text: 'Add Redis store adapter', done: false },
  { id: 4, text: 'Write tests & documentation', done: false },
];

export const PANEL_CONFIGS: Record<PanelId, PanelConfig> = {
  explorer: { id: 'explorer', label: 'Explorer', icon: 'Files', defaultCollapsed: false },
};

export const DEFAULT_PANEL_ORDER: PanelId[] = ['explorer'];

// ============================================================
// FREE-FORM PANEL POSITIONS (for experimental mode)
// ============================================================

export interface FreeformPanel {
  id: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  minimized: boolean;
}

export const DEFAULT_FREEFORM_PANELS: FreeformPanel[] = [
  { id: 'sidebar', title: 'Explorer', x: 20, y: 50, width: 280, height: 420, zIndex: 10, minimized: false },
  { id: 'code', title: 'Code', x: 320, y: 50, width: 580, height: 420, zIndex: 9, minimized: false },
  { id: 'chat', title: 'Agent Chat', x: 920, y: 50, width: 360, height: 420, zIndex: 11, minimized: false },
  { id: 'todo', title: 'To-Do', x: 320, y: 490, width: 280, height: 220, zIndex: 8, minimized: false },
];

// ============================================================
// STATE
// ============================================================

interface ProjectChatState {
  // Chat panel position
  chatPanelPosition: ChatPanelPosition;
  setChatPanelPosition: (pos: ChatPanelPosition) => void;

  // Experimental mode
  experimentalMode: boolean;
  setExperimentalMode: (on: boolean) => void;
  freeformPanels: FreeformPanel[];
  updateFreeformPanel: (id: string, updates: Partial<FreeformPanel>) => void;

  // Chat
  messages: ChatMessage[];
  inputMessage: string;
  setInputMessage: (msg: string) => void;
  sendMessage: () => void;
  showSuggestion: boolean;
  dismissSuggestion: () => void;

  // Agent status
  isAgentThinking: boolean;
  agentStatus: string;
  setAgentThinking: (thinking: boolean, status?: string) => void;

  // Todo items (renamed from steps)
  todoItems: TodoItem[];
  toggleTodo: (id: number) => void;

  // Files
  files: FileNode[];
  selectedFileId: string | null;
  selectFile: (id: string) => void;
  expandedFolders: Set<string>;
  toggleFolder: (id: string) => void;

  // Panels (sidebar)
  panelOrder: PanelId[];
  setPanelOrder: (order: PanelId[]) => void;
  collapsedPanels: Set<string>;
  togglePanel: (id: string) => void;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;

  // Code view
  code: string;

  // Model
  selectedModelId: string;
  setSelectedModelId: (id: string) => void;

  // Code visibility
  codeVisible: boolean;
  setCodeVisible: (v: boolean) => void;

  // Hamburger menu
  hamburgerOpen: boolean;
  setHamburgerOpen: (open: boolean) => void;
}

export const useProjectChatStore = create<ProjectChatState>((set, get) => ({
  // Chat panel position
  chatPanelPosition: 'right',
  setChatPanelPosition: (pos) => set({ chatPanelPosition: pos }),

  // Experimental mode
  experimentalMode: false,
  setExperimentalMode: (on) => set({ experimentalMode: on }),
  freeformPanels: DEFAULT_FREEFORM_PANELS,
  updateFreeformPanel: (id, updates) => set((s) => ({
    freeformPanels: s.freeformPanels.map((p) =>
      p.id === id ? { ...p, ...updates } : p
    ),
  })),

  // Chat
  messages: MOCK_MESSAGES,
  inputMessage: '',
  setInputMessage: (msg) => set({ inputMessage: msg }),
  sendMessage: () => {
    const { inputMessage, messages, selectedModelId } = get();
    if (!inputMessage.trim()) return;
    const userMsg: ChatMessage = {
      id: `m${Date.now()}`,
      type: 'user',
      content: inputMessage.trim(),
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    set({
      messages: [...messages, userMsg],
      inputMessage: '',
      showSuggestion: false,
    });
    // Simulate agent thinking
    set({ isAgentThinking: true, agentStatus: 'Processing your request' });
    setTimeout(() => {
      set({ isAgentThinking: false, agentStatus: '' });
      const aiResponse: ChatMessage = {
        id: `m${Date.now() + 1}`,
        type: 'ai',
        content: "I'll look into that. Let me analyze the codebase and get back to you with a detailed plan.",
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
      set({ messages: [...get().messages, aiResponse] });
    }, 2000);
  },
  showSuggestion: true,
  dismissSuggestion: () => set({ showSuggestion: false }),

  // Agent status
  isAgentThinking: false,
  agentStatus: 'Reading middleware.ts',
  setAgentThinking: (thinking, status) => set({
    isAgentThinking: thinking,
    agentStatus: status || '',
  }),

  // Todo items
  todoItems: MOCK_TODO_ITEMS,
  toggleTodo: (id) => set((s) => ({
    todoItems: s.todoItems.map((t) => t.id === id ? { ...t, done: !t.done } : t),
  })),

  // Files
  files: MOCK_FILES,
  selectedFileId: 'store.ts',
  selectFile: (id) => set({ selectedFileId: id }),
  expandedFolders: new Set(['src', 'components', 'lib', 'app']),
  toggleFolder: (id) => set((s) => {
    const next = new Set(s.expandedFolders);
    if (next.has(id)) next.delete(id); else next.add(id);
    return { expandedFolders: next };
  }),

  // Panels
  panelOrder: DEFAULT_PANEL_ORDER,
  setPanelOrder: (order) => set({ panelOrder: order }),
  collapsedPanels: new Set<string>(),
  togglePanel: (id) => set((s) => {
    const next = new Set(s.collapsedPanels);
    if (next.has(id)) next.delete(id); else next.add(id);
    return { collapsedPanels: next };
  }),
  sidebarOpen: true,
  setSidebarOpen: (open) => set({ sidebarOpen: open }),

  // Code view
  code: MOCK_CODE,

  // Model
  selectedModelId: 'claude-4',
  setSelectedModelId: (id) => set({ selectedModelId: id }),

  // Code visibility
  codeVisible: true,
  setCodeVisible: (v) => set({ codeVisible: v }),

  // Hamburger menu
  hamburgerOpen: false,
  setHamburgerOpen: (open) => set({ hamburgerOpen: open }),
}));
