import {
  QueryCommand,
  type AttributeValue,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { buildMediaTimelineFields, normaliseIsoTimestamp } from "@/app/lib/mediaTimeline";

export type LibraryMediaItem = {
  id: string;
  type: "VIDEO" | "PHOTO";
  contentType?: string;
  originalKey?: string;
  originalBucket?: string;
  originalPhotoKey?: string;
  originalPhotoBucket?: string;
  thumbnailKey?: string;
  thumbnailBucket?: string;
  status?: string;
  size?: number;
  createdAt?: string;
  originalName?: string;
  contentHash?: string;
  captureTime?: string;
  fileLastModified?: string;
  captureLocation?: string;
  captureLat?: number;
  captureLon?: number;
  captureAddress?: string;
  captureCity?: string;
  captureRegion?: string;
  captureCountry?: string;
  captureAlt?: number;
  orientation?: number;
  deviceMake?: string;
  deviceModel?: string;
  deviceSoftware?: string;
  durationSec?: number;
  width?: number;
  height?: number;
  fps?: number;
  bitrate?: number;
  codec?: string;
  rotation?: number;
  liveVideoKey?: string;
  liveVideoBucket?: string;
  liveVideoSize?: number;
  isFavorite?: boolean;
  favoritedAt?: string;
  mediaAt?: string;
  mediaAtSource?: string;
};

type QueryAllMediaInput = {
  ddb: DynamoDBClient;
  tableName: string;
  email: string;
};

type RawItem = Record<string, unknown>;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const isVisibleMediaRecord = (item: RawItem): boolean => {
  const sk = asString(item.sk);
  if (!sk) return false;
  if (!sk.startsWith("VIDEO#") && !sk.startsWith("PHOTO#")) return false;
  return item.status !== "DELETING" && item.status !== "DELETED";
};

export const mapDbMediaItem = (item: RawItem): LibraryMediaItem => {
  const sk = asString(item.sk) || "";
  const type =
    item.type === "PHOTO" || sk.startsWith("PHOTO#")
      ? "PHOTO"
      : "VIDEO";
  const derivedId = sk.includes("#") ? sk.split("#").slice(1).join("#") : sk;
  const id =
    asString(item.videoId) ||
    asString(item.photoId) ||
    derivedId ||
    "";
  const timeline = buildMediaTimelineFields({
    email: asString(item.email) || "",
    mediaType: type,
    mediaId: id,
    captureTime: asString(item.captureTime),
    fileLastModified: asString(item.fileLastModified),
    createdAt: asString(item.createdAt),
  });

  return {
    id,
    type,
    contentType: asString(item.contentType),
    originalKey: asString(item.originalKey),
    originalBucket: asString(item.originalBucket),
    originalPhotoKey: asString(item.originalPhotoKey),
    originalPhotoBucket: asString(item.originalPhotoBucket),
    thumbnailKey: asString(item.thumbnailKey),
    thumbnailBucket: asString(item.thumbnailBucket),
    status: asString(item.status),
    size: asNumber(item.size),
    createdAt: asString(item.createdAt),
    originalName: asString(item.originalName),
    contentHash: asString(item.contentHash),
    captureTime: asString(item.captureTime),
    fileLastModified: asString(item.fileLastModified),
    captureLocation: asString(item.captureLocation),
    captureLat: asNumber(item.captureLat),
    captureLon: asNumber(item.captureLon),
    captureAddress: asString(item.captureAddress),
    captureCity: asString(item.captureCity),
    captureRegion: asString(item.captureRegion),
    captureCountry: asString(item.captureCountry),
    captureAlt: asNumber(item.captureAlt),
    orientation: asNumber(item.orientation),
    deviceMake: asString(item.deviceMake),
    deviceModel: asString(item.deviceModel),
    deviceSoftware: asString(item.deviceSoftware),
    durationSec: asNumber(item.durationSec),
    width: asNumber(item.width),
    height: asNumber(item.height),
    fps: asNumber(item.fps),
    bitrate: asNumber(item.bitrate),
    codec: asString(item.codec),
    rotation: asNumber(item.rotation),
    liveVideoKey: asString(item.liveVideoKey),
    liveVideoBucket: asString(item.liveVideoBucket),
    liveVideoSize: asNumber(item.liveVideoSize),
    isFavorite: item.isFavorite === true,
    favoritedAt: asString(item.favoritedAt),
    mediaAt: normaliseIsoTimestamp(asString(item.mediaAt)) || timeline.mediaAt,
    mediaAtSource: asString(item.mediaAtSource) || timeline.mediaAtSource,
  };
};

const mediaTimestamp = (item: LibraryMediaItem): number =>
  Date.parse(
    item.mediaAt ||
      item.captureTime ||
      item.fileLastModified ||
      item.createdAt ||
      "",
  ) || 0;

export const sortMediaByTimeline = (items: LibraryMediaItem[]): LibraryMediaItem[] =>
  [...items].sort((a, b) => mediaTimestamp(b) - mediaTimestamp(a));

const queryMediaPrefix = async ({
  ddb,
  tableName,
  email,
  prefix,
}: QueryAllMediaInput & { prefix: "VIDEO" | "PHOTO" }) => {
  const items: RawItem[] = [];
  let lastKey: Record<string, AttributeValue> | undefined;

  do {
    const response = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "email = :email AND begins_with(sk, :skPrefix)",
        ExpressionAttributeValues: {
          ":email": { S: email },
          ":skPrefix": { S: `${prefix}#` },
        },
        ExclusiveStartKey: lastKey,
      }),
    );
    items.push(
      ...((response.Items?.map((entry) => unmarshall(entry) as RawItem)) || []),
    );
    lastKey = response.LastEvaluatedKey;
  } while (lastKey);

  return items;
};

export const queryAllMediaForUser = async ({
  ddb,
  tableName,
  email,
}: QueryAllMediaInput): Promise<LibraryMediaItem[]> => {
  const normalizedEmail = email.toLowerCase();
  const [videoItems, photoItems] = await Promise.all([
    queryMediaPrefix({ ddb, tableName, email: normalizedEmail, prefix: "VIDEO" }),
    queryMediaPrefix({ ddb, tableName, email: normalizedEmail, prefix: "PHOTO" }),
  ]);

  return sortMediaByTimeline(
    [...videoItems, ...photoItems]
      .filter(isVisibleMediaRecord)
      .map(mapDbMediaItem),
  );
};
