export type FavoriteMediaType = "VIDEO" | "PHOTO";

export type FavoriteMediaItem = {
  id: string;
  type: FavoriteMediaType;
};

type FavoriteRequestItem = {
  id?: string;
  type?: FavoriteMediaType;
  mediaId?: string;
  mediaType?: FavoriteMediaType;
  videoId?: string;
  photoId?: string;
};

export type FavoriteRequestBody = FavoriteRequestItem & {
  isFavorite?: boolean;
  items?: FavoriteRequestItem[];
};

const normaliseType = (type: unknown, photoId?: string): FavoriteMediaType =>
  type === "PHOTO" || photoId ? "PHOTO" : "VIDEO";

export function normaliseFavoriteRequest(body: FavoriteRequestBody) {
  if (typeof body.isFavorite !== "boolean") {
    throw new Error("Missing favorite state");
  }

  const collected: FavoriteMediaItem[] = [];
  const pushItem = (item: FavoriteRequestItem) => {
    const id = String(
      item.mediaId || item.id || item.videoId || item.photoId || "",
    ).trim();
    if (!id) return;
    collected.push({
      id,
      type: normaliseType(item.mediaType || item.type, item.photoId),
    });
  };

  if (Array.isArray(body.items)) {
    body.items.forEach(pushItem);
  }
  pushItem(body);

  return {
    isFavorite: body.isFavorite,
    items: Array.from(
      new Map(collected.map((item) => [`${item.type}:${item.id}`, item])).values(),
    ),
  };
}
