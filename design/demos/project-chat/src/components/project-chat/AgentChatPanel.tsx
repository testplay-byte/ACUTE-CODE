'use client';

import { useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  CircleDot, Sparkles, FileCode2, Search, Terminal, Edit3,
  ArrowUp, Paperclip,
} from 'lucide-react';
import { useTheme } from '@/lib/dashboard-helpers';
import {
  useProjectChatStore,
  MODEL_OPTIONS,
  type ChatMessage,
} from '@/lib/project-chat-store';
import { useScrollFade } from '@/lib/useScrollFade';

const ease = [0.25, 0.1, 0.25, 1] as const;

const msgVariants = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.35, ease } },
  exit: { opacity: 0, y: -8, transition: { duration: 0.2, ease } },
};

const ACTION_ICONS: Record<string, React.ReactNode> = {
  file: <FileCode2 size={11} />,
  search: <Search size={11} />,
  edit: <Edit3 size={11} />,
  terminal: <Terminal size={11} />,
};

function UserMessage({ msg }: { msg: ChatMessage }) {
  const { isDark, accent } = useTheme();
  return (
    <motion.div className="flex justify-end" variants={msgVariants} initial="initial" animate="animate">
      <div
        className="max-w-[85%] rounded-2xl rounded-br-md px-3.5 py-2.5 text-[13px] leading-[1.5]"
        style={{ background: accent, color: isDark ? '#000' : '#fff' }}
      >
        {msg.content}
      </div>
    </motion.div>
  );
}

function RichText({ content }: { content: string }) {
  const { isDark, text, accent } = useTheme();
  const lines = content.split('\n');
  const elements: React.ReactNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const parts = line.split(/\*\*(.*?)\*\*/g);
    const lineEl: React.ReactNode[] = [];

    for (let j = 0; j < parts.length; j++) {
      const part = parts[j];
      if (j % 2 === 1) {
        lineEl.push(<strong key={"b-" + i + "-" + j}>{part}</strong>);
        continue;
      }
      const codeParts = part.split(/`(.*?)`/g);
      for (let k = 0; k < codeParts.length; k++) {
        const cp = codeParts[k];
        if (k % 2 === 1) {
          lineEl.push(
            <code
              key={"c-" + i + "-" + j + "-" + k}
              className="px-1.5 py-0.5 rounded-md text-[11.5px] font-mono"
              style={{ background: isDark ? accent + '20' : accent + '14', color: text }}
            >
              {cp}
            </code>
          );
        } else if (cp) {
          lineEl.push(<span key={"s-" + i + "-" + j + "-" + k}>{cp}</span>);
        }
      }
    }

    if (i > 0) {
      elements.push(<div key={"br-" + i} className="mt-1.5" />);
    }
    elements.push(<span key={"l-" + i}>{lineEl}</span>);
  }

  return <>{elements}</>;
}

function AiMessage({ msg }: { msg: ChatMessage }) {
  const { card, text, border } = useTheme();
  return (
    <motion.div variants={msgVariants} initial="initial" animate="animate">
      <div
        className="rounded-2xl px-3.5 py-3 text-[13px] leading-[1.6] border"
        style={{ background: card, borderColor: border, color: text }}
      >
        <RichText content={msg.content} />
      </div>
    </motion.div>
  );
}

function ThoughtMessage({ msg }: { msg: ChatMessage }) {
  const { text, border, muted, inputBg } = useTheme();
  return (
    <motion.div variants={msgVariants} initial="initial" animate="animate">
      <div
        className="rounded-2xl border px-3.5 py-3 text-[12.5px] leading-[1.55]"
        style={{ background: inputBg, borderColor: border, color: muted }}
      >
        <div className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest mb-1.5" style={{ color: text }}>
          <CircleDot size={12} />
          Thought
        </div>
        <div>{msg.content}</div>
      </div>
    </motion.div>
  );
}

function ActionPills({ msg }: { msg: ChatMessage }) {
  const { isDark, bg, card, border, muted } = useTheme();
  if (!msg.actions) return null;
  return (
    <motion.div className="flex flex-wrap gap-1.5" variants={msgVariants} initial="initial" animate="animate">
      {msg.actions.map((action, i) => (
        <div
          key={i}
          className="inline-flex items-center gap-1.5 h-7 px-3 rounded-full border font-mono text-[11px]"
          style={{ background: isDark ? bg : card, borderColor: border, color: muted }}
        >
          {ACTION_ICONS[action.icon]}
          <span>{action.label}</span>
          <span className="opacity-50">&middot; {action.duration}</span>
        </div>
      ))}
    </motion.div>
  );
}

function DiffMessage({ msg }: { msg: ChatMessage }) {
  const { bg, border, muted } = useTheme();
  if (!msg.diff) return null;
  return (
    <motion.div variants={msgVariants} initial="initial" animate="animate">
      <div className="rounded-2xl border overflow-hidden" style={{ background: bg, borderColor: border }}>
        <div
          className="h-8 flex items-center justify-between px-3 border-b font-mono text-[11px]"
          style={{ borderColor: border, color: muted }}
        >
          <span>{msg.diff.fileName} {msg.diff.additions} {msg.diff.deletions}</span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full" style={{ background: '#22c55e' }} />
            {msg.diff.status}
          </span>
        </div>
        <div className="p-3 font-mono text-[11px] leading-[1.7] space-y-0.5">
          <div style={{ color: '#22c55e' }}>{'+ const limiter = new RateLimiter(options)'}</div>
          <div style={{ color: '#22c55e' }}>{'+ const key = options.keyGenerator?.(req) ?? req.ip'}</div>
          <div style={{ color: muted }}>{'  return async (req, res, next) => {'}</div>
          <div style={{ color: '#22c55e' }}>{'+   const { remaining, resetTime } = await limiter.check(key)'}</div>
          <div style={{ color: '#ef4444' }}>{'-   if (requests > MAX_REQUESTS) {'}</div>
          <div style={{ color: '#22c55e' }}>{'+   if (remaining <= 0) {'}</div>
          <div style={{ color: muted }}>{'      return res.status(429).json({'}</div>
          <div style={{ color: '#22c55e' }}>{'+       error: \'Too many requests\','}</div>
          <div style={{ color: '#22c55e' }}>{'+       retryAfter: resetTime,'}</div>
          <div style={{ color: muted }}>{'      });'}</div>
        </div>
      </div>
    </motion.div>
  );
}

function AgentThinking() {
  const { text, border, muted, accent, inputBg } = useTheme();
  const agentStatus = useProjectChatStore((s) => s.agentStatus);
  const selectedModelId = useProjectChatStore((s) => s.selectedModelId);
  const model = MODEL_OPTIONS.find((m) => m.id === selectedModelId);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className="flex items-center gap-3 px-1"
    >
      <div className="w-7 h-7 rounded-xl grid place-items-center border shrink-0" style={{ borderColor: border, background: inputBg }}>
        <Sparkles size={13} style={{ color: accent }} />
      </div>
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-[13px] font-semibold" style={{ color: text }}>Nova</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded-lg border font-mono" style={{ background: inputBg, borderColor: border, color: muted }}>
          {model?.name || 'claude-4'}
        </span>
      </div>
      <div className="flex items-center gap-1.5 text-[11px] font-mono ml-auto" style={{ color: muted }}>
        <span>{agentStatus}</span>
        <span className="flex gap-0.5">
          {[0, 0.15, 0.3].map((delay, i) => (
            <span
              key={i}
              className="w-1 h-1 rounded-full"
              style={{ background: muted, animation: 'bounceDot 1s infinite ' + delay + 's' }}
            />
          ))}
        </span>
      </div>
    </motion.div>
  );
}

function SuggestionBanner() {
  const { isDark, text, muted, accent } = useTheme();
  const showSuggestion = useProjectChatStore((s) => s.showSuggestion);
  const dismissSuggestion = useProjectChatStore((s) => s.dismissSuggestion);
  const setInputMessage = useProjectChatStore((s) => s.setInputMessage);

  if (!showSuggestion) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.97 }}
      className="relative rounded-2xl border p-3 mx-1"
      style={{
        background: accent + (isDark ? '20' : '14'),
        borderColor: accent + (isDark ? '30' : '25'),
        color: text,
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest opacity-60">
            <Sparkles size={11} /> Nova suggests
          </div>
          <div className="font-mono text-[12px] leading-[1.5] mt-1.5">
            {'Use '}
            <span className="px-1 py-0.5 rounded-lg" style={{ background: muted + '20' }}>sliding window</span>
            {' to avoid burst edge. Swap simple counter?'}
          </div>
        </div>
        <button
          onClick={dismissSuggestion}
          className="w-6 h-6 rounded-lg grid place-items-center transition-colors shrink-0"
          style={{ color: muted }}
          onMouseEnter={(e) => { e.currentTarget.style.background = muted + '20'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          &times;
        </button>
      </div>
      <div className="flex gap-1.5 mt-3">
        <button
          onClick={() => { setInputMessage('Implement sliding window rate limiter with Redis backend'); dismissSuggestion(); }}
          className="h-7 px-3 rounded-full text-[11px] font-medium transition-all"
          style={{ background: muted + '20', color: 'inherit' }}
        >
          Apply
        </button>
        <button
          onClick={dismissSuggestion}
          className="h-7 px-3 rounded-full text-[11px] font-medium transition-all"
          style={{ background: muted + '20', color: 'inherit', opacity: 0.7 }}
        >
          Dismiss
        </button>
      </div>
    </motion.div>
  );
}

function MessageRenderer({ msg }: { msg: ChatMessage }) {
  switch (msg.type) {
    case 'user': return <UserMessage msg={msg} />;
    case 'ai': return <AiMessage msg={msg} />;
    case 'thought': return <ThoughtMessage msg={msg} />;
    case 'actions': return <ActionPills msg={msg} />;
    case 'diff': return <DiffMessage msg={msg} />;
    default: return null;
  }
}

export function AgentChatPanel() {
  const { isDark, bg, card, text, border, muted, accent, inputBg } = useTheme();
  const messages = useProjectChatStore((s) => s.messages);
  const isAgentThinking = useProjectChatStore((s) => s.isAgentThinking);
  const inputMessage = useProjectChatStore((s) => s.inputMessage);
  const setInputMessage = useProjectChatStore((s) => s.setInputMessage);
  const sendMessage = useProjectChatStore((s) => s.sendMessage);
  const selectedModelId = useProjectChatStore((s) => s.selectedModelId);
  const model = MODEL_OPTIONS.find((m) => m.id === selectedModelId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useScrollFade(scrollRef);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages.length, isAgentThinking]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const handleSend = () => {
    if (!inputMessage.trim()) return;
    sendMessage();
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden rounded-2xl border" style={{ borderColor: border, background: card }}>
      <div
        className="shrink-0 flex items-center gap-2.5 h-11 px-3 border-b rounded-t-2xl"
        style={{ borderColor: border }}
      >
        <div className="w-6 h-6 rounded-lg grid place-items-center" style={{ background: accent, color: isDark ? '#000' : '#fff' }}>
          <Sparkles size={12} />
        </div>
        <span className="text-[13px] font-semibold" style={{ color: text }}>Nova</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded-lg border font-mono" style={{ background: inputBg, borderColor: border, color: muted }}>
          {model?.name || 'Claude 4'}
        </span>
        <span
          className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-lg"
          style={{ color: '#22c55e', background: '#22c55e14' }}
        >
          running
        </span>
      </div>

      <div className="relative flex-1 min-h-0 overflow-hidden">
        <div
          className="absolute top-0 left-0 right-0 h-8 z-10 pointer-events-none"
          style={{ background: 'linear-gradient(to bottom, ' + card + ', transparent)' }}
        />
        <div ref={scrollRef} className="absolute inset-0 overflow-y-auto px-4 py-4 space-y-3 auto-scroll">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-9 h-9 rounded-xl grid place-items-center border" style={{ borderColor: border, background: inputBg }}>
              <Sparkles size={16} style={{ color: accent }} />
            </div>
            <div>
              <div className="text-[14px] font-semibold" style={{ color: text }}>Nova</div>
              <div className="text-[11px] font-mono" style={{ color: muted }}>
                {'Acute Agent \u00B7 '}{model?.name || 'claude-4'}
              </div>
            </div>
          </div>

          <AnimatePresence mode="popLayout">
            {messages.map((msg) => (
              <MessageRenderer key={msg.id} msg={msg} />
            ))}
          </AnimatePresence>

          <AnimatePresence><SuggestionBanner /></AnimatePresence>
          <AnimatePresence>{isAgentThinking && <AgentThinking />}</AnimatePresence>
        </div>
      </div>

      <div className="shrink-0 p-3 rounded-b-2xl">
        <div
          className="flex items-center gap-2 p-1.5 rounded-2xl border"
          style={{ background: bg, borderColor: border }}
        >
          <button
            className="w-8 h-8 rounded-xl grid place-items-center border shrink-0 transition-colors"
            style={{ background: inputBg, borderColor: border, color: muted }}
            aria-label="Attach file"
          >
            <Paperclip size={13} />
          </button>
          <input
            ref={inputRef}
            value={inputMessage}
            onChange={(e) => setInputMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask Nova to refactor, explain, test..."
            className="flex-1 bg-transparent outline-none text-[13px] min-w-0"
            style={{ color: text }}
          />
          <button
            onClick={handleSend}
            className="w-8 h-8 rounded-xl grid place-items-center shrink-0 transition-all hover:scale-105 active:scale-95"
            style={{
              background: inputMessage.trim() ? accent : inputBg,
              color: inputMessage.trim() ? (isDark ? '#000' : '#fff') : muted,
              border: '1px solid ' + (inputMessage.trim() ? accent : border),
              opacity: inputMessage.trim() ? 1 : 0.6,
            }}
            aria-label="Send message"
          >
            <ArrowUp size={14} strokeWidth={2.5} />
          </button>
        </div>
        <div className="flex items-center justify-between mt-1.5 px-1">
          <span className="text-[10px] font-mono" style={{ color: muted }}>
            {'\u2318K to focus \u00B7 \u21B5 to send'}
          </span>
          <span className="text-[10px] font-mono flex items-center gap-1" style={{ color: muted }}>
            Fast
          </span>
        </div>
      </div>
    </div>
  );
}
