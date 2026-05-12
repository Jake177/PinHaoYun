import { describe, expect, it } from "vitest";
import { normaliseFavoriteRequest } from "./mediaFavorite";

describe("mediaFavorite", () => {
  it("normalises single and batch favorite requests into unique media items", () => {
    expect(
      normaliseFavoriteRequest({
        mediaId: "photo-1",
        mediaType: "PHOTO",
        items: [
          { id: "video-1", type: "VIDEO" },
          { mediaId: "video-1", mediaType: "VIDEO" },
          { photoId: "photo-2" },
        ],
        isFavorite: true,
      }),
    ).toEqual({
      isFavorite: true,
      items: [
        { id: "video-1", type: "VIDEO" },
        { id: "photo-2", type: "PHOTO" },
        { id: "photo-1", type: "PHOTO" },
      ],
    });
  });

  it("defaults unknown media type to VIDEO and requires an explicit favorite boolean", () => {
    expect(normaliseFavoriteRequest({ videoId: "abc", isFavorite: false })).toEqual({
      isFavorite: false,
      items: [{ id: "abc", type: "VIDEO" }],
    });
    expect(() => normaliseFavoriteRequest({ videoId: "abc" })).toThrow(
      "Missing favorite state",
    );
  });
});
