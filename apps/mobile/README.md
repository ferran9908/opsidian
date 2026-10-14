# @opsidian/mobile

The iPhone app: one notebook, with the shared editor in a web view and the same notebook and sync code as the Mac. From the repository root, `pnpm ios` builds and installs it on a connected iPhone, and `pnpm dev:mobile` starts the development server. See [what it does and how it is built](../../docs/iphone.md).

## Signing

Signing settings are per developer and stay out of the repo. Copy `.env.example` to `.env.local` and set `APPLE_TEAM_ID` to your own Apple team. If your team cannot register `sh.ferran.opsidian`, also set `IOS_BUNDLE_IDENTIFIER`. `app.config.ts` reads both; after changing either, delete the generated `ios` folder and run the build again.
