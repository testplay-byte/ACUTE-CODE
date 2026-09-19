# android-signing — the companion APK's stable key (R108)

## Why this exists

Every GitHub Actions runner mints a **fresh** `~/.android/debug.keystore`, so
debug-key-signed APKs **never update in place** — each install of a new
version failed with `INSTALL_FAILED_UPDATE_INCOMPATIBLE` unless the old app
was uninstalled first. Worse, the debug artifact had **no JS bundle embedded
at all** (debug variants skip bundling by design — they expect a Metro dev
server on `localhost:8081`), which is why v0.103.0 sat on the splash screen
forever on a real phone.

From v0.104.0 the CI builds the **release variant** (JS embedded, R8-minified,
resources shrunk, native libs stripped) and signs it with ONE stable key —
this folder's keystore — so the owner's phone updates in place from now on.

## The key (facts, not secrets)

| Fact         | Value                                                    |
| ------------ | -------------------------------------------------------- |
| File         | `acute-companion-release.p12` (PKCS12)                   |
| Alias        | `acute-companion`                                        |
| Password     | `ACUTE-CODE-companion-v1` (both store + key)             |
| Algorithm    | RSA 2048, self-signed cert (SHA384withRSA)               |
| Validity     | 10,950 days (~30 years, from 2026-09-19)                 |
| Subject      | `CN=ACUTE-CODE Companion, OU=Mobile, O=testplay-byte, C=US` |

This is a **self-signed sideload key committed to a private repo on
purpose**: it guards nothing but update continuity for a side-loaded app,
and keeping it in-repo means any runner (or any fresh clone) can produce a
bit-consistent signing identity with zero secret plumbing. Play-Store-grade
key management (hardware-backed keystore, Play App Signing) stays a future
ask — rotate per below if it ever matters.

`mobile/.gitignore` carries an explicit `!android-signing/*.p12` negation so
the key survives the generic `*.p12` ignore rule.

## Verifying the key

```bash
keytool -list -v -keystore mobile/android-signing/acute-companion-release.p12 \
  -storepass ACUTE-CODE-companion-v1 -storetype PKCS12
```

## Rotating the key (the honest procedure)

1. Generate the successor (keep the SAME alias so gradle needs no change):
   ```bash
   keytool -genkeypair -keystore acute-companion-release-v2.p12 -storetype PKCS12 \
     -alias acute-companion -keyalg RSA -keysize 2048 -validity 10950 \
     -storepass <new-password> -dname "CN=ACUTE-CODE Companion, OU=Mobile, O=testplay-byte, C=US"
   ```
2. Swap the file (and the password in
   `mobile/plugins/with-android-release-signing.js`).
3. Note in the CHANGELOG that the update requires a one-time uninstall —
   Android refuses cross-signature updates by design.
