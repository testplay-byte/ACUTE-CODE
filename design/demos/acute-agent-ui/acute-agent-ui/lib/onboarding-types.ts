export interface ThemeColors {
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
  dot: string;
  dotDark: string;
  // Light mode palette colors for the theme preview
  paletteLight: string[];
  // Dark mode palette colors for the theme preview
  paletteDark: string[];
  // Palette colors for the palette-style theme preview
  selectedBg: string;
  selectedText: string;
  unselectedBg: string;
  unselectedBorder: string;
  blockBg: string;
  blockBorder: string;
  sidebarBg: string;
  sidebarBorder: string;
}

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  letter: string;
}

export type ReasoningLevel = 'none' | 'low' | 'med' | 'high' | 'extra';

export const THEMES: ThemeColors[] = [
  {
    id: 'nova',
    name: 'Nova Cream',
    accent: '#FF6B2C',
    accent2: '#FFD9C0',
    bgLight: '#FFFBF0',
    bgDark: '#242426',
    cardLight: '#FFFFFF',
    cardDark: '#2C2C2E',
    textLight: '#111111',
    textDark: '#FFFBF0',
    dot: '#FF6B2C',
    dotDark: '#FF8F55',
    paletteLight: ['#FF6B2C', '#FFD9C0', '#FFFBF0', '#FFFFFF', '#111111'],
    paletteDark: ['#FF6B2C', '#FF8F55', '#242426', '#2C2C2E', '#FFFBF0'],
    selectedBg: '#FF6B2C',
    selectedText: '#FFFFFF',
    unselectedBg: '#FFF3EB',
    unselectedBorder: '#FFD4BC',
    blockBg: '#FFFFFF',
    blockBorder: '#F0E0D0',
    sidebarBg: '#FFF7EE',
    sidebarBorder: '#FFE8D4',
  },
  {
    id: 'midnight',
    name: 'Midnight Lab',
    accent: '#D6FF57',
    accent2: '#B8F02A',
    bgLight: '#F2F3E8',
    bgDark: '#222224',
    cardLight: '#FFFFFF',
    cardDark: '#2A2A2C',
    textLight: '#121214',
    textDark: '#F2F3E8',
    dot: '#D6FF57',
    dotDark: '#D6FF57',
    paletteLight: ['#D6FF57', '#B8F02A', '#F2F3E8', '#FFFFFF', '#121214'],
    paletteDark: ['#D6FF57', '#B8F02A', '#222224', '#2A2A2C', '#F2F3E8'],
    selectedBg: '#D6FF57',
    selectedText: '#111111',
    unselectedBg: '#F0F1E6',
    unselectedBorder: '#DDE0CC',
    blockBg: '#FAFBF2',
    blockBorder: '#E2E4D0',
    sidebarBg: '#EEF0E2',
    sidebarBorder: '#D8DAC8',
  },
  {
    id: 'bento',
    name: 'Bento Blue',
    accent: '#6366F1',
    accent2: '#A5B4FF',
    bgLight: '#EFF4FF',
    bgDark: '#222838',
    cardLight: '#FFFFFF',
    cardDark: '#2A2E3E',
    textLight: '#121214',
    textDark: '#EFF4FF',
    dot: '#6366F1',
    dotDark: '#818CF8',
    paletteLight: ['#6366F1', '#A5B4FF', '#EFF4FF', '#FFFFFF', '#121214'],
    paletteDark: ['#6366F1', '#818CF8', '#222838', '#2A2E3E', '#EFF4FF'],
    selectedBg: '#6366F1',
    selectedText: '#FFFFFF',
    unselectedBg: '#E8EDFF',
    unselectedBorder: '#C7D0FE',
    blockBg: '#FFFFFF',
    blockBorder: '#D4DBFF',
    sidebarBg: '#EBF0FF',
    sidebarBorder: '#CDD6FF',
  },
  {
    id: 'sunset',
    name: 'Sunset Pop',
    accent: '#FF7A3D',
    accent2: '#FFB88A',
    bgLight: '#FFF0E6',
    bgDark: '#2A2018',
    cardLight: '#FFFFFF',
    cardDark: '#322218',
    textLight: '#121214',
    textDark: '#FFF0E6',
    dot: '#FF7A3D',
    dotDark: '#FF9A6D',
    paletteLight: ['#FF7A3D', '#FFB88A', '#FFF0E6', '#FFFFFF', '#121214'],
    paletteDark: ['#FF7A3D', '#FF9A6D', '#2A2018', '#322218', '#FFF0E6'],
    selectedBg: '#FF7A3D',
    selectedText: '#FFFFFF',
    unselectedBg: '#FFE8DA',
    unselectedBorder: '#FFD0B5',
    blockBg: '#FFFFFF',
    blockBorder: '#F5DDD0',
    sidebarBg: '#FFEDE0',
    sidebarBorder: '#FFDBC8',
  },
  {
    id: 'mono',
    name: 'Mono Stone',
    accent: '#111111',
    accent2: '#A0A0A0',
    bgLight: '#F5F5F0',
    bgDark: '#242426',
    cardLight: '#FFFFFF',
    cardDark: '#2C2C2E',
    textLight: '#111111',
    textDark: '#F5F5F0',
    dot: '#111111',
    dotDark: '#E0E0E0',
    paletteLight: ['#111111', '#A0A0A0', '#F5F5F0', '#FFFFFF', '#111111'],
    paletteDark: ['#E0E0E0', '#A0A0A0', '#242426', '#2C2C2E', '#F5F5F0'],
    selectedBg: '#111111',
    selectedText: '#FFFFFF',
    unselectedBg: '#EEEEEA',
    unselectedBorder: '#D5D5D0',
    blockBg: '#FAFAF7',
    blockBorder: '#E0E0DB',
    sidebarBg: '#F0F0EB',
    sidebarBorder: '#DDDDE0',
  },
];

export const COMING_SOON_THEME: ThemeColors = {
  id: 'coming-soon',
  name: 'New themes coming soon',
  accent: '#C0C0C0',
  accent2: '#E0E0E0',
  bgLight: '#F8F8F8',
  bgDark: '#242426',
  cardLight: '#FFFFFF',
  cardDark: '#2C2C2E',
  textLight: '#999999',
  textDark: '#999999',
  dot: '#C0C0C0',
  dotDark: '#C0C0C0',
  paletteLight: ['#C0C0C0', '#E0E0E0', '#F8F8F8', '#FFFFFF', '#999999'],
  paletteDark: ['#C0C0C0', '#E0E0E0', '#242426', '#2C2C2E', '#999999'],
  selectedBg: '#C0C0C0',
  selectedText: '#FFFFFF',
  unselectedBg: '#F0F0F0',
  unselectedBorder: '#DDDDDD',
  blockBg: '#F5F5F5',
  blockBorder: '#E0E0E0',
  sidebarBg: '#FAFAFA',
  sidebarBorder: '#EEEEEE',
};

export const CONTEXT_SNAP_POINTS = [1000, 5000, 10000, 30000, 50000, 100000, 200000, 500000, 1000000];

export const CONTEXT_LABELS: Record<number, string> = {
  1000: '1K',
  5000: '5K',
  10000: '10K',
  30000: '30K',
  50000: '50K',
  100000: '100K',
  200000: '200K',
  500000: '500K',
  1000000: '1M',
};

export const PROVIDERS: Provider[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'o1-preview', 'o1-mini'],
    letter: 'O',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    models: ['claude-3-5-sonnet-20241022', 'claude-3-opus-20240229', 'claude-3-haiku-20240307'],
    letter: 'A',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    models: ['gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-2.0-flash'],
    letter: 'G',
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768'],
    letter: 'Q',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['openrouter/auto', 'anthropic/claude-3.5-sonnet'],
    letter: 'R',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    models: ['mistral-large-latest', 'mistral-medium-latest', 'codestral-latest'],
    letter: 'M',
  },
  {
    id: 'cohere',
    name: 'Cohere',
    baseUrl: 'https://api.cohere.ai/v1',
    models: ['command-r-plus', 'command-r', 'command'],
    letter: 'C',
  },
  {
    id: 'together',
    name: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    models: ['meta-llama/Llama-3-70b-chat-hf', 'mistralai/Mixtral-8x7B-Instruct-v0.1'],
    letter: 'T',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-coder', 'deepseek-reasoner'],
    letter: 'D',
  },
  {
    id: 'openai-compatible',
    name: 'OpenAI Compatible',
    baseUrl: 'https://',
    models: ['my-model-v1'],
    letter: '⚡',
  },
];

export const REASONING_LEVELS: { id: ReasoningLevel; label: string; desc: string; icon: string }[] = [
  { id: 'none', label: 'None', desc: 'Fastest', icon: '○' },
  { id: 'low', label: 'Low', desc: 'Quick thoughts', icon: '◐' },
  { id: 'med', label: 'Med', desc: 'Balanced', icon: '◑' },
  { id: 'high', label: 'High', desc: 'Deep dive', icon: '◒' },
  { id: 'extra', label: 'Extra', desc: 'Max reasoning', icon: '●' },
];
