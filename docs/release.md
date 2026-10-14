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

1. Raise `version` in `apps/desktop/package.json`. Installed copies update only to a higher version.
2. From the repository root:

   ```sh
   pnpm release:mac
   ```

   This builds the app, signs it, sends it to Apple for notarisation (a few minutes), and publishes `v<version>` on GitHub with both `.dmg` files, both `.zip` files and `latest-mac.yml`.

   The `.dmg` files are named without the version, `Opsidian-arm64.dmg` and `Opsidian-x64.dmg`, so `https://github.com/ferran9908/opsidian/releases/latest/download/Opsidian-arm64.dmg` always downloads the newest. The `.zip` files keep the version, for the updater.

3. Commit the version change.

`pnpm package:mac` does the same without publishing, into `apps/desktop/release/`. Without credentials it makes an unsigned app, which runs only on the Mac that built it.

## Updates

An installed copy checks for a new version when it starts and every six hours. It downloads in the background and installs when Opsidian quits. A hosting Mac rarely quits, so once a version is ready, the Opsidian menu and the menu bar icon offer **Restart to Update**. **Opsidian → Check for Updates…** checks at once. A copy run from the repository never updates.

Updating requires the new version to be signed by the same team as the installed one.

## The app's own data

Settings, hosting data and device credentials are in `~/Library/Application Support/Opsidian`, for an installed copy and for `pnpm dev:desktop` alike. Notebooks are wherever their folders are.
