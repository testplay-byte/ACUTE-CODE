/**
 * with-android-apk-installer — the companion's in-app APK update plumbing
 * (R124, the owner's "update functionality for the Android application…
 * download the latest version and be able to install the APK").
 *
 * WHAT IT DOES (two surgical additions to the prebuilt Android project):
 *
 *   1. ANDROIDMANIFEST — the REQUEST_INSTALL_PACKAGES uses-permission (the
 *      install-time manifest grant; Android 8+ additionally gates the act
 *      behind the per-app "Install unknown apps" RUNTIME toggle, which the
 *      module's canRequestInstalls()/openInstallPermissionSettings() handle
 *      honestly) + the FileProvider declaration under <application>:
 *      androidx.core.content.FileProvider with authority
 *      ${applicationId}.acuteinstaller, NOT exported, granting URI
 *      permissions, its FILE_PROVIDER_PATHS meta-data pointing at our own
 *      res/xml/acute_installer_paths.xml. A DEDICATED authority — never
 *      ${applicationId}.fileprovider — so this plugin can never collide
 *      with a library that assumes the conventional authority.
 *
 *   2. RES/XML — acute_installer_paths.xml, the FileProvider path whitelist:
 *      exactly ONE cache-path entry (name "updates", path "updates/") — the
 *      same directory AcuteInstallerModule.kt writes downloads into. The
 *      provider can share NOTHING else: not files/, not external storage,
 *      not the whole cache — the smallest hole that does the job.
 *
 * WHY A CONFIG PLUGIN: prebuild regenerates android/ from app.json on every
 * CI run, so hand edits to AndroidManifest.xml would be lost; the plugin
 * re-applies them deterministically. The permission ALSO appears in
 * app.json's android.permissions list (Expo's own idiomatic surface) — the
 * plugin tolerates the duplicate (never adds it twice).
 *
 * Registered from mobile/app.json:
 *   "plugins": [ ..., "./plugins/with-android-apk-installer" ]
 */

const { withAndroidManifest, withDangerousMod } = require("expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

/** The manifest addition is idempotent by these anchors. */
const PERMISSION_NAME = "android.permission.REQUEST_INSTALL_PACKAGES";
const AUTHORITY_SUFFIX = ".acuteinstaller";
const PATHS_RES_NAME = "acute_installer_paths";
const PROVIDER_NAME = "androidx.core.content.FileProvider";

/** The FileProvider path whitelist — exactly the module's download dir. */
const PATHS_XML = `<?xml version="1.0" encoding="utf-8"?>
<!-- acute-installer (R124): the FileProvider whitelist for the in-app APK
     update flow. ONE cache-path — the exact directory
     AcuteInstallerModule.kt writes downloads into (cacheDir/updates/).
     Nothing else is shareable through this provider. -->
<paths xmlns:android="http://schemas.android.com/apk/res/android">
    <cache-path
        name="acute_updates"
        path="updates/" />
</paths>
`;

/** withAndroidManifest: add the uses-permission + the provider element. */
const withManifest = (config) => {
  return withAndroidManifest(config, async (config) => {
    const manifest = config.modResults;

    // ── 1. the uses-permission (skip when Expo's permissions list already
    //       added it — app.json carries REQUEST_INSTALL_PACKAGES too). ──
    const permissions = manifest.manifest["uses-permission"] ?? [];
    const alreadyHasPermission = permissions.some(
      (p) => p?.$?.["android:name"] === PERMISSION_NAME
    );
    if (!alreadyHasPermission) {
      permissions.push({ $: { "android:name": PERMISSION_NAME } });
      manifest.manifest["uses-permission"] = permissions;
    }

    // ── 2. the FileProvider under <application> (skip if ours is there). ──
    const application = manifest.manifest.application?.[0];
    if (!application) {
      throw new Error(
        "with-android-apk-installer: the prebuilt manifest has no <application> element — the anchor is gone; refusing to guess."
      );
    }
    // The authority MUST equal what AcuteInstallerModule.kt builds at
    // runtime (context.packageName + ".acuteinstaller"). app.json's
    // android.package is the authoritative source of that name; the
    // manifest's own package attribute (when present) is the same value.
    const authority = `${config.android?.package ?? application.$?.["package"] ?? "com.acutecode.companion"}${AUTHORITY_SUFFIX}`;
    const providers = application.provider ?? [];
    const alreadyHasProvider = providers.some(
      (p) => p?.$?.["android:authorities"] === authority
    );
    if (!alreadyHasProvider) {
      providers.push({
        $: {
          "android:name": PROVIDER_NAME,
          "android:authorities": authority,
          "android:exported": "false",
          "android:grantUriPermissions": "true",
        },
        "meta-data": [
          {
            $: {
              "android:name": "android.support.FILE_PROVIDER_PATHS",
              "android:resource": `@xml/${PATHS_RES_NAME}`,
            },
          },
        ],
      });
      application.provider = providers;
    }

    return config;
  });
};

/** withDangerousMod: write res/xml/acute_installer_paths.xml. */
const withPathsResource = (config) => {
  // R124 hotfix: withDangerousMod's second argument is the [platform, action]
  // TUPLE — a bare function throws "function is not iterable" at prebuild
  // (the first CI compile caught it; the signing plugin's own spelling is
  // the verified pattern).
  return withDangerousMod(config, [
    "android",
    async (config) => {
      const resDir = path.join(
        config._internal?.projectRoot ?? ".",
        "android",
        "app",
        "src",
        "main",
        "res",
        "xml"
      );
      fs.mkdirSync(resDir, { recursive: true });
      fs.writeFileSync(path.join(resDir, `${PATHS_RES_NAME}.xml`), PATHS_XML);
      return config;
    },
  ]);
};

module.exports = (config) => withPathsResource(withManifest(config));
