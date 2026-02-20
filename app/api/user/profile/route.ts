import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import {
  CognitoIdentityProviderClient,
  GetUserCommand,
  UpdateUserAttributesCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { decodeIdToken } from "@/app/lib/jwt";

const region = process.env.COGNITO_REGION || "ap-southeast-2";
const usersTable = process.env.VIDEOS_TABLE || process.env.USERS_TABLE;
const profileBucket = process.env.S3_PROFILE_BUCKET;
const profileUrlExpiresInSeconds = Number(process.env.PRESIGN_TTL_SECONDS || 900);

const MAX_BIO_CHARS = 200;
const MAX_SIGNATURE_BYTES = 300 * 1024; // 300KB

const ddb = new DynamoDBClient({ region });
const cognito = new CognitoIdentityProviderClient({ region });
const s3 = new S3Client({ region });

type SignatureAction = "KEEP" | "REPLACE" | "DELETE";

const SIGNATURE_DATA_URL_RE = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const parseSignatureDataUrl = (value?: string): Buffer | null => {
  if (!value) return null;
  const match = value.match(SIGNATURE_DATA_URL_RE);
  if (!match) return null;
  const encoded = match[1];
  if (!encoded) return null;
  try {
    const bytes = Buffer.from(encoded, "base64");
    return bytes.length > 0 ? bytes : null;
  } catch {
    return null;
  }
};

const signGetUrl = async (
  bucket?: string,
  key?: string,
): Promise<string | null> => {
  if (!bucket || !key) return null;
  try {
    return await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: profileUrlExpiresInSeconds },
    );
  } catch (error) {
    console.warn("[profile] Failed to sign signature URL", error);
    return null;
  }
};

// GET: Fetch user profile (Cognito attributes + DynamoDB stats + profile extras)
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

    // Fall back to token claims, then overwrite by Cognito GetUser if available.
    let cognitoAttributes: Record<string, string> = {
      email: (payload.email as string) || email,
      given_name: (payload.given_name as string) || "",
      family_name: (payload.family_name as string) || "",
      preferred_username: (payload.preferred_username as string) || "",
      gender: (payload.gender as string) || "",
    };

    if (accessToken) {
      try {
        const cognitoUser = await cognito.send(
          new GetUserCommand({ AccessToken: accessToken }),
        );
        cognitoUser.UserAttributes?.forEach((attr) => {
          if (attr.Name && attr.Value) {
            cognitoAttributes[attr.Name] = attr.Value;
          }
        });
      } catch (err) {
        console.warn("[profile] Failed to get Cognito attributes:", err);
      }
    }

    // Get DynamoDB profile for stats + bio/signature metadata.
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
          }),
        );
        if (result.Item) {
          dbProfile = unmarshall(result.Item);
        }
      } catch (err) {
        console.warn("[profile] Failed to get DynamoDB profile:", err);
      }
    }

    const signatureKey = asString(dbProfile.signatureKey);
    const signatureBucket = asString(dbProfile.signatureBucket) || profileBucket;
    const signatureUrl = await signGetUrl(signatureBucket, signatureKey);

    return NextResponse.json({
      // Cognito attributes
      email: cognitoAttributes.email || email,
      givenName: cognitoAttributes.given_name || "",
      familyName: cognitoAttributes.family_name || "",
      preferredUsername: cognitoAttributes.preferred_username || "",
      gender: cognitoAttributes.gender || "",
      // DynamoDB profile extras
      bio: asString(dbProfile.bio) || "",
      signatureUrl,
      hasSignature: Boolean(signatureKey),
      signatureUpdatedAt: asString(dbProfile.signatureUpdatedAt) || null,
      // DynamoDB stats
      quotaBytes: dbProfile.quotaBytes || 256 * 1024 * 1024 * 1024, // 256GB default
      usedBytes: dbProfile.usedBytes || 0,
      photoBytes: dbProfile.photoBytes || 0,
      videoBytes: dbProfile.videoBytes || 0,
      videosCount: dbProfile.videosCount || 0,
      photoCount: dbProfile.photoCount || 0,
      createdAt: dbProfile.createdAt || null,
    });
  } catch (error: any) {
    console.error("[profile] GET error:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to fetch profile" },
      { status: 500 },
    );
  }
}

// PUT: Update profile basics + optional bio + optional signature
export async function PUT(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const accessToken = cookieStore.get("access_token")?.value;
    const idToken = cookieStore.get("id_token")?.value;

    if (!accessToken || !idToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const payload = decodeIdToken(idToken) as Record<string, unknown>;
    const email =
      ((payload.email as string) ||
        (payload["cognito:username"] as string) ||
        (payload.sub as string) || "")
        .toLowerCase()
        .trim();

    if (!email) {
      return NextResponse.json({ error: "Missing email" }, { status: 401 });
    }

    const body = (await request.json()) as {
      givenName?: string;
      familyName?: string;
      preferredUsername?: string;
      gender?: string;
      bio?: string;
      signatureAction?: SignatureAction;
      signatureDataUrl?: string;
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

    const bio = typeof body.bio === "string" ? body.bio : undefined;
    if (bio !== undefined && bio.length > MAX_BIO_CHARS) {
      return NextResponse.json(
        { error: `Bio must be ${MAX_BIO_CHARS} characters or fewer.` },
        { status: 400 },
      );
    }

    const signatureAction: SignatureAction =
      body.signatureAction === "REPLACE" || body.signatureAction === "DELETE"
        ? body.signatureAction
        : "KEEP";

    let nextSignatureBytes: Buffer | null = null;
    if (signatureAction === "REPLACE") {
      nextSignatureBytes = parseSignatureDataUrl(body.signatureDataUrl);
      if (!nextSignatureBytes) {
        return NextResponse.json(
          { error: "Signature must be a valid PNG." },
          { status: 400 },
        );
      }
      if (nextSignatureBytes.length > MAX_SIGNATURE_BYTES) {
        return NextResponse.json(
          { error: "Signature is too large." },
          { status: 400 },
        );
      }
      if (!profileBucket) {
        return NextResponse.json(
          { error: "Missing profile signature bucket configuration" },
          { status: 500 },
        );
      }
    }

    const wantsDynamoUpdate = bio !== undefined || signatureAction !== "KEEP";

    if (!usersTable && wantsDynamoUpdate) {
      return NextResponse.json(
        { error: "Missing table configuration" },
        { status: 500 },
      );
    }

    if (updates.length === 0 && !wantsDynamoUpdate) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    }

    let existingProfile: Record<string, unknown> = {};
    if (usersTable) {
      const existing = await ddb.send(
        new GetItemCommand({
          TableName: usersTable,
          Key: {
            email: { S: email },
            sk: { S: "PROFILE" },
          },
        }),
      );
      if (existing.Item) {
        existingProfile = unmarshall(existing.Item);
      }
    }

    // Step 1: update Cognito basic attributes when present.
    if (updates.length > 0) {
      await cognito.send(
        new UpdateUserAttributesCommand({
          AccessToken: accessToken,
          UserAttributes: updates,
        }),
      );
    }

    const previousSignatureBucket =
      asString(existingProfile.signatureBucket) || profileBucket;
    const previousSignatureKey = asString(existingProfile.signatureKey);
    const nextSignatureKey = `profile-signature/${email}/signature.png`;

    // Step 2: apply signature object operation.
    if (signatureAction === "REPLACE" && nextSignatureBytes && profileBucket) {
      await s3.send(
        new PutObjectCommand({
          Bucket: profileBucket,
          Key: nextSignatureKey,
          Body: nextSignatureBytes,
          ContentType: "image/png",
          CacheControl: "no-store",
        }),
      );

      // Clean up old object if key/bucket changed in legacy data.
      if (
        previousSignatureBucket &&
        previousSignatureKey &&
        (previousSignatureBucket !== profileBucket ||
          previousSignatureKey !== nextSignatureKey)
      ) {
        await s3
          .send(
            new DeleteObjectCommand({
              Bucket: previousSignatureBucket,
              Key: previousSignatureKey,
            }),
          )
          .catch(() => {
            // Ignore cleanup failures; profile still points to the new object.
          });
      }
    }

    if (
      signatureAction === "DELETE" &&
      previousSignatureBucket &&
      previousSignatureKey
    ) {
      await s3
        .send(
          new DeleteObjectCommand({
            Bucket: previousSignatureBucket,
            Key: previousSignatureKey,
          }),
        )
        .catch(() => {
          // Ignore delete failures when object no longer exists.
        });
    }

    // Step 3: persist bio/signature metadata in PROFILE item.
    if (usersTable && wantsDynamoUpdate) {
      const now = new Date().toISOString();
      const setParts = [
        "createdAt = if_not_exists(createdAt, :now)",
        "updatedAt = :now",
      ];
      const removeParts: string[] = [];
      const values: Record<string, AttributeValue> = {
        ":now": { S: now },
      };

      if (bio !== undefined) {
        if (bio.length > 0) {
          setParts.push("bio = :bio");
          values[":bio"] = { S: bio };
        } else {
          removeParts.push("bio");
        }
      }

      if (signatureAction === "REPLACE" && profileBucket && nextSignatureBytes) {
        setParts.push("signatureBucket = :signatureBucket");
        setParts.push("signatureKey = :signatureKey");
        setParts.push("signatureContentType = :signatureContentType");
        setParts.push("signatureSize = :signatureSize");
        setParts.push("signatureUpdatedAt = :signatureUpdatedAt");
        values[":signatureBucket"] = { S: profileBucket };
        values[":signatureKey"] = { S: nextSignatureKey };
        values[":signatureContentType"] = { S: "image/png" };
        values[":signatureSize"] = { N: String(nextSignatureBytes.length) };
        values[":signatureUpdatedAt"] = { S: now };
      }

      if (signatureAction === "DELETE") {
        removeParts.push(
          "signatureBucket",
          "signatureKey",
          "signatureContentType",
          "signatureSize",
          "signatureUpdatedAt",
        );
      }

      let updateExpression = `SET ${setParts.join(", ")}`;
      if (removeParts.length > 0) {
        updateExpression += ` REMOVE ${removeParts.join(", ")}`;
      }

      await ddb.send(
        new UpdateItemCommand({
          TableName: usersTable,
          Key: {
            email: { S: email },
            sk: { S: "PROFILE" },
          },
          UpdateExpression: updateExpression,
          ExpressionAttributeValues: values,
        }),
      );
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("[profile] PUT error:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to update profile" },
      { status: 500 },
    );
  }
}
