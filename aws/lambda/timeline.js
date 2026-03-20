"use strict";

const DATE_PREFIX_RE = /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/;

const normaliseIsoTimestamp = (value) => {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
};

const normaliseDatePrefix = (value) => {
  const trimmed = String(value || "").trim();
  if (!trimmed) return null;
  return DATE_PREFIX_RE.test(trimmed) ? trimmed : null;
};

const resolveMediaAt = ({
  captureTime,
  fileLastModified,
  createdAt,
  fallbackNow,
}) => {
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

const buildTimelineKeys = ({ email, mediaType, mediaId, mediaAt }) => {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const normalizedType = mediaType === "PHOTO" ? "PHOTO" : "VIDEO";
  const normalizedId = String(mediaId || "").trim();

  return {
    timelinePk: `USER#${normalizedEmail}`,
    timelineSk: `${mediaAt}#${normalizedType}#${normalizedId}`,
  };
};

const buildMediaTimelineFields = ({
  email,
  mediaType,
  mediaId,
  captureTime,
  fileLastModified,
  createdAt,
  fallbackNow,
}) => {
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

module.exports = {
  buildMediaTimelineFields,
  buildTimelineKeys,
  normaliseDatePrefix,
  normaliseIsoTimestamp,
  resolveMediaAt,
};
