import { motion } from "framer-motion";
import { Bot, MessageSquare, Settings, Terminal } from "lucide-react";
import type { ThemeStyles } from "../../lib/themes";
import { scaleIn } from "../../lib/motion";
import { useProjects } from "../../hooks/use-projects";

/**
 * Quick actions (round-21, de-costumed R100-G): 16px-radius card
 * (rounded-2xl) with softShadow, label-tier header, action buttons with
 * solid accent icons and the CSS hover:bg-hover wash (the wizard hover
 * physics — translate-x + bentoShadowSm scale — are deleted per TOKENS §6:
 * resting UI never fidgets). The primary action is an accent-filled pill.
 *
 * ROUND-48 (R48-a): the primary no longer targets /sessions — the Sessions
 * screen left the sidebar nav (owner: "remove the sessions section
 * completely"), so the flagship quick action is now the workspace
 * continuation: "Continue in <newest project>" opens that project's chat,
 * where the composer starts the next session (the chat panel auto-creates
 * one on the first message — the /sessions manager was never on that path).
 * With no projects yet the primary row is hidden: the add-project flow lives
 * in the sidebar's Projects section, not on a route.
 */
const SECONDARY_ACTIONS = [
  { label: "Manage agents", to: "/settings?tab=agents", icon: Bot },
  { label: "Open settings", to: "/settings", icon: Settings },
] as const;

export function QuickActions({
  onNavigate,
  styles,
}: {
  onNavigate: (to: string) => void;
  styles: ThemeStyles;
}) {
  const { card, border, text, accent, accentText, softShadow } = styles;

  // Newest project first (the live backend lists created_at DESC; the demo
  // fixture returns seed order). Shared query key — no extra fetch.
  const latestProject = (useProjects().data ?? [])[0];
  const actions = [
    ...(latestProject
      ? [
          {
            label: `Continue in ${latestProject.name}`,
            to: `/project/${latestProject.id}/chat`,
            icon: MessageSquare,
            primary: true,
          },
        ]
      : []),
    ...SECONDARY_ACTIONS.map((action) => ({ ...action, primary: false })),
  ];

  return (
    <motion.div
      variants={scaleIn}
      className="rounded-2xl border-[1.5px] p-4 md:p-5"
      style={{ backgroundColor: card, borderColor: border, boxShadow: softShadow }}
    >
      <div className="mb-3 flex items-center gap-2.5">
        <Terminal size={13} style={{ color: accent }} strokeWidth={2} />
        <span className="text-[11px] font-medium uppercase tracking-[0.08em]" style={{ color: text }}>
          Quick Actions
        </span>
      </div>
      <div className="flex flex-col gap-2">
        {actions.map(({ label, to, icon: Icon, primary }) => (
          <button
            key={to}
            onClick={() => onNavigate(to)}
            className={primary ? "w-full cursor-pointer rounded-full h-12 px-5 flex items-center gap-2.5 text-[13px] font-semibold transition-colors duration-150" : "w-full cursor-pointer rounded-xl border-[1.5px] h-11 px-4 flex items-center gap-2.5 text-[13px] font-medium transition-colors duration-150 bg-subtle hover:bg-hover"}
            style={
              primary
                ? {
                    backgroundColor: accent,
                    color: accentText,
                    border: `1.5px solid ${accent}`,
                  }
                : {
                    borderColor: border,
                    color: text,
                  }
            }
          >
            <Icon size={primary ? 15 : 13} strokeWidth={2} style={{ color: primary ? accentText : accent, opacity: 1 }} />
            {label}
          </button>
        ))}
      </div>
    </motion.div>
  );
}
