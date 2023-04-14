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
  KC_CLIENT_ID,
  KC_CLIENT_SECRET,
  KC_OWNER_SUFFIX,
  KC_CREW_SUFFIX,
  MX_MSG_SPACE_EXISTS_HTML,
  MX_MSG_SPACE_EXISTS_TXT,
  MX_MSG_SPACE_CREATED_TXT,
  MX_MSG_SPACE_EXISTS_AFTER_CMD_TXT,
  MX_GENERAL_ROOM_SUFFIX,
  MX_ROOM_DEBUG_ITERATOR,
  LOG_LEVEL,
} = process.env;

if (
  !MX_MONITORED_ROOM_ID ||
  !MX_HS_URL ||
  !MX_ACCESS_TOKEN ||
  !KC_URL ||
  !KC_CLIENT_ID ||
  !KC_CLIENT_SECRET ||
  !KC_REALM ||
  !KC_OWNER_SUFFIX ||
  !KC_CREW_SUFFIX ||
  !MX_MSG_WELCOME_HTML ||
  !MX_MSG_WELCOME_TXT ||
  !MX_MSG_COMMAND ||
  !MX_DEVICE_ID ||
  !MX_USER_ID ||
  !MX_MSG_SPACE_EXISTS_HTML ||
  !MX_MSG_SPACE_EXISTS_TXT ||
  !MX_MSG_SPACE_CREATED_TXT ||
  !MX_MSG_SPACE_EXISTS_AFTER_CMD_TXT ||
  !MX_GENERAL_ROOM_SUFFIX
) {
  throw new Error(
    "Missing a required configuration variable. See example file for more info."
  );
}

const OLD_MESSAGE_THRESHOLD_MS = 20 * 1000;
const SYNAPSE_EXTERNAL_AUTH_PROVIDER = "oidc-keycloak";

const logger = new Logger(
  LogLevel[(LOG_LEVEL as keyof typeof LogLevel) || ("Error" as const)]
);

interface UserGroup {
  groupName?: string;
  slug: string;
  name?: string;
}

logger.info("Starting VOW Matrix Invite Bot");
logger.info("Monitored Room:", MX_MONITORED_ROOM_ID);

const mxClient = sdk.createClient({
  baseUrl: "https://" + MX_HS_URL,
  accessToken: MX_ACCESS_TOKEN,
  deviceId: MX_DEVICE_ID,
  userId: MX_USER_ID,
});

const synapseAdminClient = new SynapseAdminClient(MX_HS_URL, MX_ACCESS_TOKEN);

const kcCredentials = {
  grantType: "client_credentials" as const,
  clientId: KC_CLIENT_ID,
  clientSecret: KC_CLIENT_SECRET,
};

const kcAdminClient = new KcAdminClient({
  baseUrl: KC_URL,
  realmName: KC_REALM,
});

const buildRoomName = (slug: string, modifier?: string) => ({
  local: slug + modifier || "",
  alias: "#" + slug + (modifier || "") + ":" + MX_HS_URL,
});

const setPowerLevelForUsers = async (
  roomId: string,
  userIds: Array<string>,
  level: number
) => {
  const room = await mxClient?.getRoom(roomId);
  // Get old power levels to merge with new permissions
  const powerLevelEvent = room?.currentState.getStateEvents(
    "m.room.power_levels",
    ""
  );

  mxClient.setPowerLevel(roomId, userIds, level, powerLevelEvent || null);
};

(async () => {
  await kcAdminClient.auth(kcCredentials);

  // Refresh key every 58min
  setInterval(() => {
    logger.info("Refreshing Keycloak token");
    kcAdminClient.auth(kcCredentials);
  }, 58 * 60 * 1000);

  // Listener to check the monitored room for join events and maybe send introduction DM to the new user
  mxClient.on(RoomMemberEvent.Membership, async (event, member) => {
    // Make sure the bot never crashes with global try/catch
    try {
      const date = event.getDate();
      const isOld =
        new Date().getTime() - (date?.getTime() ?? 0) >
        OLD_MESSAGE_THRESHOLD_MS;

      if (
        member.membership !== "join" ||
        event.getRoomId() !== MX_MONITORED_ROOM_ID ||
        isOld
      ) {
        return;
      }

      const dmTarget = event.getSender();
      logger.debug("A user joined the monitored room", dmTarget);

      if (dmTarget) {
        let userInfo;
        try {
          userInfo = await synapseAdminClient.getUser(dmTarget);
        } catch (e) {
          logger.error("Error while getting User info from Keycloak", e);
          return;
        }

        const keycloakId = userInfo?.external_ids?.find(
          (entry) => entry.auth_provider === SYNAPSE_EXTERNAL_AUTH_PROVIDER
        )?.external_id;

        if (keycloakId) {
          logger.debug("User is known in Keycloak as", keycloakId);

          let kcUserGroups: UserGroup[];
          try {
            kcUserGroups = (
              await kcAdminClient.users.listGroups({
                id: keycloakId,
                briefRepresentation: false,
              })
            )
              // Don't consider groups if they have no slug/name (e.g. other unrelated KC groups)
              .filter(
                (groupObject) =>
                  groupObject?.attributes?.workshopSlug?.length &&
                  groupObject?.attributes?.workshopName?.length
              )
              .map((groupObject) => ({
                groupName: groupObject?.name,
                // Keycloak SDK/API will always return array for these attributes, even if they're just strings, so we take the first element
                slug: (groupObject.attributes as Record<string, any>)
                  .workshopSlug[0],
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

            const workshopGroupsPerSlug: Map<string, UserGroup[]> = new Map();

            for (const kcUserGroup of kcUserGroups) {
              const existingEntries = workshopGroupsPerSlug.get(
                kcUserGroup.slug
              );
              if (existingEntries) {
                workshopGroupsPerSlug.set(kcUserGroup.slug, [
                  ...existingEntries,
                  kcUserGroup,
                ]);
              } else {
                workshopGroupsPerSlug.set(kcUserGroup.slug, [kcUserGroup]);
              }
            }

            let dmRoomId;
            for (const workshopGroups of workshopGroupsPerSlug.values()) {
              const userIsOwner = workshopGroups.some((group) =>
                group.groupName?.toLowerCase().includes(KC_OWNER_SUFFIX)
              );

              const userIsCrew = workshopGroups.some((group) =>
                group.groupName?.toLowerCase().includes(KC_CREW_SUFFIX)
              );

              if (!userIsOwner && !userIsCrew) {
                logger.debug(
                  "User is neither owner nor crew member. Not doing anything.",
                  workshopGroups[0].slug
                );
                continue;
              }

              const spaceName = buildRoomName(
                workshopGroups[0].slug,
                MX_ROOM_DEBUG_ITERATOR
              );

              let spaceExists;
              try {
                spaceExists = await mxClient.getRoomIdForAlias(spaceName.alias);
              } catch (e) {
                logger.error("Space doesn't exist, yet.", e);
              }

              if (userIsOwner) {
                logger.debug("Sending DM...");
                if (!dmRoomId) {
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
                    logger.error(
                      "Error while creating DM room with new user.",
                      e
                    );
                    return;
                  }
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
                    workshopGroups[0].name,
                    spaceName.alias
                  );
                  bodyTxt = format(
                    MX_MSG_SPACE_EXISTS_TXT,
                    dmTarget,
                    workshopGroups[0].name,
                    spaceName.alias
                  );
                } else {
                  bodyHtml = format(
                    MX_MSG_WELCOME_HTML,
                    dmTarget,
                    workshopGroups[0].name,
                    workshopGroups[0].slug
                  );
                  bodyTxt = format(
                    MX_MSG_WELCOME_TXT,
                    dmTarget,
                    workshopGroups[0].name,
                    workshopGroups[0].slug
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
                } else {
                  logger.debug(
                    "User is crew, space doesn't exist. Doing nothing."
                  );
                }
              }
            }
          } else {
            logger.error("User is unknown to Keycloak. Ignoring user.");
          }
        }
      }
    } catch (e) {
      logger.error("Unhandled exception in 'Join' event handler", e);
    }
  });

  // Listener for command to create individual spaces/rooms
  mxClient.on(
    RoomEvent.Timeline,
    async (
      event: MatrixEvent,
      room: Room | undefined,
      toStartOfTimeline: boolean | undefined
    ) => {
      // Make sure the bot never crashes with global try/catch
      try {
        const date = event.getDate();
        const isOld =
          new Date().getTime() - (date?.getTime() ?? 0) >
          OLD_MESSAGE_THRESHOLD_MS;

        if (toStartOfTimeline || isOld) {
          return;
        }

        const senderId = event.getSender();

        // Ignore own messages and unrelevant message types
        if (
          senderId === mxClient.getUserId() ||
          event.getType() !== "m.room.message"
        )
          return;

        const eventContent: any = event.getContent();

        // TODO: Improve DM detection. Currently: Use joined members length as an indicator whether it's a DM or not
        const joinedMembers = room?.getJoinedMembers();
        const messageBody = eventContent.body;

        if (
          messageBody?.startsWith(MX_MSG_COMMAND) &&
          senderId &&
          joinedMembers?.length === 2
        ) {
          logger.debug("Received Create command.");
          let keycloakId = null;
          try {
            const userInfo = await synapseAdminClient.getUser(senderId);

            keycloakId = userInfo?.external_ids?.find(
              (entry) => entry.auth_provider === SYNAPSE_EXTERNAL_AUTH_PROVIDER
            )?.external_id;
          } catch (e) {
            logger.error("Could not fetch user from Keycloak.", e);
          }

          if (keycloakId) {
            logger.debug("User is known to Keycloak");
            const kcUserGroups: UserGroup[] = (
              await kcAdminClient.users.listGroups({
                id: keycloakId,
                briefRepresentation: false,
              })
            )
              // Don't consider groups if they have no slug/name (e.g. other unrelated KC groups)
              .filter(
                (groupObject) =>
                  groupObject?.attributes?.workshopSlug?.length &&
                  groupObject?.attributes?.workshopName?.length
              )
              .map((groupObject) => ({
                groupName: groupObject?.name,
                // Keycloak SDK/API will always return array for these attributes, even if they're just strings, so we take the first element
                slug: groupObject?.attributes?.workshopSlug[0],
                name: groupObject?.attributes?.workshopName[0],
              }));

            logger.debug("GOT KC GROUPS", kcUserGroups);

            const [_, slug] = messageBody.split(" ");
            const ownerWorkshopGroup = kcUserGroups.find(
              (g) =>
                g.slug === slug &&
                g.groupName?.toLowerCase().includes(KC_OWNER_SUFFIX)
            );

            if (!ownerWorkshopGroup) {
              logger.debug("User is not a workshop owner. Not creating space.");
              return;
            }

            const spaceName = buildRoomName(
              ownerWorkshopGroup.slug,
              MX_ROOM_DEBUG_ITERATOR
            );
            const roomName = buildRoomName(
              ownerWorkshopGroup.slug + MX_GENERAL_ROOM_SUFFIX,
              MX_ROOM_DEBUG_ITERATOR
            );

            let roomId, spaceId;
            let spaceExists = true;
            // Check if Space already exists

            try {
              spaceId = (await mxClient.getRoomIdForAlias(spaceName.alias))
                ?.room_id;
              logger.debug("Space already exists", spaceId);
            } catch (e) {
              // Create space
              spaceExists = false;
              spaceId = (
                await mxClient.createRoom({
                  name: ownerWorkshopGroup.name,
                  room_alias_name: spaceName.local,
                  topic: "Space für " + ownerWorkshopGroup.name,
                  creation_content: { type: "m.space" },
                  // invite: [senderId],
                })
              ).room_id;
              logger.debug("Created space", spaceId);
            }

            await mxClient?.invite(spaceId, senderId);

            setPowerLevelForUsers(spaceId, [senderId, MX_USER_ID], 100);

            if (room?.roomId) {
              await mxClient.sendTextMessage(
                room?.roomId,
                spaceExists
                  ? format(MX_MSG_SPACE_EXISTS_AFTER_CMD_TXT, spaceName.alias)
                  : format(MX_MSG_SPACE_CREATED_TXT, spaceName.alias)
              );
            }

            try {
              roomId = (await mxClient.getRoomIdForAlias(roomName.alias))
                .room_id;
              logger.debug("Room already exists", roomId);
            } catch (e) {
              // Create room
              roomId = (
                await mxClient.createRoom({
                  name: ownerWorkshopGroup.name + " Allgemein",
                  room_alias_name: roomName.local,
                  topic: "Allgemeiner Raum für " + ownerWorkshopGroup.name,
                  visibility: Visibility.Public,
                  initial_state: [
                    {
                      type: "m.room.join_rules",
                      state_key: "",
                      content: {
                        join_rule: "restricted",
                        allow: [
                          {
                            type: "m.room_membership",
                            room_id: spaceId,
                          },
                        ],
                      },
                    },
                  ],
                })
              ).room_id;
              logger.debug("Created room", roomId);
            }

            setPowerLevelForUsers(roomId, [senderId, MX_USER_ID], 100);

            // Nest rooms if they exist

            try {
              await mxClient.sendStateEvent(
                spaceId,
                "m.space.child",
                {
                  via: [MX_HS_URL],
                  suggested: true,
                },
                roomId
              );
              await mxClient.sendStateEvent(
                roomId,
                "m.space.parent",
                {
                  via: [MX_HS_URL],
                },
                spaceId
              );
              logger.debug("Sucessfully nested room into space.");
            } catch (e) {
              logger.error("Could not nest space/room.");
            }
          }
        }
      } catch (e) {
        logger.error("Unhandled exception in 'Create' event handler", e);
      }
    }
  );
  await mxClient.startClient();
})();
