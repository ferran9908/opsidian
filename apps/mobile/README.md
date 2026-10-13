# @opsidian/mobile

Expo iPhone prototype with the locally bundled shared CodeMirror editor in a WebView. From the root, run `pnpm dev:mobile`. Native development builds require Xcode and signing. See [setup and required device checks](../../docs/editor-prototype.md). Real-iPhone acceptance is pending.

## Signing

Signing settings are per developer and stay out of the repo. Copy `.env.example` to `.env.local` and set `APPLE_TEAM_ID` to your own Apple team. If your team cannot register `sh.ferran.opsidian`, also set `IOS_BUNDLE_IDENTIFIER`. `app.config.ts` reads both; after changing either, delete the generated `ios` folder and run the build again.
