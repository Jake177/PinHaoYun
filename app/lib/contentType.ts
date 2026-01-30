export function guessContentTypeFromFilename(name?: string): string | undefined {
  const lower = (name || "").toLowerCase();

  // Photos
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".heic")) return "image/heic";
  if (lower.endsWith(".heif")) return "image/heif";

  // Videos
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".mp4") || lower.endsWith(".m4v")) return "video/mp4";
  if (lower.endsWith(".hevc")) return "video/hevc";

  return undefined;
}

export function normaliseContentType(
  input: string | undefined,
  filenameHint?: string,
): string | undefined {
  const cleaned = (input || "").trim();
  if (cleaned && cleaned !== "application/octet-stream") return cleaned;
  return guessContentTypeFromFilename(filenameHint);
}

