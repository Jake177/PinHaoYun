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
  let backupHash, automatic, mediaType, lease, requestId, confirmed = false;
  if (object && allowed) {
    let head;
    try { head = await s3.send(new HeadObjectCommand(object)); }
    catch (error) { if (error.name === "NotFound" || error.$metadata?.httpStatusCode === 404) return false; throw error; }
    const owner = head.Metadata?.["owner-sub"];
    if (profile.requiresOwnerMetadata?.BOOL && !owner) allowed = false;
    if (owner && profile.userSub?.S && owner !== profile.userSub.S) allowed = false;
    backupHash = head.Metadata?.["backup-hash"];
    automatic = head.Metadata?.["upload-source"] === "automatic";
    mediaType = object.Key.startsWith("photo/") ? "PHOTO" : "VIDEO";
    if (allowed) {
      const filename = object.Key.split("/").pop();
      const id = mediaType === "PHOTO" ? filename.split("_")[0] : filename;
      const media = await ddb.send(new GetItemCommand({ TableName: process.env.VIDEOS_TABLE, Key: { email: { S: email.toLowerCase() }, sk: { S: `${mediaType}#${id}` } }, ConsistentRead: true }));
      if (["DELETING", "DELETED"].includes(media.Item?.status?.S || "")) allowed = false;
      const live = mediaType === "PHOTO" && filename.toLowerCase().endsWith(".mov");
      const currentKey = media.Item?.[live ? "liveVideoKey" : (mediaType === "PHOTO" ? "originalPhotoKey" : "originalKey")]?.S || media.Item?.originalKey?.S;
      confirmed = media.Item?.[live ? "liveUploadConfirmed" : "uploadConfirmed"]?.BOOL === true && currentKey === object.Key && (!backupHash || media.Item?.contentHash?.S === backupHash);
      requestId = head.Metadata?.["upload-request-id"];
      if (allowed && requestId && !confirmed) {
        lease = { email: { S: email.toLowerCase() }, sk: { S: mediaType === "PHOTO" ? `RESERVE#PHOTO#${id}` : `RESERVE#${id}` } };
        const reservation = await ddb.send(new GetItemCommand({ TableName: process.env.VIDEOS_TABLE, Key: lease, ConsistentRead: true }));
        if (reservation.Item?.key?.S !== object.Key || reservation.Item?.requestId?.S !== requestId) allowed = false;
      }
    }
    if (automatic && allowed && !confirmed) {
      if (!backupHash || !/^[a-f0-9]{64}-\d+$/.test(backupHash)) allowed = false;
      else {
        const marker = await ddb.send(new GetItemCommand({ TableName: process.env.VIDEOS_TABLE, Key: { email: { S: email.toLowerCase() }, sk: { S: `BACKUP_DELETED#${mediaType}#${backupHash}` } }, ConsistentRead: true }));
        if (marker.Item) allowed = false;
      }
    }
  }
  if (!object && allowed) {
    if (profile.requiresOwnerMetadata?.BOOL && !eventSub) allowed = false;
    if (eventSub && profile.userSub?.S && eventSub !== profile.userSub.S) allowed = false;
  }
  if (allowed) verifiedActor = { email: email.toLowerCase(), userSub: profile.userSub?.S, backupHash, automatic: automatic && !confirmed, mediaType, lease, requestId, object: object && { ...object } };
  if (!allowed && object) await s3.send(new DeleteObjectCommand(object));
  return allowed;
};
exports.cleanupRejectedObjects = async (email, original, generated = []) => {
  if (await exports.canProcess(email, original)) return;
  for (const object of generated) await s3.send(new DeleteObjectCommand(object));
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
      if (actor.backupHash && !input.UpdateExpression.includes("contentHash")) {
        input.UpdateExpression += ", contentHash = if_not_exists(contentHash, :backupHash)";
        input.ExpressionAttributeValues[":backupHash"] = { S: actor.backupHash };
      }
      const subjectGate = actor.userSub ? "userSub = :subject" : "(attribute_not_exists(requiresOwnerMetadata) OR requiresOwnerMetadata = :legacy)";
      const transaction = current => new TransactWriteItemsCommand({ TransactItems: [
        ...(current.lease ? [{ ConditionCheck: { TableName: input.TableName, Key: current.lease, ConditionExpression: "#key = :key AND requestId = :request", ExpressionAttributeNames: { "#key": "key" }, ExpressionAttributeValues: { ":key": { S: current.object.Key }, ":request": { S: current.requestId } } } }] : []),
        ...(current.automatic ? [{ ConditionCheck: { TableName: input.TableName, Key: { email: { S: email }, sk: { S: `BACKUP_DELETED#${current.mediaType}#${current.backupHash}` } }, ConditionExpression: "attribute_not_exists(sk)" } }] : []),
        { ConditionCheck: {
          TableName: input.TableName, Key: { email: { S: email }, sk: { S: "PROFILE" } },
          ConditionExpression: `attribute_exists(sk) AND (attribute_not_exists(accountStatus) OR accountStatus = :active) AND ${subjectGate}`,
          ExpressionAttributeValues: { ":active": { S: "ACTIVE" }, ...(actor.userSub ? { ":subject": { S: actor.userSub } } : { ":legacy": { BOOL: false } }) },
        } },
        { Update: input },
      ] });
      return Promise.resolve(send(transaction(actor), ...options)).catch(async error => {
        // Finalization may legitimately consume the lease while a thumbnail is
        // being generated. Recheck the exact confirmed resource, once.
        if (error.name === "TransactionCanceledException" && actor.object && await exports.canProcess(email, actor.object)) {
          const current = verifiedActor;
          if (current && !current.lease && current.requestId === actor.requestId && current.backupHash === actor.backupHash) return send(transaction(current), ...options);
        }
        throw error;
      });
    }
    return send(command, ...options);
  };
  return client;
};
