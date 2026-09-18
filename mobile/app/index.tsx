/**
 * The router gate — one decision, made once the store read resolves (and
 * re-made if the link falls back to unpaired while we sit here): a stored
 * pairing goes to the tab group's home; anything else goes to pairing.
 */

import { useEffect } from "react";
import { useRouter } from "expo-router";
import { useLink } from "@/link/use-link";

export default function IndexGate() {
  const { ready, status, host } = useLink();
  const router = useRouter();

  useEffect(() => {
    if (!ready) return; // "unpaired" is only a verdict AFTER the store read
    if (host !== null) {
      router.replace("/home");
    } else {
      router.replace("/pairing");
    }
  }, [ready, status, host, router]);

  return null;
}
