/**
 * with-android-release-signing — the companion APK's identity (R108).
 *
 * WHAT IT DOES (string surgery on the prebuilt android/app/build.gradle,
 * anchored to the Expo SDK 57 template's exact shapes — prebuild regenerates
 * the file every CI run, so the anchors must match or the build fails loudly):
 *
 *   1. RELEASE SIGNING — a dedicated PKCS12 keystore (mobile/android-signing/
 *      acute-companion-release.p12, see that folder's README) replaces the
 *      template's `signingConfig signingConfigs.debug` in the release block.
 *      WHY: every CI runner mints a FRESH ~/.android/debug.keystore, so
 *      debug-key-signed artifacts do NOT update in place — each install
 *      forced an uninstall first (INSTALL_FAILED_UPDATE_INCOMPATIBLE). One
 *      stable key = the owner's phone updates v0.104.0 → v0.105.0 in place.
 *
 *   2. ABI SPLITS — `splits { abi { include "arm64-v8a"; universalApk false } }`
 *      (ROUND-109: the owner's ruling — "you do not need to build the
 *      Android universal APK at all… You just need to build the ARM64 v8
 *      version." The universal fallback is GONE; ONE deliverable:
 *        · app-arm64-v8a-release.apk → THE artifact (every Android 10+
 *          phone the owner can hold; emulators/32-bit stragglers are
 *          out of scope by the same ruling)
 *      The v0.103.0 debug APK shipped FOUR ABIs × 25 unstripped .so —
 *      224 of its 302 MiB. R8 + strip + arm64-only lands the split at a
 *      fraction.)
 *
 *   3. THE GRADLE JVM — the template's -XX:MaxMetaspaceSize=512m died
 *      live on the first CI dress rehearsal (OutOfMemoryError: Metaspace
 *      during packageRelease, then a hung daemon until the job timeout);
 *      gradle.properties gets -Xmx4096m + 1g metaspace.
 *
 * LOCAL DEV IS UNAFFECTED in spirit: `expo run:android` still assembles the
 * debug variant (Metro serves JS, debug.keystore signs) — splits produce a
 * per-ABI debug APK too, so run-android installs whichever output it finds
 * first; if that ever bites, `universalApk` is the knob.
 *
 * Registered from mobile/app.json:
 *   "plugins": [ ..., "./plugins/with-android-release-signing" ]
 */

const { withDangerousMod } = require("expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

/** The keystore facts (documented at length in mobile/android-signing/README.md —
 * a self-signed sideload key committed to this PRIVATE repo on purpose;
 * Play-Store-grade key management stays a future ask). */
const KEYSTORE_PATH = "android-signing/acute-companion-release.p12";
const KEYSTORE_PASSWORD = "ACUTE-CODE-companion-v1";
const KEYSTORE_ALIAS = "acute-companion";

// The exact template anchors (verified against the SDK 57 prebuild output).
const ANCHOR_ANDROID_OPEN = "android {\n    ndkVersion rootProject.ext.ndkVersion";
const ANCHOR_SIGNING_DEBUG = "    signingConfigs {\n        debug {";
const ANCHOR_RELEASE_SIG =
  "        release {\n" +
  "            // Caution! In production, you need to generate your own keystore file.\n" +
  "            // see https://reactnative.dev/docs/signed-apk-android.\n" +
  "            signingConfig signingConfigs.debug";

const SPLITS_BLOCK = `
    // R108: ABI splits. ROUND-109: universalApk is FALSE — the owner's
    // ruling kills the universal fallback; the arm64-v8a build is THE one
    // deliverable (smaller artifact, faster attach, nothing unused).
    splits {
        abi {
            reset()
            enable true
            include "arm64-v8a"
            universalApk false
        }
    }
`;

const SIGNING_RELEASE_BLOCK = `
        release {
            // R108: the companion's stable key (mobile/android-signing/) —
            // updates install in place; the runner-minted debug key never
            // could. Keystore facts live in that folder's README.
            storeFile file("../../${KEYSTORE_PATH}")
            storePassword "${KEYSTORE_PASSWORD}"
            keyAlias "${KEYSTORE_ALIAS}"
            keyPassword "${KEYSTORE_PASSWORD}"
            storeType "PKCS12"
        }`;

/** Insert `addition` right after the matched anchor line. */
function insertAfter(source, anchor, addition, label) {
  const at = source.indexOf(anchor);
  if (at < 0) {
    throw new Error(
      `with-android-release-signing: anchor for ${label} not found — the Expo template changed; update the plugin.`,
    );
  }
  // Insert after the anchor's first newline (keeps the anchor's own line intact).
  const lineEnd = source.indexOf("\n", at) + 1;
  return source.slice(0, lineEnd) + addition + source.slice(lineEnd);
}

module.exports = function withAndroidReleaseSigning(config) {
  return withDangerousMod(config, [
    "android",
    (mod) => {
    const gradlePath = path.join(mod.modRequest.projectRoot, "android", "app", "build.gradle");
    let gradle = fs.readFileSync(gradlePath, "utf8");

    // 1. The splits block — rides directly under `android {`.
    if (!gradle.includes("splits {")) {
      gradle = insertAfter(gradle, ANCHOR_ANDROID_OPEN, SPLITS_BLOCK, "android { splits");
    }

    // 2. The release signingConfig — declared next to the debug one.
    if (!gradle.includes('keyAlias "acute-companion"')) {
      gradle = insertAfter(
        gradle,
        ANCHOR_SIGNING_DEBUG,
        SIGNING_RELEASE_BLOCK + "\n",
        "signingConfigs { release",
      );
    }

    // 3. The release buildType USES it (the debug buildType keeps its own line).
    if (gradle.includes(ANCHOR_RELEASE_SIG)) {
      gradle = gradle.replace(
        ANCHOR_RELEASE_SIG,
        ANCHOR_RELEASE_SIG.replace("signingConfigs.debug", "signingConfigs.release"),
      );
    } else if (!gradle.includes("signingConfig signingConfigs.release")) {
      throw new Error(
        "with-android-release-signing: the release buildType's signingConfig line not found — the Expo template changed; update the plugin.",
      );
    }

    // 4. The keystore itself must exist at prebuild time (fail loudly HERE,
    //    not 10 minutes into gradle on the runner).
    const keystorePath = path.join(mod.modRequest.projectRoot, KEYSTORE_PATH);
    if (!fs.existsSync(keystorePath)) {
      throw new Error(
        `with-android-release-signing: keystore missing at ${KEYSTORE_PATH} — see mobile/android-signing/README.md (rotation included).`,
      );
    }

    // 5. The gradle JVM must survive the release pipeline (the R108 dress
    //    rehearsal's live failure): the template's -XX:MaxMetaspaceSize=512m
    //    dies with OutOfMemoryError: Metaspace during packageRelease once
    //    R8 + AGP + the splits packaging share one JVM — and the dying
    //    daemon then hung for 24 minutes until the job timeout. 1g of
    //    metaspace + a 4g heap (runners carry 16g) is the honest floor.
    const gradlePropsPath = path.join(mod.modRequest.projectRoot, "android", "gradle.properties");
    let props = fs.readFileSync(gradlePropsPath, "utf8");
    if (!props.includes("-XX:MaxMetaspaceSize=1024m")) {
      props = props.replace(
        /^org\.gradle\.jvmargs=.*$/m,
        "org.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1024m -XX:+HeapDumpOnOutOfMemoryError",
      );
      fs.writeFileSync(gradlePropsPath, props);
    }

    fs.writeFileSync(gradlePath, gradle);
    return mod;
    },
  ]);
};
