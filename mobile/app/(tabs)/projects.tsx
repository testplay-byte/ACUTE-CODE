/**
 * Projects — the S4b placeholder: the project list, per-project detail,
 * and the shared-element push into a session land in the feature round.
 */

import { Folder } from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { ComingSoon } from "@/components/coming-soon";

export default function ProjectsScreen() {
  return (
    <ScreenScaffold title="Projects" back={false}>
      <ComingSoon
        Icon={Folder}
        title="Projects"
        caption="every project the agent can see, browsed from your pocket"
      />
    </ScreenScaffold>
  );
}
