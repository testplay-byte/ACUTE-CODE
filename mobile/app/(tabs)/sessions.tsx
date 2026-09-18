/**
 * Sessions — the S4b placeholder: the session list per project, the full
 * transcript rehydrate, and the live SSE stream land in the feature round.
 */

import { MessageSquare } from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { ComingSoon } from "@/components/coming-soon";

export default function SessionsScreen() {
  return (
    <ScreenScaffold title="Sessions" back={false}>
      <ComingSoon
        Icon={MessageSquare}
        title="Sessions"
        caption="transcripts, live streaming, send / stop / queue — the remote chat"
      />
    </ScreenScaffold>
  );
}
