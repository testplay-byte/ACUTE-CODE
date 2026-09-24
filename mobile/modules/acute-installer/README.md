# acute-installer

The ACUTE companion's native APK-update floor — a **local Expo module**
(autolinked from `mobile/modules/`, never installed from a registry).

## Why it exists (R124)

The owner's ruling: "within the Android application, there should be an
option to easily update it and download the latest version and be able to
install the APK." React Native's JS surface can neither stream a ~57 MB APK
to disk nor fire the Android package-install intent — one small Kotlin
module carries **both**, so an APK never crosses the JS bridge:

| Function | Purpose |
|---|---|
| `downloadApk({url, headers?, fileName}) → Promise<{path, size}>` | streaming OkHttp download into the app's **private cache** (`cacheDir/updates/`), live `progress` events (throttled to ~1% steps) |
| `cancelDownload() → Promise<boolean>` | the honest stop button (the in-flight promise rejects with code `"canceled"`; the partial file is deleted) |
| `installApk({path}) → Promise<void>` | hands the cached APK to the **OS package installer** through a FileProvider content URI (`ACTION_VIEW` + `application/vnd.android.package-archive` + `FLAG_GRANT_READ_URI_PERMISSION`) |
| `canRequestInstalls() → Promise<boolean>` | the honest Android 8+ "Install unknown apps" runtime-grant probe |
| `openInstallPermissionSettings() → Promise<boolean>` | one tap to this app's page in the system's grant screen |

Single-flight by design: a second `downloadApk` while one runs rejects
with code `"busy"` — the updater UI is one APK at a time.

## The manifest side (`plugins/with-android-apk-installer.js`)

The module needs two things prebuild cannot infer, so a config plugin adds
them to the generated Android project on every build:

1. `REQUEST_INSTALL_PACKAGES` in `AndroidManifest.xml` (the install-time
   manifest grant — the runtime side of which `canRequestInstalls()` probes).
2. A `FileProvider` (`androidx.core.content.FileProvider`, authority
   `${applicationId}.acuteinstaller` — deliberately NOT the conventional
   `.fileprovider`, so no library collision is possible) whose path
   whitelist (`res/xml/acute_installer_paths.xml`) contains EXACTLY ONE
   `cache-path` entry: `updates/` — the same directory the module writes
   into. The provider can share nothing else.

## Why a separate module (not a third function on acute-net)

acute-net's whole identity is the TOFU pin — every byte to the **desktop**
rides pinned TLS. An APK comes from GitHub over ordinary public-CA TLS;
bolting that onto the pinned floor would dilute its one job. This module
uses OkHttp's **default** verification (standard CAs), like a browser
download, and says so here.

## The JS surface (`index.ts`)

```ts
import { AcuteInstaller } from "../../modules/acute-installer";
// …or, from src/, through src/update/installer-floor.ts — the SINGLE
// runtime import site (the native-transport.ts discipline).
```

The app layer never imports this module directly:
`src/update/updater.ts` owns the policy (anonymous-first checks, the
optional token, the retry legs); `app/settings/update.tsx` is the screen.

## Dependencies

Same discipline as acute-net: OkHttp arrives transitively via React
Native's `api` dependency (RN 0.86 pins 4.9.x) — `compileOnly` in
`build.gradle`; androidx.core (FileProvider) likewise ships with every
Expo app. The module forces no versions onto the app's dependency graph.
