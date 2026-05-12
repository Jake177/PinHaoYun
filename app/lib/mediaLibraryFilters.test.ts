import { describe, expect, it } from "vitest";
import {
  buildLibraryFacets,
  filterMediaItems,
  normaliseFavoriteFilter,
  normaliseMediaTypeFilter,
} from "./mediaLibraryFilters";
import type { LibraryMediaItem } from "./mediaLibrary";

const items: LibraryMediaItem[] = [
  {
    id: "photo-1",
    type: "PHOTO",
    originalName: "Beach Sunrise.heic",
    captureCity: "Sydney",
    captureCountry: "Australia",
    deviceMake: "Apple",
    deviceModel: "iPhone 15 Pro",
    mediaAt: "2026-05-01T10:00:00.000Z",
    isFavorite: true,
    favoritedAt: "2026-05-02T00:00:00.000Z",
  },
  {
    id: "video-1",
    type: "VIDEO",
    originalName: "birthday-party.mov",
    captureAddress: "Wynyard Station",
    captureRegion: "NSW",
    deviceMake: "Sony",
    mediaAt: "2025-12-20T08:00:00.000Z",
  },
  {
    id: "photo-2",
    type: "PHOTO",
    originalName: "family.png",
    captureCity: "Melbourne",
    deviceModel: "Pixel 9",
    mediaAt: "2025-01-05T07:00:00.000Z",
  },
];

describe("mediaLibraryFilters", () => {
  it("normalises supported query filters", () => {
    expect(normaliseMediaTypeFilter("photo")).toBe("PHOTO");
    expect(normaliseMediaTypeFilter("VIDEO")).toBe("VIDEO");
    expect(normaliseMediaTypeFilter("all")).toBeNull();
    expect(normaliseFavoriteFilter("true")).toBe(true);
    expect(normaliseFavoriteFilter("false")).toBe(false);
    expect(normaliseFavoriteFilter("")).toBeNull();
  });

  it("filters media by search text across names, places, and devices", () => {
    expect(filterMediaItems(items, { query: "sydney" }).map((item) => item.id)).toEqual([
      "photo-1",
    ]);
    expect(filterMediaItems(items, { query: "sony" }).map((item) => item.id)).toEqual([
      "video-1",
    ]);
    expect(filterMediaItems(items, { query: "party" }).map((item) => item.id)).toEqual([
      "video-1",
    ]);
  });

  it("combines type, favorite, and date-prefix filters", () => {
    expect(
      filterMediaItems(items, {
        mediaType: "PHOTO",
        favorite: true,
        datePrefix: "2026",
      }).map((item) => item.id),
    ).toEqual(["photo-1"]);

    expect(
      filterMediaItems(items, {
        mediaType: "PHOTO",
        favorite: false,
        datePrefix: "2025",
      }).map((item) => item.id),
    ).toEqual(["photo-2"]);
  });

  it("builds year and month facets from the filtered result set", () => {
    const filtered = filterMediaItems(items, { query: "station" });

    expect(buildLibraryFacets(filtered)).toEqual({
      years: [
        { value: "2025", count: 1 },
      ],
      monthsByYear: {
        "2025": [{ value: "12", count: 1 }],
      },
    });
  });
});
