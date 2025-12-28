import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typedRoutes: true,
  env: {
    COGNITO_REGION: process.env.COGNITO_REGION,
    COGNITO_USER_POOL_ID: process.env.COGNITO_USER_POOL_ID,
    COGNITO_CLIENT_ID: process.env.COGNITO_CLIENT_ID,
    COGNITO_CLIENT_SECRET: process.env.COGNITO_CLIENT_SECRET,
    VIDEOS_TABLE: process.env.VIDEOS_TABLE,
    S3_ORIGINAL_BUCKET: process.env.S3_ORIGINAL_BUCKET,
    S3_THUMBNAIL_BUCKET: process.env.S3_THUMBNAIL_BUCKET,
  },
};

export default nextConfig;
