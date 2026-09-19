<!-- last-reviewed: 2026-09-19 round-109 -->
<!-- status: THE OWNER-FOLLOWABLE SETUP GUIDE for Firebase push (the R109
     ask: "also the Firebase setup properly too, giving me proper highly
     detailed guides"). The desktop's push publisher ships DORMANT (a
     documented no-op until credentials exist — R106's design); completing
     THIS guide is what wakes it up in the next round. The push model is
     PING-ONLY by the owner's ruling: a push carries NO content, just
     "something needs you; ask your desktop" — the app then fetches the
     real approval/notification over the link (LINKING-PROTOCOL §3). -->

# FIREBASE-SETUP.md — push notifications for the Android companion

**What this gives you:** when the desktop needs you (an approval request,
a finished task, a failure) and the app is backgrounded, your phone gets
a real system notification — tap it and the app opens straight to the
thing that needs you. Until now this was the "Alerts" tab you had to open
manually.

**Cost:** free (Firebase Cloud Messaging has no charge at this scale).

**Time:** ~15 minutes, once.

**You need:** a Google account (any), the desktop app (v0.105.0+), and
the Android companion installed.

---

## F1. Create the Firebase project

1. Go to https://console.firebase.google.com → **Add project**.
2. Project name: `acute-code` (anything works — this name is only for
   you). Google Analytics: you can disable it (the app needs none of it;
   fewer data flows, cleaner consent screens). Continue → Create project.
3. You land on the project overview. Note the **Project ID** at the top
   (e.g. `acute-code-3f8c2`) — the console shows it under the project
   name; you'll hand THIS to the orchestrator next session.

## F2. Register the Android app

1. In the project overview: click the **Android robot** icon (Add app →
   Android).
2. **Android package name:** `com.acutecode.companion`
   (EXACTLY this — it is the companion's applicationId; a mismatch is
   the #1 cause of "push silently never arrives").
   App nickname: `ACUTE` (cosmetic). Debug signing certificate SHA-1:
   skip it (push does not require it; Google sign-in would).
3. **Register app** → it offers `google-services.json` to download.
   **Download it** — the Android build will need it NEXT session (it
   maps this Firebase project to our package name). You do NOT need to
   add it anywhere yourself.
4. Continue through the next steps (Firebase's wizard shows gradle
   instructions — IGNORE them; our build wires itself next session when
   you provide the file).

## F3. Create the FCM v1 service-account key (the desktop's credential)

This is the file the DESKTOP uses to SEND pushes (the "server
credential"). v1 is the current Firebase API — the legacy "server key"
is deprecated and the app will never use it.

1. In the Firebase console: **gear icon (Project settings)** → **Service
   accounts** tab.
2. "Firebase Admin SDK" → **Generate new private key** → confirm.
3. A JSON file downloads (e.g. `acute-code-3f8c2-firebase-adminsdk-xxxxx.json`).
   **This file IS the credential — treat it like a password** (anyone
   holding it can send pushes to your app). Store it somewhere private;
   next session you'll place it in the desktop's data directory (the
   guide below says where) or paste its path.
4. Note: if you ever suspect it leaked, come back to the same page and
   **Revoke** + regenerate.

## F4. Where the desktop expects it (next session's wiring)

For reference (you don't do this today — the next round builds the
Settings UI for it):

- The desktop reads `firebase-service-account.json` from the same
  machine data directory where the device-link certificate lives
  (Windows: `%APPDATA%/acute-code/` — the orchestrator will confirm the
  exact path in the round; the Settings → Notifications page gets a
  "Push credentials" picker).
- Presence of that file flips the push publisher from its dormant no-op
  to live: every desktop notification ALSO fires an FCM ping to every
  paired phone (topic-per-device, the device id as the topic name —
  no content beyond "check your desktop", per the ping-only ruling).

## F5. The Android side (what changes in the app next session)

Documented so you know exactly what you're enabling:

- `expo-notifications` + `expo-firebase-analytics`-free wiring (the
  FCM token registration only — no analytics), reading the
  `google-services.json` you downloaded in F2.
- On pairing, the phone sends its FCM token to the desktop (one new
  field on the claim/store surfaces — protocol v1 grows WITHIN v1 per
  the tunnel-ready rule).
- On push arrival: the app fetches the real notification over the link
  (LAN or tunnel) and shows a LOCAL notification with actual content.
  Tapping opens the right screen (approval / session / activity).
- Battery-honest: no background polling — the phone only wakes on push
  or app-open. (If you prefer ZERO Google services, tell the
  orchestrator — the ntfy.sh alternative is the documented no-Google
  path and takes a different, equally short guide.)

## F6. Verify you're ready (the checklist for next session)

- [ ] Firebase project created; Project ID noted: ______________
- [ ] Android app registered with `com.acutecode.companion`
- [ ] `google-services.json` downloaded (keep it — it goes in
      `mobile/` next session)
- [ ] Service-account JSON downloaded and stored somewhere private
      (it goes in the desktop's data directory next session)
- [ ] (Optional but useful now) Install the Firebase console's "Cloud
      Messaging" section bookmark — the delivery graphs there are how
      you'll SEE pushes flowing after the round lands.

## Troubleshooting (mostly for after the next round)

| Symptom | Cause → fix |
|---|---|
| Pushes never arrive | The #1 cause: package name mismatch in F2 — must be `com.acutecode.companion` exactly. The #2: the phone's notifications for the app are disabled system-wide (Android Settings → Apps → ACUTE → Notifications). |
| Pushes arrive but tapping does nothing | App was force-stopped (Android kills deep links for force-stopped apps) — open the app normally; the Alerts tab still shows everything. |
| The desktop says "push is not configured" | The service-account JSON isn't in place (F4) or was revoked — re-place/regenerate. |
| You revoked a key | Regenerate (F3), replace the file, restart the desktop app. The old key is dead the moment you revoke. |

## What to tell the orchestrator in the next session

- "Firebase is ready" + the **Project ID** (never the JSON contents —
  you'll place the files yourself per F4/next session's instructions).
- Whether you chose Firebase push or the ntfy.sh no-Google alternative.
- Whether phone notifications are allowed system-wide (F6).
- Anything that fought back (exact error text).
