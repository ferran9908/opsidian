# Releasing the Mac app

The Mac app is packaged with electron-builder (`apps/desktop/electron-builder.yml`): a signed, notarised `.dmg` for Apple silicon and one for Intel, and a `.zip` of each that installed copies update from. Releases are published on the project's GitHub releases page, where installed copies look for updates.

## Once per Mac that makes releases

1. **A Developer ID Application certificate.** In Xcode, open Settings → Accounts, choose the team, then Manage Certificates → + → Developer ID Application. Only the team's Account Holder can make one. It goes into the login keychain, where packaging finds it by itself. `security find-identity -v -p codesigning` lists it.
2. **An App Store Connect API key,** for notarisation. In App Store Connect, open Users and Access → Integrations → App Store Connect API, and add a team key with the App Manager role, which also allows TestFlight uploads. Download the `.p8` file (it can be downloaded only once) into `~/.appstoreconnect/private_keys/`.
3. **`apps/desktop/.env.local`,** which git ignores:

   ```sh
   APPLE_API_KEY=/Users/you/.appstoreconnect/private_keys/AuthKey_ABC123XYZ.p8
   APPLE_API_KEY_ID=ABC123XYZ
   APPLE_API_ISSUER=00000000-0000-0000-0000-000000000000
   ```

   The key ID is in the key's row; the issuer ID is above the list of keys.

4. **The GitHub CLI, signed in** (`gh auth status`). Its login is used to upload the release.

## Making a release

Every push to `main` is a release, when it changes something the Mac app is built from (`apps/desktop`, the shared packages, the host code it embeds, the logo or the lockfile). `.github/workflows/release.yml`:

1. **Check:** formatting, typecheck and unit tests, on Linux. Nothing is released unless they pass.
2. **Mac app,** on a macOS runner: stamps the version, builds both architectures, signs, notarises, and publishes `v<version>` on GitHub with both `.dmg` files, both `.zip` files and `latest-mac.yml`. The release is a draft until every file is uploaded.

The version is `<major>.<minor>.<run number>`: `<major>.<minor>` comes from `apps/desktop/package.json`, which stays at `.0`, and the run number only grows, so every release is newer than the last, which updates need. The stamp is never committed. To start 0.2, set `version` to `0.2.0`. A push that only changes docs releases nothing; **Run workflow** on the Actions page releases the current `main` anyway.

Releases run one at a time, in push order, and a running one is never cancelled.

Notarising is done by `apps/desktop/packaging/notarize.cjs`, after signing: it submits the app to Apple and waits, then staples Apple's ticket to it. Stapling reaches Apple's ticket service, which sometimes drops the connection, so it is tried six times over about five minutes. If it still fails the release goes ahead with a warning: the app is notarised either way, and macOS checks with Apple online the first time it is opened. A failed notarisation stops the release.

### Secrets

CI signs with five GitHub Actions secrets: `CSC_LINK` and `CSC_KEY_PASSWORD` (the Developer ID certificate as a `.p12`, and its password), and `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` (the notarisation key). After the setup above, run once from the repository root:

```sh
scripts/ci-secrets.sh
```

It asks for the exported `.p12` and its password, reads the rest from `apps/desktop/.env.local`, and stores them on GitHub. A release without them stops at once and says which are missing.

### From a Mac instead

`pnpm release:mac` builds and publishes the version in `apps/desktop/package.json` from the Mac you run it on, the same way. It is for when CI is unavailable; set a version CI has not used. The release is made as a draft first and published only once every file is uploaded; if a run fails, run it again and it reuses the draft. The commit must be pushed first, since the release is tagged at it. `pnpm package:mac` builds without publishing, into `apps/desktop/release/`. Without credentials it makes an unsigned app, which runs only on the Mac that built it.

## Updates

An installed copy checks for a new version 15 seconds after it opens and every four hours. It reads `latest-mac.yml` from `github.com/ferran9908/opsidian/releases/latest/download/`, an address that always points to the newest release. (GitHub's list of releases, which electron-updater reads by default, is cached for minutes and named the previous version just after a release.)

The update is in one state at a time, kept by the app's main process and shown everywhere from that one copy: **available** → **downloading** (with progress) → **ready**, or an **error**. A notice in the corner of the window offers it: **Download now**, then progress, then **Restart now**. An offer or an error can be put away; a download and a waiting restart cannot. **Settings → Updates** shows the version you have and the same state. **Opsidian → Check for Updates…** checks where you can see the answer, opening the window if it is closed. The app menu and the menu bar icon also offer the next step, and a notification says when a version is ready, for a Mac that is only hosting.

A later check never interrupts a download or a waiting restart, a check that fails with nothing on offer stays quiet, and "You’re on the latest version" is said only when it is true. The rules are `nextUpdate` in `packages/core/src/update.ts`, with tests. A copy run from the repository never updates.

Updating requires the new version to be signed by the same team as the installed one.

## Quitting

The window waits, before closing, only for what has said it has work to save: the editor, while it is open. Every other screen closes at once. A page that has stopped answering gets ten seconds. `pnpm test:desktop` quits from the welcome screen, the editor with unsaved typing, Settings, and a stopped page, and requires the app to end each time.

## iPhone

Builds are made by EAS (Expo's build service) and sent to TestFlight; changes that touch only JavaScript reach installed apps over the air. The `iphone` job in `.github/workflows/release.yml` runs `scripts/ship-iphone.sh` after every push that changes the app (`apps/mobile`, the shared packages, the editor's page):

- The **fingerprint** is a hash of the app's native side (`runtimeVersion: { policy: 'fingerprint' }` in `app.config.ts`).
- If a finished TestFlight build has the same fingerprint, the change is **sent over the air** (`eas update`, channel `production`). Apps pick it up the next time they open.
- If none has it, the native side changed: a **new build** is made and submitted to TestFlight (`eas build --auto-submit`). Build numbers are kept by EAS and count up by themselves. While that build runs, over-the-air updates wait for the next push.
- Raising `version` in `app.config.ts` also makes a new build.

The job runs on Linux, as T3 Code's does, because the fingerprint must be worked out the same way as on EAS. Without an `EXPO_TOKEN` secret it is skipped with a note.

### Once

1. **An Expo account,** and on this Mac: `npx eas-cli login`. Then `cd apps/mobile && npx eas-cli init` makes the EAS project; put its id in `projectId` in `app.config.ts`.
2. **The app in App Store Connect:** Apps → + → New App, iOS, named Opsidian Notes (the store name; "Opsidian" was taken, and the name under the icon stays Opsidian), bundle ID `sh.ferran.opsidian.app` (`sh.ferran.opsidian` belongs to another team; register it under Certificates, IDs & Profiles → Identifiers first if it is not offered), any SKU. Put its Apple ID (the number under App Information) in `eas.json` as `submit.production.ios.ascAppId`.
3. **Signing, held by EAS:** `cd apps/mobile && npx eas-cli credentials -p ios`, profile `production`. Sign in with Apple and let EAS make the distribution certificate and provisioning profile. Under App Store Connect API Key, add the same key the Mac app notarises with, so EAS can submit builds.
4. **A token for CI:** expo.dev → Account settings → Access tokens → Create, then `gh secret set EXPO_TOKEN -R ferran9908/opsidian` and paste it.

The next push that changes the app then makes the first TestFlight build. In App Store Connect → TestFlight, add yourself to an internal group to get every build at once; a public link for others needs Apple's beta review of the first build of each version.

## The app's own data

Settings, hosting data and device credentials are in `~/Library/Application Support/Opsidian`, for an installed copy and for `pnpm dev:desktop` alike. Notebooks are wherever their folders are.
