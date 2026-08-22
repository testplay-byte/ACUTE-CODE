import { create } from 'zustand';

export interface DashboardTheme {
  id: string;
  name: string;
  accent: string;
  accent2: string;
  bgLight: string;
  bgDark: string;
  cardLight: string;
  cardDark: string;
  textLight: string;
  textDark: string;
  borderLight: string;
  borderDark: string;
  mutedLight: string;
  mutedDark: string;
  inputBgLight: string;
  inputBgDark: string;
  hoverLight: string;
  hoverDark: string;
}

export const DASHBOARD_THEMES: DashboardTheme[] = [
  {
    id: 'nova',
    name: 'Nova Cream',
    accent: '#FF6B2C',
    accent2: '#FFD9C0',
    bgLight: '#FFFBF0',
    bgDark: '#1A1A1C',
    cardLight: '#FFFFFF',
    cardDark: '#242426',
    textLight: '#1A1A1A',
    textDark: '#F0EBE3',
    borderLight: '#EDE0D0',
    borderDark: '#363638',
    mutedLight: '#8A7A68',
    mutedDark: '#8A8A88',
    inputBgLight: '#FFF6EA',
    inputBgDark: '#2C2C2E',
    hoverLight: '#FFF3E6',
    hoverDark: '#2E2E30',
  },
  {
    id: 'bento',
    name: 'Bento Blue',
    accent: '#6366F1',
    accent2: '#A5B4FF',
    bgLight: '#EFF4FF',
    bgDark: '#141620',
    cardLight: '#FFFFFF',
    cardDark: '#1C1F30',
    textLight: '#121214',
    textDark: '#E0E3EE',
    borderLight: '#C7D0FE',
    borderDark: '#2A2E42',
    mutedLight: '#6B7AA1',
    mutedDark: '#7A7E96',
    inputBgLight: '#E8EDFF',
    inputBgDark: '#181B2A',
    hoverLight: '#E0E7FF',
    hoverDark: '#22253A',
  },
];

export interface Project {
  id: string;
  name: string;
  path: string;
  color: string;
}

export interface Session {
  id: string;
  projectId: string;
  title: string;
  timestamp: string;
  preview: string;
  model: string;
  tokensUsed: number;
  apiCalls: number;
}

export interface DailyProjectTokens {
  projectId: string;
  tokens: number;
}

export interface WeeklyTokenDay {
  day: string;
  shortDay: string;
  tokens: number;
  breakdown: DailyProjectTokens[];
}

const MOCK_PROJECTS: Project[] = [
  { id: 'p1', name: 'my-web-app', path: '~/projects/my-web-app', color: '#FF6B2C' },
  { id: 'p2', name: 'api-server', path: '~/projects/api-server', color: '#6366F1' },
  { id: 'p3', name: 'design-system', path: '~/work/design-system', color: '#10B981' },
  { id: 'p4', name: 'ml-pipeline', path: '~/research/ml-pipeline', color: '#F59E0B' },
];

const MOCK_SESSIONS: Record<string, Session[]> = {
  p1: [
    { id: 's1', projectId: 'p1', title: 'Fix authentication flow', timestamp: '2 hours ago', preview: 'Resolved the JWT refresh token issue where sessions would expire prematurely, causing users to be logged out unexpectedly during active sessions.', model: 'GPT-4o', tokensUsed: 32450, apiCalls: 12 },
    { id: 's2', projectId: 'p1', title: 'Refactor dashboard components', timestamp: 'Yesterday', preview: 'Split the monolithic Dashboard component into smaller, reusable pieces with proper prop interfaces and unit tests.', model: 'Claude 3.5', tokensUsed: 45200, apiCalls: 18 },
    { id: 's3', projectId: 'p1', title: 'Add dark mode support', timestamp: '3 days ago', preview: 'Implemented theme switching with CSS custom properties and Zustand state management for persistent preference storage.', model: 'GPT-4o', tokensUsed: 28600, apiCalls: 10 },
    { id: 's4', projectId: 'p1', title: 'Optimize image loading', timestamp: '1 week ago', preview: 'Added lazy loading, blur placeholders, and WebP conversion pipeline reducing initial page load by 40%.', model: 'Claude 3.5', tokensUsed: 19000, apiCalls: 8 },
  ],
  p2: [
    { id: 's5', projectId: 'p2', title: 'Build REST endpoints', timestamp: '5 hours ago', preview: 'Created CRUD endpoints for users, projects, and sessions with proper Zod validation and error handling middleware.', model: 'GPT-4o', tokensUsed: 52300, apiCalls: 22 },
    { id: 's6', projectId: 'p2', title: 'Database schema migration', timestamp: '2 days ago', preview: 'Migrated from MongoDB to PostgreSQL with Prisma ORM, updated all queries and added proper indexing.', model: 'Claude 3.5', tokensUsed: 35100, apiCalls: 16 },
  ],
  p3: [
    { id: 's7', projectId: 'p3', title: 'Design token system', timestamp: '1 day ago', preview: 'Created a comprehensive design token system with color, spacing, and typography scales exported as CSS variables.', model: 'GPT-4o', tokensUsed: 41800, apiCalls: 20 },
  ],
  p4: [
    { id: 's8', projectId: 'p4', title: 'Feature engineering pipeline', timestamp: '4 days ago', preview: 'Built an automated feature engineering pipeline that processes raw data into ML-ready features with validation.', model: 'Claude 3.5', tokensUsed: 18500, apiCalls: 14 },
    { id: 's9', projectId: 'p4', title: 'Model training script', timestamp: '1 week ago', preview: 'Set up distributed training with PyTorch and Weights & Biases integration for experiment tracking.', model: 'GPT-4o', tokensUsed: 11800, apiCalls: 6 },
  ],
};

// Weekly token usage data (last 7 days) with per-project breakdown
export const WEEKLY_TOKENS: WeeklyTokenDay[] = [
  { day: 'Monday', shortDay: 'Mon', tokens: 42000, breakdown: [
    { projectId: 'p1', tokens: 18000 }, { projectId: 'p2', tokens: 15000 }, { projectId: 'p3', tokens: 6000 }, { projectId: 'p4', tokens: 3000 },
  ]},
  { day: 'Tuesday', shortDay: 'Tue', tokens: 38500, breakdown: [
    { projectId: 'p1', tokens: 12000 }, { projectId: 'p2', tokens: 16500 }, { projectId: 'p3', tokens: 5000 }, { projectId: 'p4', tokens: 5000 },
  ]},
  { day: 'Wednesday', shortDay: 'Wed', tokens: 51200, breakdown: [
    { projectId: 'p1', tokens: 22000 }, { projectId: 'p2', tokens: 18000 }, { projectId: 'p3', tokens: 8200 }, { projectId: 'p4', tokens: 3000 },
  ]},
  { day: 'Thursday', shortDay: 'Thu', tokens: 44800, breakdown: [
    { projectId: 'p1', tokens: 16000 }, { projectId: 'p2', tokens: 12000 }, { projectId: 'p3', tokens: 10800 }, { projectId: 'p4', tokens: 6000 },
  ]},
  { day: 'Friday', shortDay: 'Fri', tokens: 62300, breakdown: [
    { projectId: 'p1', tokens: 25000 }, { projectId: 'p2', tokens: 22000 }, { projectId: 'p3', tokens: 11300 }, { projectId: 'p4', tokens: 4000 },
  ]},
  { day: 'Saturday', shortDay: 'Sat', tokens: 28400, breakdown: [
    { projectId: 'p1', tokens: 8000 }, { projectId: 'p2', tokens: 9400 }, { projectId: 'p3', tokens: 6000 }, { projectId: 'p4', tokens: 5000 },
  ]},
  { day: 'Sunday', shortDay: 'Sun', tokens: 18550, breakdown: [
    { projectId: 'p1', tokens: 5000 }, { projectId: 'p2', tokens: 7000 }, { projectId: 'p3', tokens: 3550 }, { projectId: 'p4', tokens: 3000 },
  ]},
];

interface DashboardState {
  isDark: boolean;
  themeId: string;
  selectedProjectId: string | null;
  projects: Project[];
  sessions: Record<string, Session[]>;
  searchQuery: string;
  searchOpen: boolean;
  sidebarOpen: boolean;

  toggleDark: () => void;
  setTheme: (id: string) => void;
  selectProject: (id: string) => void;
  goHome: () => void;
  addProject: (name: string, path: string) => void;
  setSearchQuery: (q: string) => void;
  setSearchOpen: (open: boolean) => void;
  addSession: (projectId: string, title: string) => void;
  deleteSession: (projectId: string, sessionId: string) => void;
  deleteProject: (id: string) => void;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
}

export const useDashboardStore = create<DashboardState>((set) => ({
  isDark: false,
  themeId: 'nova',
  selectedProjectId: null,
  projects: MOCK_PROJECTS,
  sessions: MOCK_SESSIONS,
  searchQuery: '',
  searchOpen: false,
  sidebarOpen: false,

  toggleDark: () => set((s) => ({ isDark: !s.isDark })),
  setTheme: (id) => set({ themeId: id }),
  selectProject: (id) => set((s) => ({
    selectedProjectId: s.selectedProjectId === id ? null : id,
    sidebarOpen: false,
  })),
  goHome: () => set({ selectedProjectId: null }),
  addProject: (name, path) =>
    set((s) => {
      const newId = `p${Date.now()}`;
      return {
        projects: [
          ...s.projects,
          { id: newId, name, path, color: DASHBOARD_THEMES.find((t) => t.id === s.themeId)?.accent || '#FF6B2C' },
        ],
        sessions: { ...s.sessions, [newId]: [] },
        selectedProjectId: newId,
        sidebarOpen: false,
      };
    }),
  setSearchQuery: (q) => set({ searchQuery: q }),
  setSearchOpen: (open) => set({ searchOpen: open }),
  addSession: (projectId, title) =>
    set((s) => ({
      sessions: {
        ...s.sessions,
        [projectId]: [
          { id: `s${Date.now()}`, projectId, title, timestamp: 'Just now', preview: 'New session started...', model: 'GPT-4o', tokensUsed: 0, apiCalls: 0 },
          ...(s.sessions[projectId] || []),
        ],
      },
    })),
  deleteSession: (projectId, sessionId) =>
    set((s) => ({
      sessions: { ...s.sessions, [projectId]: (s.sessions[projectId] || []).filter((sess) => sess.id !== sessionId) },
    })),
  deleteProject: (id) =>
    set((s) => {
      const { [id]: _, ...rest } = s.sessions;
      return { projects: s.projects.filter((p) => p.id !== id), sessions: rest, selectedProjectId: s.selectedProjectId === id ? null : s.selectedProjectId };
    }),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
}));
