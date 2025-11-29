import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";

/**
 * Cognito Post Confirmation trigger.
 * Invoked after the user confirms their email (safer than pre-confirmation).
 *
 * Required env vars:
 * - USERS_TABLE: DynamoDB table name where user records are stored
 */
const client = new DynamoDBClient({});

export const handler = async (event: {
  userName: string;
  request: { userAttributes: Record<string, string | undefined> };
}) => {
  const tableName = process.env.USERS_TABLE;
  if (!tableName) throw new Error("Missing env USERS_TABLE");

  const attributes = event.request?.userAttributes || {};
  const username = event.userName;
  const email = attributes.email?.toLowerCase();
  const emailVerified = attributes.email_verified === "true";

  if (!email) {
    throw new Error("Missing email in userAttributes");
  }

  const now = new Date().toISOString();

  await client.send(
    new PutItemCommand({
      TableName: tableName,
      Item: {
        // PK = email, SK = created_at (ISO string)
        email: { S: email },
        created_at: { S: now },
        username: { S: username },
        emailVerified: { BOOL: emailVerified },
        createdAt: { S: now },
        updatedAt: { S: now },
      },
      ConditionExpression:
        "attribute_not_exists(email) AND attribute_not_exists(created_at)",
    }),
  );

  return event;
};
