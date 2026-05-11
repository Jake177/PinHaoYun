import { describe, expect, it } from "vitest";
import {
  buildMediaTimelineFields,
  buildTimelineKeys,
  normaliseDatePrefix,
  normaliseIsoTimestamp,
  resolveMediaAt,
} from "./mediaTimeline";

describe("mediaTimeline", () => {
  it("normalises valid date prefixes and rejects invalid filters", () => {
    expect(normaliseDatePrefix("2026")).toBe("2026");
    expect(normaliseDatePrefix("2026-05")).toBe("2026-05");
    expect(normaliseDatePrefix("2026-05-11")).toBe("2026-05-11");
    expect(normaliseDatePrefix(" 2026-05 ")).toBe("2026-05");
    expect(normaliseDatePrefix("2026-5")).toBeNull();
    expect(normaliseDatePrefix("latest")).toBeNull();
    expect(normaliseDatePrefix("")).toBeNull();
  });

  it("normalises parseable timestamps to ISO strings", () => {
    expect(normaliseIsoTimestamp("2026-05-11T10:30:00+10:00")).toBe(
      "2026-05-11T00:30:00.000Z",
    );
    expect(normaliseIsoTimestamp("not-a-date")).toBeNull();
    expect(normaliseIsoTimestamp(null)).toBeNull();
  });

  it("prefers capture time, then file time, then upload time", () => {
    expect(
      resolveMediaAt({
        captureTime: "2026-05-11T01:00:00Z",
        fileLastModified: "2026-05-10T01:00:00Z",
        createdAt: "2026-05-09T01:00:00Z",
      }),
    ).toEqual({
      mediaAt: "2026-05-11T01:00:00.000Z",
      mediaAtSource: "capture",
    });

    expect(
      resolveMediaAt({
        captureTime: "invalid",
        fileLastModified: "2026-05-10T01:00:00Z",
        createdAt: "2026-05-09T01:00:00Z",
      }),
    ).toEqual({
      mediaAt: "2026-05-10T01:00:00.000Z",
      mediaAtSource: "file",
    });

    expect(
      resolveMediaAt({
        captureTime: null,
        fileLastModified: null,
        createdAt: "2026-05-09T01:00:00Z",
      }),
    ).toEqual({
      mediaAt: "2026-05-09T01:00:00.000Z",
      mediaAtSource: "upload",
    });
  });

  it("builds stable lower-case user timeline keys", () => {
    expect(
      buildTimelineKeys({
        email: "User@Example.COM ",
        mediaType: "PHOTO",
        mediaId: "abc123",
        mediaAt: "2026-05-11T00:30:00.000Z",
      }),
    ).toEqual({
      timelinePk: "USER#user@example.com",
      timelineSk: "2026-05-11T00:30:00.000Z#PHOTO#abc123",
    });
  });

  it("combines timeline timestamp and key fields", () => {
    expect(
      buildMediaTimelineFields({
        email: "user@example.com",
        mediaType: "VIDEO",
        mediaId: "video-1",
        fileLastModified: "2026-05-10T12:00:00Z",
      }),
    ).toEqual({
      mediaAt: "2026-05-10T12:00:00.000Z",
      mediaAtSource: "file",
      timelinePk: "USER#user@example.com",
      timelineSk: "2026-05-10T12:00:00.000Z#VIDEO#video-1",
    });
  });
});
