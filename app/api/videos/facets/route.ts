import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  DynamoDBClient,
  QueryCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { decodeIdToken } from "@/app/lib/jwt";
import {
  mapDbMediaItem,
  queryAllMediaForUser,
  type LibraryMediaItem,
} from "@/app/lib/mediaLibrary";
import {
  buildLibraryFacets,
  filterMediaItems,
  normaliseFavoriteFilter,
  normaliseMediaTypeFilter,
  type LibraryFilterOptions,
} from "@/app/lib/mediaLibraryFilters";

const region = process.env.COGNITO_REGION || "ap-southeast-2";
const tableName = process.env.VIDEOS_TABLE;
const timelineIndexName = process.env.TIMELINE_INDEX_NAME?.trim() || "";

const ddb = new DynamoDBClient({ region });

const listFacetsViaTimelineIndex = async (email: string) => {
  const items: LibraryMediaItem[] = [];
  let lastEvaluatedKey: Record<string, AttributeValue> | undefined;

  do {
    const response = await ddb.send(
      new QueryCommand({
        TableName: tableName!,
        IndexName: timelineIndexName,
        KeyConditionExpression: "timelinePk = :timelinePk",
        ExpressionAttributeValues: {
          ":timelinePk": { S: `USER#${email}` },
        },
        ScanIndexForward: false,
        ExclusiveStartKey: lastEvaluatedKey,
        Limit: 200,
      }),
    );

    items.push(
      ...((response.Items?.map((entry) =>
        mapDbMediaItem(unmarshall(entry) as Record<string, unknown>),
      )) || []).filter(
        (item) => item.status !== "DELETING" && item.status !== "DELETED",
      ),
    );
    lastEvaluatedKey = response.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return items;
};

export async function GET(request: NextRequest) {
  try {
    if (!tableName) {
      return NextResponse.json(
        { error: "Missing table configuration" },
        { status: 500 },
      );
    }

    const cookieStore = await cookies();
    const token = cookieStore.get("id_token")?.value;
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const payload = decodeIdToken(token) as Record<string, unknown>;
    const email =
      (payload.email as string) ||
      (payload["cognito:username"] as string) ||
      (payload.sub as string);
    if (!email) {
      return NextResponse.json({ error: "Missing user id" }, { status: 401 });
    }

    const filters: LibraryFilterOptions = {
      query: request.nextUrl.searchParams.get("q"),
      mediaType: normaliseMediaTypeFilter(request.nextUrl.searchParams.get("type")),
      favorite: normaliseFavoriteFilter(
        request.nextUrl.searchParams.get("favorite"),
      ),
    };
    let items: LibraryMediaItem[] | null = null;

    if (timelineIndexName) {
      try {
        items = await listFacetsViaTimelineIndex(email.toLowerCase());
      } catch (error: any) {
        console.warn("[videos/facets] Timeline index query failed, falling back", {
          name: error?.name,
          message: error?.message,
        });
      }
    }

    if (!items) {
      items = await queryAllMediaForUser({
        ddb,
        tableName,
        email: email.toLowerCase(),
      });
    }

    const filteredItems = filterMediaItems(items, filters);
    const facets = buildLibraryFacets(filteredItems);
    return NextResponse.json({
      ...facets,
      totalCount: filteredItems.length,
    });
  } catch (error: any) {
    console.error("[videos/facets] error", error);
    return NextResponse.json(
      { error: error?.message || "Failed to fetch video facets" },
      { status: 500 },
    );
  }
}
