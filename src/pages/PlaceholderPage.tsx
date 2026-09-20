import { motion } from "framer-motion";
import { Construction } from "lucide-react";
import { fadeInUp } from "../lib/motion";

/**
 * Titled placeholder for the F9 screens that land in later Phase 2 waves.
 *
 * R113-d (owner: the page headers are "unnecessary, unneeded, and not
 * required"): the border-b title strip is deleted — the 404 is ONE centered
 * minimal card now (the `spec` prop went with the strip; the only live mount
 * is the catch-all route in App.tsx).
 */
export function PlaceholderPage({
  title,
  detail,
}: {
  title: string;
  detail: string;
}) {
  return (
    <motion.div
      variants={fadeInUp}
      initial="initial"
      animate="animate"
      className="flex h-full flex-col items-center justify-center gap-2 text-center"
    >
      <Construction size={20} className="text-muted" />
      <p className="text-[13px] font-semibold">{title}</p>
      <p className="max-w-sm text-[11px] text-muted">{detail}</p>
    </motion.div>
  );
}
