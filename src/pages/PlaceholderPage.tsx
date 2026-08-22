import { motion } from "framer-motion";
import { Construction } from "lucide-react";
import { fadeInUp } from "../lib/motion";

/** Titled placeholder for the F9 screens that land in later Phase 2 waves. */
export function PlaceholderPage({
  title,
  spec,
  detail,
}: {
  title: string;
  /** e.g. "F7" — the SPEC feature this screen implements. */
  spec: string;
  detail: string;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b-[1.5px] border-line px-5 py-3.5">
        <h1 className="text-[15px] font-bold tracking-tight">{title}</h1>
        <p className="mt-0.5 text-[11px] text-muted">{spec} · planned for a later Phase 2 wave</p>
      </div>
      <motion.div
        variants={fadeInUp}
        initial="initial"
        animate="animate"
        className="flex flex-1 flex-col items-center justify-center gap-2 text-center"
      >
        <Construction size={20} className="text-muted" />
        <p className="text-[13px] font-semibold">Coming soon</p>
        <p className="max-w-sm text-[11px] text-muted">{detail}</p>
      </motion.div>
    </div>
  );
}
