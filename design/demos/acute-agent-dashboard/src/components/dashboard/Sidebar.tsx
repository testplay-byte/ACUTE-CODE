'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  Settings, Plus, LayoutDashboard, Trash2,
} from 'lucide-react';
import { useDashboardStore, type Project } from '@/lib/dashboard-store';
import { useTheme, bdr, staggerContainer, staggerItem, ease } from '@/lib/dashboard-helpers';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip';
import { Separator } from '@/components/ui/separator';

// ============================================================
// PROJECT ITEM (no hover panel, clean and simple)
// ============================================================
function ProjectItem({ project, isActive, onSelect, onDelete }: {
  project: Project; isActive: boolean; onSelect: () => void; onDelete: () => void;
}) {
  const { isDark, text, muted, accent, hover } = useTheme();
  const letter = project.name.charAt(0).toUpperCase();
  return (
    <motion.div variants={staggerItem}>
      <div
        onClick={onSelect}
        className="group relative px-2.5 py-2 rounded-lg cursor-pointer transition-colors duration-200"
        style={{
          backgroundColor: isActive ? accent + '10' : 'transparent',
          border: bdr('1.5px', isActive ? accent + '30' : 'transparent'),
        }}
        onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLDivElement).style.backgroundColor = hover; }}
        onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLDivElement).style.backgroundColor = 'transparent'; }}
      >
        <div className="flex items-center gap-2.5">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 text-sm font-bold text-white transition-transform duration-200 group-hover:scale-105"
            style={{ backgroundColor: project.color + 'CC' }}
          >
            {letter}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[12px] font-semibold truncate" style={{ color: isActive ? accent : text }}>{project.name}</div>
            <div className="text-[10px] truncate mt-0.5" style={{ color: muted, fontFamily: "var(--font-geist-mono), monospace" }}>{project.path}</div>
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="opacity-0 group-hover:opacity-100 w-6 h-6 rounded-md flex items-center justify-center transition-all duration-150 hover:scale-110 flex-shrink-0 cursor-pointer"
            style={{ color: muted }}
          >
            <Trash2 size={11} />
          </button>
        </div>
      </div>
    </motion.div>
  );
}

// ============================================================
// ADD PROJECT BUTTON (text + icon, dashed border)
// ============================================================
function AddProjectButton() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const addProject = useDashboardStore((s) => s.addProject);
  const { isDark, card, border, text, muted, accent, inputBg } = useTheme();
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) setTimeout(() => nameRef.current?.focus(), 100); }, [open]);
  const handleAdd = useCallback(() => {
    if (name.trim() && path.trim()) { addProject(name.trim(), path.trim()); setName(''); setPath(''); setOpen(false); }
  }, [name, path, addProject]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          className="w-full flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-lg text-[11px] font-semibold transition-all duration-200 cursor-pointer hover:scale-[1.01] active:scale-[0.99]"
          style={{
            backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.025)',
            border: bdr('1.5px', border),
            borderStyle: 'dashed',
            color: muted,
          }}
        >
          <Plus size={12} strokeWidth={2.5} />
          <span>Add Project</span>
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md" style={{ backgroundColor: card, border: bdr('2px', border), borderRadius: '12px' }}>
        <DialogHeader><DialogTitle className="text-base font-bold" style={{ color: text }}>Add New Project</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-3 mt-2">
          <div>
            <label className="text-[11px] font-semibold mb-1.5 block" style={{ color: muted }}>Project Name</label>
            <Input
              ref={nameRef} value={name} onChange={(e) => setName(e.target.value)}
              placeholder="my-awesome-project"
              className="text-sm"
              style={{ backgroundColor: inputBg, border: bdr('1.5px', border), borderRadius: '8px', color: text }}
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            />
          </div>
          <div>
            <label className="text-[11px] font-semibold mb-1.5 block" style={{ color: muted }}>Folder Path</label>
            <Input
              value={path} onChange={(e) => setPath(e.target.value)}
              placeholder="~/projects/my-awesome-project"
              className="text-sm"
              style={{ backgroundColor: inputBg, border: bdr('1.5px', border), borderRadius: '8px', color: text, fontFamily: "var(--font-geist-mono), monospace", fontSize: '12px' }}
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            />
          </div>
          <Button
            onClick={handleAdd} disabled={!name.trim() || !path.trim()}
            className="mt-1 font-semibold text-sm py-2.5"
            style={{ backgroundColor: accent, color: '#fff', borderRadius: '8px', border: 'none', opacity: name.trim() && path.trim() ? 1 : 0.5 }}
          >
            Create Project
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// SIDEBAR CONTENT
// ============================================================
export function SidebarContent({ onMobileSelect }: { onMobileSelect?: () => void }) {
  const selectedProjectId = useDashboardStore((s) => s.selectedProjectId);
  const projects = useDashboardStore((s) => s.projects);
  const selectProject = useDashboardStore((s) => s.selectProject);
  const deleteProject = useDashboardStore((s) => s.deleteProject);
  const goHome = useDashboardStore((s) => s.goHome);
  const { isDark, text, muted, accent, border } = useTheme();

  return (
    <>
      <div className="px-3 pt-3 pb-2 flex items-center gap-2">
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => { goHome(); onMobileSelect?.(); }}
                className="w-7 h-7 rounded-lg flex items-center justify-center transition-all duration-200 cursor-pointer hover:scale-105 active:scale-95"
                style={{
                  backgroundColor: selectedProjectId === null ? accent + '15' : 'transparent',
                  border: bdr('1.5px', selectedProjectId === null ? accent + '30' : 'transparent'),
                  color: selectedProjectId === null ? accent : muted,
                }}
              >
                <LayoutDashboard size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right"><p className="text-xs">Overview</p></TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <h2 className="text-[12px] font-bold flex-1" style={{ color: text }}>Projects</h2>
      </div>
      <Separator className="mx-3" style={{ backgroundColor: border }} />

      <motion.div
        variants={staggerContainer} initial="initial" animate="animate"
        className="flex-1 overflow-y-auto p-1.5 custom-scrollbar flex flex-col gap-0.5"
      >
        {projects.map((p) => (
          <ProjectItem
            key={p.id} project={p} isActive={p.id === selectedProjectId}
            onSelect={() => { selectProject(p.id); onMobileSelect?.(); }}
            onDelete={() => deleteProject(p.id)}
          />
        ))}
      </motion.div>

      <div className="px-2 pb-1.5">
        <AddProjectButton />
      </div>

      <div style={{ borderTop: bdr('1.5px', border) }} className="p-2">
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg transition-colors duration-200 cursor-pointer"
                style={{ color: muted }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.025)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; }}
              >
                <Settings size={14} />
                <span className="text-[12px] font-medium">Settings</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="right"><p className="text-xs">Settings (coming soon)</p></TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </>
  );
}

// ============================================================
// DESKTOP SIDEBAR
// ============================================================
export function DesktopSidebar() {
  const { card, border } = useTheme();
  return (
    <motion.aside
      initial={{ opacity: 0, x: -16 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.35, ease, delay: 0.05 }}
      className="hidden lg:flex w-[260px] xl:w-[280px] flex-shrink-0 flex-col rounded-lg overflow-hidden"
      style={{ backgroundColor: card, border: bdr('1.5px', border) }}
    >
      <SidebarContent />
    </motion.aside>
  );
}

// ============================================================
// MOBILE SIDEBAR
// ============================================================
export function MobileSidebar() {
  const sidebarOpen = useDashboardStore((s) => s.sidebarOpen);
  const setSidebarOpen = useDashboardStore((s) => s.setSidebarOpen);
  const { card, border } = useTheme();
  return (
    <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
      <SheetContent side="left" className="w-[270px] p-0" style={{ backgroundColor: card, borderRight: bdr('1.5px', border) }}>
        <SheetHeader className="sr-only"><SheetTitle>Projects</SheetTitle></SheetHeader>
        <div className="h-full flex flex-col">
          <SidebarContent onMobileSelect={() => setSidebarOpen(false)} />
        </div>
      </SheetContent>
    </Sheet>
  );
}