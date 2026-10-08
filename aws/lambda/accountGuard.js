"use strict";
const { DynamoDBClient, GetItemCommand } = require("@aws-sdk/client-dynamodb");
const { S3Client, HeadObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const ddb = new DynamoDBClient({});
const s3 = new S3Client({});
exports.canProcess = async (email, object) => {
  const response = await ddb.send(new GetItemCommand({ TableName: process.env.VIDEOS_TABLE, Key: { email: { S: email.toLowerCase() }, sk: { S: "PROFILE" } }, ConsistentRead: true }));
  const profile = response.Item;
  let allowed = !!profile && (!profile.accountStatus?.S || profile.accountStatus.S === "ACTIVE");
  if (object && allowed) {
    let head;
    try { head = await s3.send(new HeadObjectCommand(object)); }
    catch (error) { if (error.name === "NotFound" || error.$metadata?.httpStatusCode === 404) return false; throw error; }
    const owner = head.Metadata?.["owner-sub"];
    if (profile.requiresOwnerMetadata?.BOOL && !owner) allowed = false;
    if (owner && profile.userSub?.S && owner !== profile.userSub.S) allowed = false;
  }
  if (!allowed && object) await s3.send(new DeleteObjectCommand(object));
  return allowed;
};

exports.protectMediaWrites = (client, requireExisting = false) => {
  const send = client.send.bind(client);
  client.send = (command, ...options) => {
    const input = command.input;
    if (input?.UpdateExpression && /^(PHOTO|VIDEO)#/.test(input.Key?.sk?.S || "")) {
      const gate = "(attribute_not_exists(#erasureStatus) OR (#erasureStatus <> :erasing AND #erasureStatus <> :erased))";
      input.ConditionExpression = [input.ConditionExpression && `(${input.ConditionExpression})`, requireExisting && "attribute_exists(sk)", gate].filter(Boolean).join(" AND ");
      input.ExpressionAttributeNames = { ...input.ExpressionAttributeNames, "#erasureStatus": "status" };
      input.ExpressionAttributeValues = { ...input.ExpressionAttributeValues, ":erasing": { S: "DELETING" }, ":erased": { S: "DELETED" } };
    }
    return send(command, ...options);
  };
  return client;
};
