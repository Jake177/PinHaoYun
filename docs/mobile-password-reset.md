# Password reset confirmation

Cognito invokes the post-confirmation trigger for `ConfirmForgotPassword` as well as signup confirmation. The reset callback previously attempted to create the user's existing `PROFILE` with a create-only conditional write. Cognito consequently returned `UserLambdaValidationException` with `PostConfirmation failed with error The conditional request failed`; the mobile endpoint showed the generic `Authentication failed` message.

`postConfirmation` now returns `PostConfirmation_ConfirmForgotPassword` events without writing account data. Signup still creates the subject-bound profile with its existing conditional write. A reset cannot zero storage counters, change the plan or recreate a deleted profile. The mobile three-page reset flow remains unchanged: Cognito validates the code while saving the new password.

Reference: [Cognito post-confirmation trigger](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-post-confirmation.html).

## Validation on 12 October 2026

- All 50 backend tests passed, including four callback lifecycle cases covering reset, missing profile configuration, signup defaults and collision protection.
- TypeScript checking and linting of the changed files passed.
- Updated only the `pinhaoyun-ios-dev-postConfirmation` Lambda code in `ap-southeast-2`. The isolated API container and production resources were not deployed.
- Invoked the deployed reset callback against an existing, confirmed disposable QA account. It returned HTTP 200 without a function error and returned its event unchanged. A consistent DynamoDB read before and after had an identical canonical profile digest, including counters and plan fields.
- Deployed ZIP SHA-256 (base64): `NzSZHZfckSWdGAeQm6JBGDVgugjx0joNbUoegZKD4z4=`.
- The real-device email-code → save → sign-in check remains pending tester confirmation. A direct trigger invocation does not establish that full flow.

The code hotfix used a new versioned development artifact and a guarded single-function update. The next complete deployment through the iOS repository's `scripts/deploy-staging.mjs` must package this fixed source; it will replace the hotfix artifact reference through CloudFormation. Local deployment/proof records are kept in ignored `build/password-reset/` files in the iOS workspace.
