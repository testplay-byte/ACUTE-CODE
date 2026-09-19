/**
 * The router gate — the one redirect screen: past the wizard? host linked?
 * → the tabs; unpaired → the connection hub; never onboarded → the wizard.
 * Renders null (the splash covers the decision's first frame).
 */

import { router } from "expo-router";
import { useEffect, useState } from "react";
import { useLink } from "@/link/use-link";
import { isOnboarded } from "@/features/onboarding";
import { mobLog } from "@/lib/log";

export default function Gate() {
  const { ready, status, host } = useLink();
  const [onboardingKnown, setOnboardingKnown] = useState(false);
  const [onboarded, setOnboarded] = useState(true);

  // The wizard gate — read once (the flag only changes through completion
  // or the settings' replay action, both of which navigate away).
  useEffect(() => {
    let alive = true;
    void isOnboarded().then((done) => {
      if (!alive) return;
      setOnboarded(done);
      setOnboardingKnown(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!onboardingKnown || !ready) return;
    if (!onboarded) {
      mobLog("boot", "gate → onboarding");
      router.replace("/onboarding/welcome");
      return;
    }
    if (host !== null) {
      mobLog("boot", "gate → tabs");
      router.replace("/home");
      return;
    }
    mobLog("boot", "gate → connect hub");
    router.replace("/connect");
    // status re-runs this when a paired token is revoked (401 fallback).
  }, [onboardingKnown, onboarded, ready, host, status]);

  return null;
}
