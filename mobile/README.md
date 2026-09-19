# ACUTE — the Android companion

The phone-side half of the device link (docs/planning/LINKING-PROTOCOL.md):
remote view + input for the desktop agent. Expo (SDK 57) + expo-router,
React 19, TypeScript; the custom `modules/acute-net` native module carries
the pinned-TLS fetch + SSE stream in OkHttp.

- Package: `com.acutecode.companion` · minSdk 29 (Android 10+)
- Built ONLY by GitHub Actions (`.github/workflows/mobile.yml`) — the owner's
  rule: APKs are never built on a local machine.
- Two release APKs per tag: `_android-arm64.apk` (THE artifact — every
  Android 10+ phone) and `_android-universal.apk` (fallback for emulators
  and 32-bit stragglers).
- Signing: the stable repo key in `android-signing/` (its README has the
  facts + the rotation procedure) — updates install in place.

## Debugging on a device (Android Studio Logcat)

The app prints its whole startup trail as `[ACUTE-BOOT] …` lines under the
`ReactNativeJS` tag, fatal errors included (`[ACUTE-BOOT] ERROR …` + stack),
and a crash also renders its own on-device screen (error + trail + retry).

**The filter to paste into Android Studio's Logcat query box:**

```
package:com.acutecode.companion
```

That single line shows everything the app itself emits — JS console logs
(`ReactNativeJS`), the boot trail, and the app's native/runtime crashes
(`AndroidRuntime`, `ExpoModules`, OkHttp) — nothing else from the system.

Variants worth knowing:

| Goal                                   | Filter                                                            |
| -------------------------------------- | ----------------------------------------------------------------- |
| Everything from the app (the default) | `package:com.acutecode.companion`                                 |
| Only JS console + boot trail           | `tag:ReactNativeJS`                                               |
| Only the boot trail                    | `tag:ReactNativeJS message~:\[ACUTE-BOOT\]`                       |
| Only errors, any tag                  | `package:com.acutecode.companion level:ERROR`                     |
| Crash + JS + Expo natives              | `package:com.acutecode.companion tag~:AndroidRuntime\|ExpoModules\|ReactNativeJS` |

(paste that last one as: `package:com.acutecode.companion tag~:AndroidRuntime|ExpoModules|ReactNativeJS`)

Command-line equivalent (adb):

```bash
adb logcat --pid=$(adb shell pidof -s com.acutecode.companion) | grep ACUTE-BOOT
```

## Reading a stuck boot

If the app ever sits on the logo again: the trail's LAST line is how far it
got (`js-module-eval` → `boot-error-hook-installed` → `root-mounted` →
`splash-hidden`). Anything past `ERROR` is the full stack, same session.

## Everyday commands

```bash
npm ci            # install (standalone npm workspace — outside pnpm)
npm test          # the jest suite (pure-logic TS, no native bridge)
npm run typecheck
npx expo start    # Metro dev server (debug builds fetch JS from here)
```
