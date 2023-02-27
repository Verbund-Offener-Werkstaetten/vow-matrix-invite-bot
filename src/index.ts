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

(async function () {
  await client.dms.update();

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
    let isKeycloakUser = false;
    if (dmTarget) {
      try {
        const userInfo = (await synapseClient.getUser(
          dmTarget
        )) as ExtendedSynapseUser;

        isKeycloakUser = userInfo["external_ids"].some(
          (entry) => entry["auth_provider"] === "oidc-keycloak"
        );
      } catch (e) {
        LogService.info("index", "User is not known in Keycloak.");
      }
      if (isKeycloakUser) {
        LogService.info(
          "index",
          "User is known in Keycloak. Sending message...",
          dmTarget
        );
        const dmRoomId = await client.dms.getOrCreateDm(dmTarget);

        const content = {
          body: format(MSG_WELCOME, event.sender),
          msgtype: "m.text",
        };
        client.sendMessage(dmRoomId, content);
      } else {
        LogService.info("index", "Not sending message to", dmTarget);
      }
    }
  });

  client.on("room.message", async (roomId: string, event: any) => {
    // Not interested in non-DMs
    if (roomId === MONITORED_ROOM_ID) return;

    const message = new MessageEvent(event);

    if (message.messageType !== "m.text") return;
    if (message.textBody.startsWith("!space")) {
      await client.replyNotice(roomId, event, "Space wird erstellt.");
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
