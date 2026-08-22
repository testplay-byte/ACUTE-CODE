'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { ChevronRight, FileCode2, Braces, FileJson, FileText, FolderOpen } from 'lucide-react';
import { useTheme } from '@/lib/dashboard-helpers';
import { useProjectChatStore, type FileNode } from '@/lib/project-chat-store';

const FILE_COLORS: Record<string, string> = {
  tsx: '#3178C6',
  ts: '#3178C6',
  json: '#F59E0B',
  css: '#A855F7',
  md: '#6B7280',
  env: '#EF4444',
  js: '#F7DF1E',
};

function FileIcon({ name }: { name: string }) {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const color = FILE_COLORS[ext] || '#6B7280';

  if (ext === 'json') return <Braces size={14} style={{ color }} />;
  if (ext === 'md') return <FileText size={14} style={{ color }} />;
  if (ext === 'css') return <FileText size={14} style={{ color }} />;
  return <FileCode2 size={14} style={{ color }} />;
}

function FileTreeItem({ node, depth = 0 }: { node: FileNode; depth?: number }) {
  const { isDark, text, muted, accent, inputBg, hover } = useTheme();
  const selectedFileId = useProjectChatStore((s) => s.selectedFileId);
  const selectFile = useProjectChatStore((s) => s.selectFile);
  const expandedFolders = useProjectChatStore((s) => s.expandedFolders);
  const toggleFolder = useProjectChatStore((s) => s.toggleFolder);
  const isFolder = node.type === 'folder';
  const isExpanded = expandedFolders.has(node.id);
  const isSelected = selectedFileId === node.id;

  return (
    <div>
      <button
        className="w-full flex items-center gap-2 h-[34px] px-2 text-left transition-colors group rounded-lg mx-1.5"
        style={{
          paddingLeft: (depth * 14 + 8) + 'px',
          background: isSelected ? (isDark ? accent + '18' : accent + '14') : 'transparent',
        }}
        onClick={() => {
          if (isFolder) toggleFolder(node.id);
          else selectFile(node.id);
        }}
        onMouseEnter={(e) => {
          if (!isSelected) e.currentTarget.style.background = isDark ? inputBg : hover;
        }}
        onMouseLeave={(e) => {
          if (!isSelected) e.currentTarget.style.background = 'transparent';
        }}
      >
        {isFolder && (
          <motion.div
            animate={{ rotate: isExpanded ? 90 : 0 }}
            transition={{ duration: 0.15 }}
            className="shrink-0"
          >
            <ChevronRight size={12} style={{ color: muted }} />
          </motion.div>
        )}
        {!isFolder && <span className="w-3" />}
        {isFolder && !isExpanded && (
          <FolderOpen size={14} style={{ color: muted }} className="shrink-0" />
        )}
        {isFolder && isExpanded && (
          <FolderOpen size={14} style={{ color: accent }} className="shrink-0" />
        )}
        {!isFolder && <FileIcon name={node.name} />}
        <span
          className="text-[12.5px] font-mono truncate"
          style={{ color: isSelected ? text : muted, fontWeight: isSelected ? 500 : 400 }}
        >
          {node.name}
        </span>
      </button>

      <AnimatePresence initial={false}>
        {isFolder && isExpanded && node.children && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] as const }}
            style={{ overflow: 'hidden' }}
          >
            {node.children.map((child) => (
              <FileTreeItem key={child.id} node={child} depth={depth + 1} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function ExplorerPanel() {
  const { muted, accent, border } = useTheme();
  const files = useProjectChatStore((s) => s.files);

  return (
    <div className="py-2">
      {/* Project name */}
      <div className="px-3.5 pb-2.5 mb-1 border-b" style={{ borderColor: border }}>
        <div className="flex items-center gap-2">
          <div
            className="w-5 h-5 rounded-md grid place-items-center text-[10px] font-bold"
            style={{ background: accent, color: 'var(--sidebar-accent-fg, #fff)' }}
          >
            A
          </div>
          <span className="text-[12px] font-semibold" style={{ color: muted }}>
            acute-agent
          </span>
        </div>
      </div>
      {files.map((node) => (
        <FileTreeItem key={node.id} node={node} />
      ))}
    </div>
  );
}
