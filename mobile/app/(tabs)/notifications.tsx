/**
 * Notifications — the S4b placeholder: the notification history feed
 * lands in the feature round.
 */

import { Bell } from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { ComingSoon } from "@/components/coming-soon";

export default function NotificationsScreen() {
  return (
    <ScreenScaffold title="Alerts" back={false}>
      <ComingSoon
        Icon={Bell}
        title="Alerts"
        caption="task completes, failures, permission pings — the agent's history"
      />
    </ScreenScaffold>
  );
}
