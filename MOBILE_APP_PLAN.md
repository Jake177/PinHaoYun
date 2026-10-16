# Mobile implementation status

The iOS client is now implemented as a native SwiftUI application in [Jake177/pinhaoyun_ios](https://github.com/Jake177/pinhaoyun_ios), on the `feat/ios-core` branch. This backend branch supplies verified Cookie/Bearer authentication, `/api/mobile/auth/*`, policy acknowledgement, media URL renewal, resumable/idempotent multipart uploads and lifecycle-aware account erasure.

The original React Native foreground-only proposal has been superseded by the user-approved native iOS plan. Web UI components are preserved. Development uses an isolated Sydney AWS stack, with provisioning and contract documentation in the iOS repository. Production rollout and physical-device validation remain separate release gates.

Run `pnpm typecheck`, `pnpm test` and the repository lint command before review. Real AWS integration scripts live in the companion iOS repository and refuse production resource names.
