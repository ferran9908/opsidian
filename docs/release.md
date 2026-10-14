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

### Secrets

CI signs with five GitHub Actions secrets: `CSC_LINK` and `CSC_KEY_PASSWORD` (the Developer ID certificate as a `.p12`, and its password), and `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` (the notarisation key). After the setup above, run once from the repository root:

```sh
scripts/ci-secrets.sh
```

It asks for the exported `.p12` and its password, reads the rest from `apps/desktop/.env.local`, and stores them on GitHub. A release without them stops at once and says which are missing.

### From a Mac instead

`pnpm release:mac` builds and publishes the version in `apps/desktop/package.json` from the Mac you run it on, the same way. It is for when CI is unavailable; set a version CI has not used. The release is made as a draft first and published only once every file is uploaded; if a run fails, run it again and it reuses the draft. The commit must be pushed first, since the release is tagged at it. `pnpm package:mac` builds without publishing, into `apps/desktop/release/`. Without credentials it makes an unsigned app, which runs only on the Mac that built it.

## Updates

An installed copy checks for a new version when it starts and every six hours. It downloads in the background and installs when Opsidian quits. A hosting Mac rarely quits, so once a version is ready, the Opsidian menu and the menu bar icon offer **Restart to Update**. **Opsidian → Check for Updates…** checks at once. A copy run from the repository never updates.

Updating requires the new version to be signed by the same team as the installed one.

## The app's own data

Settings, hosting data and device credentials are in `~/Library/Application Support/Opsidian`, for an installed copy and for `pnpm dev:desktop` alike. Notebooks are wherever their folders are.
