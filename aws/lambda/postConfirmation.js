"use strict";
const { DynamoDBClient, PutItemCommand } = require("@aws-sdk/client-dynamodb");
const client = new DynamoDBClient({});

exports.handler = async (event) => {
  const tableName = process.env.USERS_TABLE;
  if (!tableName) throw new Error("Missing env USERS_TABLE");
  const attributes = event.request?.userAttributes || {};
  const username = event.userName;
  const email = attributes.email?.toLowerCase();
  const emailVerified = attributes.email_verified === "true";
  if (!email) {
    throw new Error("Missing email in userAttributes");
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await client.send(
    new PutItemCommand({
      TableName: tableName,
      Item: {
        email: { S: email },
        username: { S: username },
        emailVerified: { BOOL: emailVerified },
        videos: { L: [] },
        createdAt: { S: now },
        updatedAt: { S: now }
      },
      ConditionExpression: "attribute_not_exists(email)"
    })
  );
  return event;
};
