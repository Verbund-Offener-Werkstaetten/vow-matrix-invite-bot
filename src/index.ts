import {
  LogLevel,
  LogService,
  MatrixClient,
  MessageEvent,
  RichConsoleLogger,
  RustSdkCryptoStorageProvider,
  SimpleFsStorageProvider,
  SynapseAdminApis,
  SynapseUser,
} from "matrix-bot-sdk";
import { format } from "node:util";
import KcAdminClient from "@keycloak/keycloak-admin-client";

interface ExtendedSynapseUser extends SynapseUser {
  external_ids: Array<{ auth_provider: string; external_id: string }>;
}

LogService.setLogger(new RichConsoleLogger());
LogService.setLevel(LogLevel.DEBUG);
LogService.muteModule("Metrics");

const { MONITORED_ROOM_ID, MX_HS_URL, APP_NAME, MX_ACCESS_TOKEN, MSG_WELCOME } =
  process.env;
if (!MONITORED_ROOM_ID || !MX_HS_URL || !MX_ACCESS_TOKEN) {
  throw new Error("Missing required configuration variables");
}

const storage = new SimpleFsStorageProvider("./storage/bot.json");
const crypto = new RustSdkCryptoStorageProvider("./storage/bot_sled");

const client = new MatrixClient(MX_HS_URL, MX_ACCESS_TOKEN, storage, crypto);
const synapseClient = new SynapseAdminApis(client);

const kcAdminClient = new KcAdminClient({
  baseUrl: "https://willkommen.offene-werkstaetten.org",
  realmName: "master",
});

(async function () {
  await kcAdminClient.auth({
    username: "abc123",
    password: "abc123",
    grantType: "password",
    clientId: "admin-cli",
  });

  await client.dms.update();
  kcAdminClient.setConfig({
    realmName: "verbund-offener-werkstaetten",
  });

  client.on("room.event", async (roomId, event) => {
    LogService.info("index", "Got room event");
    if (
      !event["state_key"] ||
      event["content"]["membership"] !== "join" ||
      event["type"] !== "m.room.member" ||
      roomId !== MONITORED_ROOM_ID
    )
      return;

    LogService.info("index", "User joined monitored room", event);

    const dmTarget = event.sender;
    let keycloakId = null;
    if (dmTarget) {
      try {
        const userInfo = (await synapseClient.getUser(
          dmTarget
        )) as ExtendedSynapseUser;

        keycloakId = userInfo.external_ids.find(
          (entry) => entry.auth_provider === "oidc-keycloak"
        )?.external_id;
      } catch (e) {
        LogService.info("index", "User is not known in Keycloak.");
      }
      if (keycloakId) {
        LogService.info(
          "index",
          "User is known in Keycloak under ID ",
          keycloakId
        );
        try {
          const kcUserGroups = (
            await kcAdminClient.users.listGroups({
              id: keycloakId,
              briefRepresentation: false,
            })
          ).map((groupObject) => ({
            slug: groupObject?.attributes?.workshopSlug[0],
            name: groupObject?.attributes?.workshopName[0],
          }));

          LogService.info("index", "Groups", kcUserGroups);

          const content = {
            body: format(MSG_WELCOME, event.sender, kcUserGroups[0].name),
            msgtype: "m.text",
          };

          const dmRoomId = await client.dms.getOrCreateDm(dmTarget);

          client.sendMessage(dmRoomId, content);
        } catch (e) {
          LogService.error("index", e);
        }
      } else {
        LogService.info("index", "Not sending message to", dmTarget);
      }
    }
  });

  client.on("room.message", async (roomId: string, event: any) => {
    LogService.info("index", "Got room message event");
    // Not interested in non-DMs
    if (roomId === MONITORED_ROOM_ID) return;

    const message = new MessageEvent(event);

    if (message.messageType !== "m.text") return;
    if (message.textBody.startsWith("!space")) {
      await client.replyText(roomId, event, "Space wird erstellt.");

      const userInfo = (await synapseClient.getUser(
        event.sender
      )) as ExtendedSynapseUser;

      const keycloakId = userInfo.external_ids.find(
        (entry) => entry.auth_provider === "oidc-keycloak"
      )?.external_id;

      if (keycloakId) {
        const kcUserGroups = (
          await kcAdminClient.users.listGroups({
            id: keycloakId,
            briefRepresentation: false,
          })
        ).map((groupObject) => ({
          slug: groupObject?.attributes?.workshopSlug[0],
          name: groupObject?.attributes?.workshopName[0],
        }));

        client.createSpace({
          name: kcUserGroups[0].name,
          isPublic: false,
          localpart: kcUserGroups[0].slug,
          invites: [event.sender],
        });
      }
    }
  });

  // TODO: Handle bot already being in the room
  client.on("room.invite", (roomId: string, inviteEvent: any) => {
    if (roomId === MONITORED_ROOM_ID) return client.joinRoom(roomId);
  });

  LogService.info("index", `Starting ${APP_NAME}...`);
  LogService.info("index", `Bot Account:`, (await client.getWhoAmI()).user_id);
  await client.start();
})();

const getKcGroupsForMxId = async (mxId: string) => {
  const synapseUser = (await synapseClient.getUser(
    mxId
  )) as ExtendedSynapseUser;

  const kcId = synapseUser.external_ids.find(
    (entry) => entry.auth_provider === "oidc-keycloak"
  )?.external_id;

  if (kcId) {
    const kcUserGroups = (
      await kcAdminClient.users.listGroups({
        id: kcId,
        briefRepresentation: false,
      })
    ).map((groupObject) => ({
      slug: groupObject?.attributes?.workshopSlug[0],
      name: groupObject?.attributes?.workshopName[0],
    }));

    return kcUserGroups;
  }
  return null;
};
