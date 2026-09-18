/**
 * Approvals — the S4b placeholder: the approvals inbox (the killer
 * feature — every permission gate, Approve / Deny from the pocket) lands
 * in the feature round.
 */

import { ShieldCheck } from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { ComingSoon } from "@/components/coming-soon";

export default function ApprovalsScreen() {
  return (
    <ScreenScaffold title="Approvals" back={false}>
      <ComingSoon
        Icon={ShieldCheck}
        title="Approvals"
        caption="every permission the agent asks for — one tap to approve or deny"
      />
    </ScreenScaffold>
  );
}
