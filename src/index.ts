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
  MX_MSG_SPACE_EXISTS_HTML,
  MX_MSG_SPACE_EXISTS_TXT,
  MX_MSG_SPACE_CREATED_TXT,
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
  !MX_USER_ID ||
  !MX_MSG_SPACE_EXISTS_HTML ||
  !MX_MSG_SPACE_EXISTS_TXT ||
  !MX_MSG_SPACE_CREATED_TXT
) {
  throw new Error(
    "Missing a required configuration variable. See example file for more info."
  );
}

const OLD_MESSAGE_THRESHOLD_MS = 30 * 1000;
// Increment this to create unioue room IDs
const ROOM_DEBUG_ITERATOR = "36";
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

const buildRoomName = (slug: string, modifier?: string) => ({
  local: slug + modifier || "",
  alias: "#" + slug + (modifier || "") + ":" + MX_HS_URL,
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
            groupName: groupObject?.name,
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

          const userIsOwner = kcUserGroups.some((group) =>
            group.groupName?.toLowerCase().includes("owner-approved")
          );
          const userIsCrew = kcUserGroups.some((group) =>
            group.groupName?.toLowerCase().includes("crew-approved")
          );

          const spaceName = buildRoomName(
            kcUserGroups[0].slug,
            ROOM_DEBUG_ITERATOR
          );

          let spaceExists;
          try {
            spaceExists = await mxClient.getRoomIdForAlias(spaceName.alias);
          } catch (e) {
            logger.error("Space doesn't exist, yet.", e);
          }

          if (!userIsOwner && !userIsCrew) {
            logger.debug(
              "User is neither owner nor crew member. Not doing anything."
            );
            return;
          }

          if (userIsOwner) {
            logger.debug("Sending DM...");

            let dmRoomId;
            try {
              dmRoomId = (
                await mxClient.createRoom({
                  invite: [dmTarget],
                  is_direct: true,
                  preset: Preset.TrustedPrivateChat,
                  initial_state: [],
                })
              ).room_id;

              logger.debug("Created DM Room", dmRoomId);
            } catch (e) {
              logger.error("Error while creating DM room with new user.", e);
              return;
            }

            let bodyHtml, bodyTxt;

            if (spaceExists) {
              logger.debug("Space already exists.", spaceExists);
              // Invite to space
              try {
                const inviteResponse = await mxClient.invite(
                  spaceExists.room_id,
                  dmTarget
                );
                logger.debug("Invite response", inviteResponse);
              } catch (e) {
                logger.error(
                  "Could not invite. User probably already joined.",
                  e
                );
              }

              bodyHtml = format(
                MX_MSG_SPACE_EXISTS_HTML,
                dmTarget,
                kcUserGroups[0].name,
                spaceName.alias
              );
              bodyTxt = format(
                MX_MSG_SPACE_EXISTS_TXT,
                dmTarget,
                kcUserGroups[0].name,
                spaceName.alias
              );
            } else {
              bodyHtml = format(
                MX_MSG_WELCOME_HTML,
                dmTarget,
                kcUserGroups[0].name
              );
              bodyTxt = format(
                MX_MSG_WELCOME_TXT,
                dmTarget,
                kcUserGroups[0].name
              );
            }

            await mxClient.sendHtmlMessage(dmRoomId, bodyTxt, bodyHtml);
            logger.debug("Sent DM to user.");
          } else if (userIsCrew) {
            if (spaceExists) {
              // Invite to space
              try {
                const inviteResponse = await mxClient.invite(
                  spaceExists.room_id,
                  dmTarget
                );
                logger.debug("Invite response", inviteResponse);
              } catch (e) {
                logger.error(
                  "Could not invite. User probably already joined.",
                  e
                );
              }
            }
          }
        } else {
          logger.error("User is unknown to Keycloak. Ignoring user.");
        }
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
        logger.debug("RECEIVED CREATE COMMAND FROM VALID USER.");
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
            groupName: groupObject.name,
            slug: groupObject?.attributes?.workshopSlug[0],
            name: groupObject?.attributes?.workshopName[0],
          }));

          logger.debug("GOT KC GROUPS", kcUserGroups);

          const userIsOwner = kcUserGroups.some((group) =>
            group.groupName?.toLowerCase().includes("owner-approved")
          );

          if (!userIsOwner) {
            logger.debug("User is not a workshop owner. Not creating space.");
            return;
          }

          const spaceName = buildRoomName(
            kcUserGroups[0].slug,
            ROOM_DEBUG_ITERATOR
          );
          const roomName = buildRoomName(
            kcUserGroups[0].slug + "-allgemein",
            ROOM_DEBUG_ITERATOR
          );

          let roomExists;
          let spaceExists;
          // Check if Space exists
          try {
            spaceExists = (await mxClient.getRoomIdForAlias(spaceName.alias))
              .room_id;
            logger.debug("Space already exists", spaceExists);

            await mxClient.invite(spaceExists, senderId);

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
                room_alias_name: spaceName.local,
                topic: "Space für " + kcUserGroups[0].name,
                creation_content: { type: "m.space" },
                invite: [senderId],
              })
            ).room_id;
            logger.debug("Created space", spaceExists);

            // TODO: Make sure, power levels are not overwritten (pass old power levels event)
            mxClient.setPowerLevel(
              spaceExists,
              [senderId, MX_USER_ID],
              100,
              null
            );

            // TODO: Power Levels not working, yet
            // const powerLevelsEvent = new MatrixEvent({
            //   type: "m.room.power_levels",
            //   state_key: "",
            //   event_id: "_",
            //   sender: "",
            //   room_id: spaceExists,
            //   content: {
            //     users: {
            //       [senderId]: 100,
            //       [MX_USER_ID]: 100,
            //     },
            //   },
            // });

            // logger.debug("power levels event", powerLevelsEvent);

            // const spaceRoom = await mxClient.getRoom(spaceExists);
            // const roomMember = spaceRoom?.getMember(senderId);
            // logger.debug("Room member", roomMember);
            // roomMember?.setPowerLevelEvent(powerLevelsEvent);

            if (room?.roomId) {
              await mxClient.sendTextMessage(
                room?.roomId,
                format(MX_MSG_SPACE_CREATED_TXT, spaceName.alias)
              );
            }
          }

          try {
            roomExists = (await mxClient.getRoomIdForAlias(roomName.alias))
              .room_id;
            logger.debug("Room already exists", roomExists);
          } catch (e) {
            // Create room
            roomExists = (
              await mxClient.createRoom({
                name: kcUserGroups[0].name + " Allgemein",
                room_alias_name: roomName.local,
                topic: "Allgemeiner Raum für " + kcUserGroups[0].name,
                visibility: Visibility.Public,
              })
            ).room_id;
            logger.debug("Created room", roomExists);
          }

          // Nest rooms if they exist
          if (roomExists && spaceExists) {
            try {
              await mxClient.sendStateEvent(
                spaceExists,
                "m.space.child",
                {
                  via: [MX_HS_URL],
                  suggested: true,
                },
                roomExists
              );
              await mxClient.sendStateEvent(
                roomExists,
                "m.space.parent",
                {
                  via: [MX_HS_URL],
                },
                spaceExists
              );
              logger.debug("Sucessfully nested room into space.");
            } catch (e) {
              logger.error("Could not nest space/room.");
            }
          }
        }
      }
    }
  );
  await mxClient.startClient();
})();
