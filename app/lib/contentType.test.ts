import { describe, expect, it } from "vitest";
import { guessContentTypeFromFilename, normaliseContentType } from "./contentType";

describe("contentType", () => {
  it("guesses supported photo and video content types from filenames", () => {
    expect(guessContentTypeFromFilename("IMG_001.JPG")).toBe("image/jpeg");
    expect(guessContentTypeFromFilename("image.heic")).toBe("image/heic");
    expect(guessContentTypeFromFilename("image.heif")).toBe("image/heif");
    expect(guessContentTypeFromFilename("clip.mov")).toBe("video/quicktime");
    expect(guessContentTypeFromFilename("clip.m4v")).toBe("video/mp4");
    expect(guessContentTypeFromFilename("clip.hevc")).toBe("video/hevc");
  });

  it("uses filename fallback for generic upload content types", () => {
    expect(normaliseContentType("application/octet-stream", "photo.png")).toBe(
      "image/png",
    );
    expect(normaliseContentType(undefined, "video.mp4")).toBe("video/mp4");
  });

  it("preserves explicit content types and returns undefined for unknown files", () => {
    expect(normaliseContentType(" image/jpeg ", "photo.heic")).toBe("image/jpeg");
    expect(normaliseContentType("application/octet-stream", "archive.zip")).toBe(
      undefined,
    );
    expect(guessContentTypeFromFilename()).toBeUndefined();
  });
});
