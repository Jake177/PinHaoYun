import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const region = process.env.COGNITO_REGION || "ap-southeast-2";
const tableName = process.env.VIDEOS_TABLE || process.env.USERS_TABLE;

export const profileDdb = new DynamoDBClient({ region });

export function getProfileTableName(): string {
  if (!tableName) {
    throw new Error("Missing env VIDEOS_TABLE/USERS_TABLE");
  }
  return tableName;
}

export async function getProfileRecord(
  email: string,
): Promise<Record<string, unknown>> {
  const response = await profileDdb.send(
    new GetItemCommand({
      TableName: getProfileTableName(),
      Key: {
        email: { S: email.toLowerCase() },
        sk: { S: "PROFILE" },
      },
    }),
  );

  if (!response.Item) return {};
  return unmarshall(response.Item) as Record<string, unknown>;
}

function marshallScalar(value: unknown): AttributeValue {
  return marshall({ value }).value as AttributeValue;
}

export async function updateProfileRecord(
  email: string,
  options: {
    set?: Record<string, unknown>;
    remove?: string[];
  },
): Promise<void> {
  const setEntries = Object.entries(options.set || {}).filter(
    ([, value]) => value !== undefined,
  );
  const removeEntries = (options.remove || []).filter(Boolean);

  if (setEntries.length === 0 && removeEntries.length === 0) {
    return;
  }

  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, AttributeValue> = {};
  const setExpressions: string[] = [];
  const removeExpressions: string[] = [];

  setEntries.forEach(([key, value], index) => {
    const nameKey = `#set${index}`;
    const valueKey = `:set${index}`;
    expressionAttributeNames[nameKey] = key;
    expressionAttributeValues[valueKey] = marshallScalar(value);
    setExpressions.push(`${nameKey} = ${valueKey}`);
  });

  removeEntries.forEach((key, index) => {
    const nameKey = `#remove${index}`;
    expressionAttributeNames[nameKey] = key;
    removeExpressions.push(nameKey);
  });

  const updateExpressionParts: string[] = [];
  if (setExpressions.length) {
    updateExpressionParts.push(`SET ${setExpressions.join(", ")}`);
  }
  if (removeExpressions.length) {
    updateExpressionParts.push(`REMOVE ${removeExpressions.join(", ")}`);
  }

  await profileDdb.send(
    new UpdateItemCommand({
      TableName: getProfileTableName(),
      Key: {
        email: { S: email.toLowerCase() },
        sk: { S: "PROFILE" },
      },
      UpdateExpression: updateExpressionParts.join(" "),
      ...(Object.keys(expressionAttributeNames).length
        ? { ExpressionAttributeNames: expressionAttributeNames }
        : {}),
      ...(Object.keys(expressionAttributeValues).length
        ? { ExpressionAttributeValues: expressionAttributeValues }
        : {}),
    }),
  );
}
