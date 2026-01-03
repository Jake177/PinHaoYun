import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import {
  CognitoIdentityProviderClient,
  GetUserCommand,
  UpdateUserAttributesCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { decodeIdToken } from "@/app/lib/jwt";

const region = process.env.COGNITO_REGION || "ap-southeast-2";
const usersTable = process.env.USERS_TABLE;

const ddb = new DynamoDBClient({ region });
const cognito = new CognitoIdentityProviderClient({ region });

// GET: Fetch user profile (Cognito attributes + DynamoDB stats)
export async function GET() {
  try {
    const cookieStore = await cookies();
    const idToken = cookieStore.get("id_token")?.value;
    const accessToken = cookieStore.get("access_token")?.value;

    if (!idToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const payload = decodeIdToken(idToken) as Record<string, unknown>;
    const email = (payload.email as string)?.toLowerCase();

    if (!email) {
      return NextResponse.json({ error: "Missing email" }, { status: 401 });
    }

    // Get Cognito user attributes using access token
    let cognitoAttributes: Record<string, string> = {};
    if (accessToken) {
      try {
        const cognitoUser = await cognito.send(
          new GetUserCommand({ AccessToken: accessToken })
        );
        cognitoUser.UserAttributes?.forEach((attr) => {
          if (attr.Name && attr.Value) {
            cognitoAttributes[attr.Name] = attr.Value;
          }
        });
      } catch (err) {
        console.warn("[profile] Failed to get Cognito attributes:", err);
        // Fall back to ID token claims
        cognitoAttributes = {
          email: payload.email as string,
          given_name: payload.given_name as string,
          family_name: payload.family_name as string,
          preferred_username: payload.preferred_username as string,
          gender: payload.gender as string,
        };
      }
    }

    // Get DynamoDB profile for stats
    let dbProfile: Record<string, unknown> = {};
    if (usersTable) {
      try {
        const result = await ddb.send(
          new GetItemCommand({
            TableName: usersTable,
            Key: {
              email: { S: email },
              sk: { S: "PROFILE" },
            },
          })
        );
        if (result.Item) {
          dbProfile = unmarshall(result.Item);
        }
      } catch (err) {
        console.warn("[profile] Failed to get DynamoDB profile:", err);
      }
    }

    return NextResponse.json({
      // Cognito attributes
      email: cognitoAttributes.email || email,
      givenName: cognitoAttributes.given_name || "",
      familyName: cognitoAttributes.family_name || "",
      preferredUsername: cognitoAttributes.preferred_username || "",
      gender: cognitoAttributes.gender || "",
      // DynamoDB stats
      quotaBytes: dbProfile.quotaBytes || 256 * 1024 * 1024 * 1024, // 256GB default
      usedBytes: dbProfile.usedBytes || 0,
      videosCount: dbProfile.videosCount || 0,
      createdAt: dbProfile.createdAt || null,
    });
  } catch (error: any) {
    console.error("[profile] GET error:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to fetch profile" },
      { status: 500 }
    );
  }
}

// PUT: Update user profile (Cognito attributes only)
export async function PUT(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const accessToken = cookieStore.get("access_token")?.value;
    const idToken = cookieStore.get("id_token")?.value;

    if (!accessToken || !idToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json()) as {
      givenName?: string;
      familyName?: string;
      preferredUsername?: string;
      gender?: string;
    };

    const updates: { Name: string; Value: string }[] = [];

    if (body.givenName !== undefined) {
      updates.push({ Name: "given_name", Value: body.givenName });
    }
    if (body.familyName !== undefined) {
      updates.push({ Name: "family_name", Value: body.familyName });
    }
    if (body.preferredUsername !== undefined) {
      updates.push({ Name: "preferred_username", Value: body.preferredUsername });
    }
    if (body.gender !== undefined) {
      updates.push({ Name: "gender", Value: body.gender });
    }

    if (updates.length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    }

    await cognito.send(
      new UpdateUserAttributesCommand({
        AccessToken: accessToken,
        UserAttributes: updates,
      })
    );

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("[profile] PUT error:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to update profile" },
      { status: 500 }
    );
  }
}
