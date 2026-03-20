import { NextResponse } from "next/server";
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

const region = process.env.COGNITO_REGION || "ap-southeast-2";
const tableName = process.env.VIDEOS_TABLE;
const timelineIndexName = process.env.TIMELINE_INDEX_NAME?.trim() || "";

const ddb = new DynamoDBClient({ region });

type MonthFacet = {
  value: string;
  count: number;
};

type YearFacet = {
  value: string;
  count: number;
};

const buildFacets = (items: LibraryMediaItem[]) => {
  const years = new Map<string, number>();
  const monthsByYear = new Map<string, Map<string, number>>();

  items.forEach((item) => {
    const mediaAt = item.mediaAt || "";
    const year = mediaAt.slice(0, 4);
    const month = mediaAt.slice(5, 7);
    if (!/^\d{4}$/.test(year)) return;

    years.set(year, (years.get(year) || 0) + 1);

    if (/^\d{2}$/.test(month)) {
      const yearMonths = monthsByYear.get(year) || new Map<string, number>();
      yearMonths.set(month, (yearMonths.get(month) || 0) + 1);
      monthsByYear.set(year, yearMonths);
    }
  });

  const yearList: YearFacet[] = Array.from(years.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([value, count]) => ({ value, count }));

  const monthMap = Object.fromEntries(
    Array.from(monthsByYear.entries()).map(([year, monthCounts]) => [
      year,
      Array.from(monthCounts.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([value, count]) => ({ value, count })) satisfies MonthFacet[],
    ]),
  ) as Record<string, MonthFacet[]>;

  return {
    years: yearList,
    monthsByYear: monthMap,
  };
};

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

export async function GET() {
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

    const facets = buildFacets(items);
    return NextResponse.json({
      ...facets,
      totalCount: items.length,
    });
  } catch (error: any) {
    console.error("[videos/facets] error", error);
    return NextResponse.json(
      { error: error?.message || "Failed to fetch video facets" },
      { status: 500 },
    );
  }
}
