# Next.js App Router Setup

This project is now configured as a minimal [Next.js](https://nextjs.org/) application using the App Router. It includes TypeScript support and Material UI dependencies.

## .aws
Folder contains aws realted files

## Getting Started

Install dependencies (uses pnpm):

```bash
pnpm install
```

Run the development server:

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) to see the result. You can start editing the UI by modifying files in the `app/` directory; the page auto-updates as you edit the file.

## Available Scripts (pnpm)

- `pnpm dev` – Starts the development server.
- `pnpm build` – Builds the production application.
- `pnpm start` – Runs the production build locally.
- `pnpm lint` – Runs ESLint using the Next.js shareable config.

## Env for Video Upload (server/API)

- `S3_ORIGINAL_BUCKET` – 原始视频桶名称（如 pinhaoyun-original）
- `S3_THUMBNAIL_BUCKET` – 预览视频桶名称（如 pinhaoyun-thumbnail）
- `VIDEOS_TABLE` – DynamoDB 表名（存视频元数据）
- `SQS_VIDEO_INGEST_QUEUE_URL` – 上传完成后入队的 SQS（Lambda ingest 消费）
- `PRESIGN_TTL_SECONDS` – 预签名 URL 有效期（可选，默认 900）

## Project Structure

```
app/
  globals.css      # Global styles applied to the entire app
  layout.tsx       # Root layout shared across routes
  page.tsx         # Home page rendered at the index route
next.config.ts     # Next.js configuration file
```
