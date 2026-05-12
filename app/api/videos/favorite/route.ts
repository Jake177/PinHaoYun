import { NextResponse } from "next/server";
import {
  DynamoDBClient,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { getSessionUser } from "@/app/lib/sessionUser";
import {
  normaliseFavoriteRequest,
  type FavoriteRequestBody,
} from "@/app/lib/mediaFavorite";

const region = process.env.COGNITO_REGION || "ap-southeast-2";
const tableName = process.env.VIDEOS_TABLE;

const ddb = new DynamoDBClient({ region });

export async function POST(request: Request) {
  try {
    if (!tableName) {
      return NextResponse.json(
        { error: "Missing table configuration" },
        { status: 500 },
      );
    }

    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let parsed: ReturnType<typeof normaliseFavoriteRequest>;
    try {
      parsed = normaliseFavoriteRequest(
        (await request.json().catch(() => ({}))) as FavoriteRequestBody,
      );
    } catch (error: any) {
      return NextResponse.json(
        { error: error?.message || "Invalid favorite request" },
        { status: 400 },
      );
    }

    if (parsed.items.length === 0) {
      return NextResponse.json({ error: "Missing media id" }, { status: 400 });
    }

    const now = new Date().toISOString();
    const email = user.email.toLowerCase();

    for (let i = 0; i < parsed.items.length; i += 25) {
      const chunk = parsed.items.slice(i, i + 25);
      try {
        await ddb.send(
          new TransactWriteItemsCommand({
            TransactItems: chunk.map((item) => {
              const sk = `${item.type}#${item.id}`;
              return {
                Update: {
                  TableName: tableName,
                  Key: {
                    email: { S: email },
                    sk: { S: sk },
                  },
                  ConditionExpression: "attribute_exists(sk)",
                  UpdateExpression: parsed.isFavorite
                    ? "SET isFavorite = :isFavorite, favoritedAt = :now, updatedAt = :now"
                    : "SET updatedAt = :now REMOVE isFavorite, favoritedAt",
                  ExpressionAttributeValues: {
                    ...(parsed.isFavorite
                      ? { ":isFavorite": { BOOL: true } }
                      : {}),
                    ":now": { S: now },
                  },
                },
              };
            }),
          }),
        );
      } catch (error: any) {
        if (error?.name === "TransactionCanceledException") {
          return NextResponse.json(
            { error: "Media not found" },
            { status: 404 },
          );
        }
        throw error;
      }
    }

    return NextResponse.json({
      ok: true,
      count: parsed.items.length,
      isFavorite: parsed.isFavorite,
      favoritedAt: parsed.isFavorite ? now : null,
    });
  } catch (error: any) {
    console.error("[videos/favorite] error", error);
    return NextResponse.json(
      { error: error?.message || "Failed to update favorite state" },
      { status: 500 },
    );
  }
}
