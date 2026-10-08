"use strict";
const { DynamoDBClient, GetItemCommand, TransactWriteItemsCommand } = require("@aws-sdk/client-dynamodb");
const { S3Client, HeadObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const ddb = new DynamoDBClient({});
const s3 = new S3Client({});
// Handlers process records sequentially; keep the verified generation for that record.
let verifiedActor;
exports.verifiedUserSub = email => verifiedActor?.email === email.toLowerCase() ? verifiedActor.userSub : undefined;
exports.canProcess = async (email, object, eventSub) => {
  verifiedActor = undefined;
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
  if (!object && allowed) {
    if (profile.requiresOwnerMetadata?.BOOL && !eventSub) allowed = false;
    if (eventSub && profile.userSub?.S && eventSub !== profile.userSub.S) allowed = false;
  }
  if (allowed) verifiedActor = { email: email.toLowerCase(), userSub: profile.userSub?.S };
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
      const email = input.Key.email?.S?.toLowerCase();
      if (!verifiedActor || verifiedActor.email !== email) throw new Error("Media write requires a verified account");
      const actor = verifiedActor;
      const subjectGate = actor.userSub ? "userSub = :subject" : "(attribute_not_exists(requiresOwnerMetadata) OR requiresOwnerMetadata = :legacy)";
      return send(new TransactWriteItemsCommand({ TransactItems: [
        { ConditionCheck: {
          TableName: input.TableName, Key: { email: { S: email }, sk: { S: "PROFILE" } },
          ConditionExpression: `attribute_exists(sk) AND (attribute_not_exists(accountStatus) OR accountStatus = :active) AND ${subjectGate}`,
          ExpressionAttributeValues: { ":active": { S: "ACTIVE" }, ...(actor.userSub ? { ":subject": { S: actor.userSub } } : { ":legacy": { BOOL: false } }) },
        } },
        { Update: input },
      ] }), ...options);
    }
    return send(command, ...options);
  };
  return client;
};
