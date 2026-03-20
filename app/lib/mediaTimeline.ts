export type MediaType = "VIDEO" | "PHOTO";
export type MediaAtSource = "capture" | "file" | "upload";

type MediaTimelineInput = {
  email: string;
  mediaType: MediaType;
  mediaId: string;
  captureTime?: string | null;
  fileLastModified?: string | null;
  createdAt?: string | null;
  fallbackNow?: string;
};

const DATE_PREFIX_RE = /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/;

export const normaliseIsoTimestamp = (value?: string | null): string | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
};

export const normaliseDatePrefix = (value?: string | null): string | null => {
  const trimmed = value?.trim() || "";
  if (!trimmed) return null;
  return DATE_PREFIX_RE.test(trimmed) ? trimmed : null;
};

export const resolveMediaAt = ({
  captureTime,
  fileLastModified,
  createdAt,
  fallbackNow,
}: Omit<MediaTimelineInput, "email" | "mediaType" | "mediaId">): {
  mediaAt: string;
  mediaAtSource: MediaAtSource;
} => {
  const captureAt = normaliseIsoTimestamp(captureTime);
  if (captureAt) {
    return { mediaAt: captureAt, mediaAtSource: "capture" };
  }

  const fileAt = normaliseIsoTimestamp(fileLastModified);
  if (fileAt) {
    return { mediaAt: fileAt, mediaAtSource: "file" };
  }

  const uploadAt =
    normaliseIsoTimestamp(createdAt) ||
    normaliseIsoTimestamp(fallbackNow) ||
    new Date().toISOString();

  return { mediaAt: uploadAt, mediaAtSource: "upload" };
};

export const buildTimelineKeys = ({
  email,
  mediaType,
  mediaId,
  mediaAt,
}: {
  email: string;
  mediaType: MediaType;
  mediaId: string;
  mediaAt: string;
}) => {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const normalizedType = mediaType === "PHOTO" ? "PHOTO" : "VIDEO";
  const normalizedId = String(mediaId || "").trim();

  return {
    timelinePk: `USER#${normalizedEmail}`,
    timelineSk: `${mediaAt}#${normalizedType}#${normalizedId}`,
  };
};

export const buildMediaTimelineFields = ({
  email,
  mediaType,
  mediaId,
  captureTime,
  fileLastModified,
  createdAt,
  fallbackNow,
}: MediaTimelineInput) => {
  const { mediaAt, mediaAtSource } = resolveMediaAt({
    captureTime,
    fileLastModified,
    createdAt,
    fallbackNow,
  });
  const { timelinePk, timelineSk } = buildTimelineKeys({
    email,
    mediaType,
    mediaId,
    mediaAt,
  });

  return {
    mediaAt,
    mediaAtSource,
    timelinePk,
    timelineSk,
  };
};

