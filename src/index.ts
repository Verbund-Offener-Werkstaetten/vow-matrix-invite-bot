import { format } from "node:util";
import KcAdminClient from "@keycloak/keycloak-admin-client";
import * as sdk from "matrix-js-sdk";
import {
  MatrixEvent,
  Preset,
  Room,
  RoomEvent,
  RoomMemberEvent,
  Visibility,
} from "matrix-js-sdk";
import { SynapseAdminClient } from "./SynapseAdminClient.js";
import { Logger, LogLevel } from "./Logger.js";
import * as dotenv from "dotenv";

dotenv.config();

const {
  MX_MONITORED_ROOM_ID,
  MX_HS_URL,
  MX_DEVICE_ID,
  MX_USER_ID,
  MX_ACCESS_TOKEN,
  MX_MSG_WELCOME_HTML,
  MX_MSG_WELCOME_TXT,
  MX_MSG_COMMAND,
  KC_URL,
  KC_REALM,
  KC_ADMIN_USERNAME,
  KC_ADMIN_PASSWORD,
} = process.env;

if (
  !MX_MONITORED_ROOM_ID ||
  !MX_HS_URL ||
  !MX_ACCESS_TOKEN ||
  !KC_URL ||
  !KC_ADMIN_USERNAME ||
  !KC_ADMIN_PASSWORD ||
  !KC_REALM ||
  !MX_MSG_WELCOME_HTML ||
  !MX_MSG_WELCOME_TXT ||
  !MX_MSG_COMMAND ||
  !MX_DEVICE_ID ||
  !MX_USER_ID
) {
  throw new Error(
    "Missing a required configuration variable. See example file for more info."
  );
}

const OLD_MESSAGE_THRESHOLD_MS = 30 * 1000;
const logger = new Logger(LogLevel.Debug);

logger.info("Starting VOW Matrix Invite Bot");

const mxClient = sdk.createClient({
  baseUrl: "https://" + MX_HS_URL,
  accessToken: MX_ACCESS_TOKEN,
  deviceId: MX_DEVICE_ID,
  userId: MX_USER_ID,
});

const synapseAdminClient = new SynapseAdminClient(MX_HS_URL, MX_ACCESS_TOKEN);

const kcAdminClient = new KcAdminClient({
  baseUrl: KC_URL,
  realmName: "master",
});

(async () => {
  await kcAdminClient.auth({
    username: KC_ADMIN_USERNAME,
    password: KC_ADMIN_PASSWORD,
    grantType: "password",
    clientId: "admin-cli",
  });

  kcAdminClient.setConfig({
    realmName: KC_REALM,
  });

  // Listener to check the monitored room for join events and check if the user is known to our Keycloak instance
  mxClient.on(RoomMemberEvent.Membership, async (event, member) => {
    const date = event.getDate();
    const isOld =
      new Date().getTime() - (date?.getTime() ?? 0) > OLD_MESSAGE_THRESHOLD_MS;

    if (
      member.membership === "join" &&
      event.getRoomId() === MX_MONITORED_ROOM_ID &&
      !isOld
    ) {
      logger.debug(
        "A user joined monitored room",
        JSON.stringify(event, null, 2)
      );
    } else {
      return;
    }

    const dmTarget = event.getSender();
    logger.debug("DM TARGET", dmTarget);

    if (dmTarget) {
      let userInfo;
      try {
        userInfo = await synapseAdminClient.getUser(dmTarget);
      } catch (e) {
        logger.error("Error while getting User info from Keycloak", e);
        return;
      }

      const keycloakId = userInfo?.external_ids?.find(
        (entry) => entry.auth_provider === "oidc-keycloak"
      )?.external_id;

      if (keycloakId) {
        logger.debug("User is known in Keycloak as", keycloakId);

        let kcUserGroups;
        try {
          kcUserGroups = (
            await kcAdminClient.users.listGroups({
              id: keycloakId,
              briefRepresentation: false,
            })
          ).map((groupObject) => ({
            slug: groupObject?.attributes?.workshopSlug[0],
            name: groupObject?.attributes?.workshopName[0],
          }));
        } catch (e) {
          logger.error("Error while getting User groups from Keycloak", e);
          return;
        }

        if (kcUserGroups?.length) {
          logger.debug(
            "User has Keycloak Groups",
            JSON.stringify(kcUserGroups, null, 2)
          );

          // TODO: See if space already exists and if user is already member. If not, check if he is Admin, and then create space.

          logger.debug("Sending DM...");

          let room_id;
          try {
            room_id = (
              await mxClient.createRoom({
                invite: [dmTarget],
                is_direct: true,
                preset: Preset.TrustedPrivateChat,
                initial_state: [],
              })
            ).room_id;

            logger.debug("Created DM Room", room_id);
          } catch (e) {
            logger.error("Error while creating DM room with new user.", e);
            return;
          }

          const bodyHtml = format(
            MX_MSG_WELCOME_HTML,
            dmTarget,
            kcUserGroups[0].name
          );
          const bodyTxt = format(
            MX_MSG_WELCOME_TXT,
            dmTarget,
            kcUserGroups[0].name
          );

          await mxClient.sendHtmlMessage(room_id, bodyTxt, bodyHtml);
          logger.debug("Sent DM to user.");
        }
      } else {
        logger.debug("User is unknown to Keycloak. Ignoring user.");
      }
    }
  });

  // Listener for creation command
  mxClient.on(
    RoomEvent.Timeline,
    async (
      event: MatrixEvent,
      room: Room | undefined,
      toStartOfTimeline: boolean | undefined
    ) => {
      const date = event.getDate();
      const isOld =
        new Date().getTime() - (date?.getTime() ?? 0) >
        OLD_MESSAGE_THRESHOLD_MS;

      if (toStartOfTimeline || isOld) {
        return;
      }

      const senderId = event.getSender();

      // Ignore own messages
      if (senderId === mxClient.getUserId()) return;

      // Only chat messages
      if (event.getType() !== "m.room.message") return;

      const c: any = event.getContent();

      // TODO: Improve DM detection. Currently: Use joined members length as an indicator whether it's a DM or not
      const joinedMembers = room?.getJoinedMembers();

      if (
        c.body?.startsWith(MX_MSG_COMMAND) &&
        senderId &&
        joinedMembers?.length === 2
      ) {
        logger.debug("RECEIVED CREATE COMMAND.");
        let keycloakId = null;
        try {
          const userInfo = await synapseAdminClient.getUser(senderId);

          keycloakId = userInfo?.external_ids?.find(
            (entry) => entry.auth_provider === "oidc-keycloak"
          )?.external_id;
        } catch (e) {
          logger.error("Could not fetch User from Keycloak.", e);
        }
        logger.debug("GOT KC USER INFO");

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

          const spaceNameLocalPart = kcUserGroups[0].slug + "20";
          const spaceName = "#" + spaceNameLocalPart + ":" + MX_HS_URL;

          const roomNameLocalPart = kcUserGroups[0].slug + "-allgemein20";
          const roomName = "#" + roomNameLocalPart + ":" + MX_HS_URL;
          let roomExists;
          let spaceExists;
          // Check if Space exists

          try {
            spaceExists = (await mxClient.getRoomIdForAlias(spaceName)).room_id;
            logger.debug("Space already exists", spaceExists);

            mxClient.invite(spaceExists, senderId);

            if (room?.roomId) {
              await mxClient.sendTextMessage(
                room?.roomId,
                "Dieser Space existiert bereits. Du wurdest erneut eingeladen."
              );
            }
          } catch (e) {
            // Create space
            spaceExists = (
              await mxClient.createRoom({
                name: kcUserGroups[0].name,
                room_alias_name: spaceNameLocalPart,
                topic: "Space für " + kcUserGroups[0].name,
                creation_content: { type: "m.space" },
                invite: [senderId],
              })
            ).room_id;
            logger.debug("Created space", spaceExists);

            // TODO: Link to space and show display name instead of ID
            if (room?.roomId) {
              await mxClient.sendTextMessage(
                room?.roomId,
                "Der Space " + spaceExists + " wurde für dich erstellt."
              );
            }
          }

          try {
            roomExists = (await mxClient.getRoomIdForAlias(roomName)).room_id;
            logger.debug("Room already exists", roomExists);
          } catch (e) {
            // Create room
            const roomResponse = await mxClient.createRoom({
              name: kcUserGroups[0].name + " Allgemein",
              room_alias_name: roomNameLocalPart,
              topic: "Allgemeiner Raum für " + kcUserGroups[0].name,
              visibility: Visibility.Public,
            });
            logger.debug("Created room", roomResponse);
          }

          // Nest rooms if they existed
          if (roomExists && spaceExists) {
            const rel1 = await mxClient.sendStateEvent(
              spaceExists,
              "m.space.child",
              {
                via: MX_HS_URL,
                suggested: true,
              },
              roomExists
            );
            const rel2 = await mxClient.sendStateEvent(
              roomExists,
              "m.space.parent",
              {
                via: MX_HS_URL,
              },
              spaceExists
            );
            logger.debug("rel1", rel1);
            logger.debug("rel2", rel2);
          }

          // Invite to Rooms
          // spaceExists && mxClient.invite(spaceExists.room_id, senderId);
          roomExists && mxClient.invite(roomExists, senderId);
        }
      }
    }
  );
  await mxClient.startClient();
})();
