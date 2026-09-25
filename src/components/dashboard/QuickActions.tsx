import { Bot, MessageSquare, Settings } from "lucide-react";
import { SectionCard } from "../ui/SectionCard";
import { useProjects } from "../../hooks/use-projects";
import { useThemeStyles } from "../../lib/use-theme-styles";

/**
 * Quick actions — R126-3a (the Instrument archetype): the card rides
 * `ui/SectionCard` with the CLAY material (the 1px warm rim + `.ac-clay`
 * shadow via the className override — TOKENS §5/§9; the 1.5px bento border
 * and the inline softShadow retire) and a Kicker-tier header.
 *
 * The button grammar is COMPONENTS §4's quiet-solid clay family:
 * · ONE primary per screen (the mobile law, adopted): the workspace
 *   continuation CTA — `bg-accent-deep` fill (the Tailwind leg) + the
 *   accentText pair via the JS leg (`styles.accentText` — TOKENS §1d's
 *   documented route for the pair: the @theme leg never gained a
 *   `--color-accent-text` mapping, so a `text-accent-text` class would be
 *   a PHANTOM that paints no ink), h-9, `rounded-lg`, font-semibold 13px.
 *   No glow, no gradient, no hover-scale (the R120 verdict stands); the
 *   press is the CSS `active:scale-[0.98]`.
 * · Secondary actions: the outlined species — 1px `border-strong` +
 *   secondary ink (`text-muted` — the utility spelling of
 *   `--ac-text-secondary`), same radius/height, font-semibold (the weight
 *   law: buttons are 600 — the mobile QuietButton's semibold), hover
 *   `bg-subtle`.
 *
 * ROUND-48 (R48-a): the primary never targets /sessions — the Sessions
 * screen left the sidebar nav (owner: "remove the sessions section
 * completely"), so the flagship quick action is the workspace continuation:
 * "Continue in <newest project>" opens that project's chat, where the
 * composer starts the next session. With no projects yet the primary row is
 * hidden: the add-project flow lives in the sidebar's Projects section, not
 * on a route.
 */
const SECONDARY_ACTIONS = [
  { label: "Manage agents", to: "/settings?tab=agents", icon: Bot },
  { label: "Open settings", to: "/settings", icon: Settings },
] as const;

export function QuickActions({
  onNavigate,
}: {
  onNavigate: (to: string) => void;
}) {
  // Newest project first (the live backend lists created_at DESC; the demo
  // fixture returns seed order). Shared query key — no extra fetch.
  const latestProject = (useProjects().data ?? [])[0];
  // The accentText ink rides the JS leg (see the header — no Tailwind
  // spelling exists for the pair; a text-accent-text class paints nothing).
  const styles = useThemeStyles();
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
    <SectionCard
      ariaLabel="Quick actions"
      className="h-full border border-clay-rim ac-clay"
      kicker="Quick Actions"
    >
      {/* SCREENS §3's rhythm law: 12px row gaps inside a section card. */}
      <div className="flex flex-col gap-3">
        {actions.map(({ label, to, icon: Icon, primary }) => (
          <button
            key={to}
            type="button"
            onClick={() => onNavigate(to)}
            className={
              primary
                ? // The quiet-solid clay primary (COMPONENTS §4) — the
                  // screen's one accent-filled action; the label ink is the
                  // accentText pair (inline JS leg — the icon inherits it).
                  "flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg bg-accent-deep px-4 text-[13px] font-semibold transition-transform active:scale-[0.98]"
                : // The outlined secondary species — border-strong +
                  // secondary ink; hover is the bg-subtle wash (a class,
                  // never a JS handler — TOKENS §6, at the 80–120ms instant
                  // tier).
                  "flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg border border-line-strong px-4 text-[13px] font-semibold text-muted transition-colors duration-100 hover:bg-subtle active:scale-[0.98]"
            }
            style={primary ? { color: styles.accentText } : undefined}
          >
            <Icon size={14} strokeWidth={2} className="shrink-0" aria-hidden />
            {label}
          </button>
        ))}
      </div>
    </SectionCard>
  );
}
