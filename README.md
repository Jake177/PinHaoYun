# PinHaoYun

PinHaoYun is a personal cloud video library for uploading, organising, and revisiting memories. It focuses on a lightweight, stable experience: multi-device uploads, automatic thumbnails and metadata, map-based location editing, and safe (asynchronous) deletion.

Built with Next.js on the frontend, and AWS (Lambda/S3/DynamoDB/SQS/Cognito) for storage and background processing.

## Tech Stack

- Frontend: Next.js 16.1.1 , React 19, TypeScript, Material UI
- Backend/API: Next.js Route Handlers + AWS Lambda (Node.js)
- Storage & data: Amazon S3 (originals + thumbnails), DynamoDB 
- Async/background jobs: SQS + Lambda
- Auth: Amazon Cognito (email verification)
- Maps: Mapbox GL + Mapbox Geocoding/Reverse Geocoding
- Optional secrets: AWS Secrets Manager (for Cognito client secret)

## Key Features

- Secure authentication with Cognito sign-up/sign-in, email verification, and profile editing
- Fast, resilient uploads with S3 multipart uploads + presigned URLs (progress UI + concurrent uploads)
- Private media access via short-lived presigned S3 URLs for both originals and thumbnails
- Best-effort duplicate detection via a quick content hash (first chunk + file size) and a DynamoDB hash lock
- Automatic post-upload processing (S3-triggered Lambda):
  - Extracts video metadata (duration, resolution, FPS, codec, bitrate, device info)
  - Generates a thumbnail (ffmpeg) and writes it to the thumbnail bucket
- Location workflows:
  - Auto-enrich address/city/region/country from embedded GPS coordinates (SQS-triggered Lambda + Mapbox)
  - Manual location editing on a map (keeps original coordinates where available)
  - Footprint map view for videos with location data
- Safe deletion workflow (SQS):
  - Marks videos as `DELETING` immediately in DynamoDB
  - Deletes original + thumbnail objects in S3 asynchronously
  - Removes the DynamoDB video record and updates user `usedBytes` and `videosCount`
  - Supports single and batch deletion requests
- Storage quota and reservations:
  - Default quota is 256GB
  - Uploads use a reservation (`reservedBytes`) so concurrent uploads don’t oversubscribe storage
- PWA-ready basics (manifest + icons) so users can add PinHaoYun to the home screen on mobile browsers
- Mobile-friendly preview experience with a draggable metadata bottom sheet and quick actions (download, delete, edit location)

## Repository Layout

```
app/                 Next.js App Router application
  api/               Route Handlers (auth, upload, list, delete, geo, profile, session)
  components/        UI components (uploader, grid, map, profile, auth)
  ui/                Global styles, navbar, fonts
aws/lambda/          AWS Lambda scripts (background jobs)
public/              Static assets (logo, PWA manifest)
messages/            Translation message catalogues (in progress / optional)
```

## Getting Started (Local Development)

### Prerequisites

- Node.js (recommended: Node 20+)
- pnpm
- AWS resources (Cognito, S3, DynamoDB, SQS) and credentials configured in your environment

### Install

```bash
pnpm install
```

### Configure environment variables

Copy the example env file and fill in the placeholders:

```bash
cp .env.example .env.local
```

### Run

```bash
pnpm dev
```

Open http://localhost:3000

## Limits & Defaults

Some behaviour is controlled by hard-coded defaults in the app/Lambda code:

- Max video size: 1GB (`MAX_BYTES` in uploader and API)
- Allowed file types: MOV / MP4 / HEVC / M4V
- Multipart part size: 10MB
- Max concurrent uploads (client): 3
- Default quota: 256GB (`quotaBytes`)
- Upload grace: +1GB above quota (allows a final upload to finish)
- Reservation TTL: 1 day (`expiresAt` on `RESERVE#...` items)
- Presigned URL TTL: 900 seconds by default (`PRESIGN_TTL_SECONDS`)

## Environment Variables

All variables are documented in `.env.example`. The most important ones are:

### Cognito (required for auth)

- `COGNITO_REGION`
- `COGNITO_USER_POOL_ID`
- `COGNITO_CLIENT_ID`
- `COGNITO_CLIENT_SECRET` (either set directly, or load from Secrets Manager; see below)
- `COGNITO_SECRET_ID` (Secrets Manager secret name/ARN; default: `pinhaoyun/secret`)

### Storage & data (required for uploads)

- `S3_ORIGINAL_BUCKET` (original videos)
- `S3_THUMBNAIL_BUCKET` (thumbnails)
- `VIDEOS_TABLE` (DynamoDB table name)
- `USERS_TABLE` (optional; can be the same as `VIDEOS_TABLE`)
- `PRESIGN_TTL_SECONDS` (optional; default 900 seconds)

### Queues (required for background jobs)

- `VIDEOS_DELETE_QUEUE_URL` (SQS queue URL for deletion)
- `LOCATION_ENRICH_QUEUE_URL` (SQS queue URL for location enrichment)

### Mapbox (required for map features)

- `NEXT_PUBLIC_MAPBOX_TOKEN` (client-side Mapbox token for map display)
- `MAPBOX_TOKEN` (optional; server-side token for geocoding APIs; falls back to `NEXT_PUBLIC_MAPBOX_TOKEN`)

### Lambda-specific (optional / depending on which functions you deploy)

- `FFPROBE_PATH` (default `/opt/bin/ffprobe`)
- `FFMPEG_PATH` (default `/opt/bin/ffmpeg`)
- `CLEANUP_PREFIX` (default `video/`)
- `CLEANUP_MAX_KEYS` (default `1000`)
- `CLEANUP_PAGE_SIZE` (default `250`)

## Data Model (DynamoDB)

This project uses a single-table style with:

- Partition key: `email` (string)
- Sort key: `sk` (string)

Common item types:

- `PROFILE` – user quota + usage counters (`quotaBytes`, `usedBytes`, `reservedBytes`, `videosCount`)
- `VIDEO#<videoId>` – video metadata record (S3 keys, status, metadata, location)
- `HASH#<contentHash>` – dedupe lock per user
- `RESERVE#<videoId>` – temporary reservation record during multipart upload

## AWS Setup Notes (High Level)

### S3

- Create two buckets: one for originals and one for thumbnails.
- Ensure your S3 CORS configuration exposes the `ETag` header (multipart upload needs it).
- The app stores originals under `video/<email>/<uuid>_<filename>`.
- Uploads set `StorageClass: INTELLIGENT_TIERING` for original objects.

### Lambda functions (`aws/lambda/`)

- `transcodeVideo.js` (S3 trigger): downloads the uploaded video, runs ffprobe/ffmpeg, generates a thumbnail, updates DynamoDB, and enqueues location enrichment.
  - Requires an ffmpeg/ffprobe Lambda layer (defaults to `/opt/bin/ffmpeg` and `/opt/bin/ffprobe`).
- `enrichLocation.js` (SQS trigger): reverse-geocodes lat/lon via Mapbox and updates address fields in DynamoDB (skips records that were set manually).
- `deleteVideo.js` (SQS trigger): deletes S3 objects and removes DynamoDB records, updating `usedBytes`/`videosCount`.
- `postConfirmation.js` (Cognito trigger): initialises a user `PROFILE` item in DynamoDB on sign-up confirmation.
- `cleanupOrphans.js` (scheduled): deletes S3 objects that no longer have a corresponding DynamoDB video record.

### DynamoDB TTL (recommended)

Reservations include an `expiresAt` (epoch seconds) attribute. Enabling TTL on `expiresAt` helps clean up stale `RESERVE#...` items.

### Secrets Manager (optional, recommended for Amplify/SSR)

If you don’t want to store `COGNITO_CLIENT_SECRET` directly in env vars, create a Secrets Manager secret (default name: `pinhaoyun/secret`) containing either:

- A JSON object with `COGNITO_CLIENT_SECRET`, or
- A plaintext secret value (the client secret itself)

Ensure your hosting/SSR role has `secretsmanager:GetSecretValue` permission for the secret.

## Deployment (AWS Amplify Hosting)

This repository is commonly deployed with AWS Amplify Hosting (SSR). At a high level:

1) Connect the Git repository in Amplify.
2) Use `pnpm install` and `pnpm build` (Amplify typically auto-detects Next.js).
3) Configure all required environment variables in Amplify (see `.env.example`).
4) If you use Secrets Manager for `COGNITO_CLIENT_SECRET`, ensure the Amplify SSR/compute role can call `secretsmanager:GetSecretValue` for your secret.

## Scripts

- `pnpm dev` – start the dev server
- `pnpm build` – production build
- `pnpm start` – run the production build locally
- `pnpm lint` – lint the project

## Licence

MIT – see `LICENSE`.
