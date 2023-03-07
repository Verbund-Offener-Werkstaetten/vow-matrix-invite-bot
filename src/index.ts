import { format } from "node:util";
import KcAdminClient from "@keycloak/keycloak-admin-client";
import * as sdk from "matrix-js-sdk";
import {
  MatrixEvent,
  Preset,
  Room,
  RoomEvent,
  RoomMemberEvent,
} from "matrix-js-sdk";
import { SynapseAdminClient } from "./SynapseAdminClient.js";

const {
  MX_MONITORED_ROOM_ID,
  MX_HS_URL,
  APP_NAME,
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
  !MX_MSG_COMMAND
) {
  throw new Error("Missing required configuration variables");
}

const mxClient = sdk.createClient({
  baseUrl: "https://" + MX_HS_URL,
  accessToken: MX_ACCESS_TOKEN,
  deviceId: "VOW Bot",
  userId: "@vow.bot:vow.chat",
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

  await mxClient.startClient();

  mxClient.on(RoomMemberEvent.Membership, async (event, member) => {
    if (
      member.membership === "join" &&
      event.getRoomId() === MX_MONITORED_ROOM_ID
    ) {
      console.log("User joined monitored room", event);
    } else {
      return;
    }

    const dmTarget = event.getSender();
    console.log("DM TARGET", dmTarget);

    if (dmTarget) {
      try {
        const userInfo = await synapseAdminClient.getUser(dmTarget);

        const keycloakId = userInfo?.external_ids?.find(
          (entry) => entry.auth_provider === "oidc-keycloak"
        )?.external_id;

        console.log("User is known in Keycloak", keycloakId);

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

          if (kcUserGroups.length) {
            console.log("User has Keycloak Groups", kcUserGroups);
            console.log("Sending DM...");
            const { room_id } = await mxClient.createRoom({
              invite: [dmTarget],
              is_direct: true,
              preset: Preset.TrustedPrivateChat,
              initial_state: [],
            });

            console.log("Created Room", room_id);

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
            mxClient.sendHtmlMessage(room_id, bodyTxt, bodyHtml);
          }
        }
      } catch (e) {
        console.log("User is not known in Keycloak.", e);
      }
    }
  });

  mxClient.on(
    RoomEvent.Timeline,
    async (
      event: MatrixEvent,
      room: Room | undefined,
      toStartOfTimeline: boolean | undefined
    ) => {
      if (toStartOfTimeline) {
        return; // don't print paginated results
      }

      const senderId = event.getSender();

      // Ignore own messages
      if (senderId === mxClient.getUserId()) return;

      // Only chat messages
      if (event.getType() !== "m.room.message") return;

      const c: any = event.getContent();

      if (c.body?.startsWith(MX_MSG_COMMAND) && senderId) {
        const userInfo = await synapseAdminClient.getUser(senderId);

        const keycloakId = userInfo?.external_ids?.find(
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

          const spaceNameLocalPart = kcUserGroups[0].slug + "11";
          const spaceName = "#" + spaceNameLocalPart + ":" + MX_HS_URL;
          console.log("GOT CREATE COMMAND. CREATING SPACE NAMED ", spaceName);
          const roomNameLocalPart = kcUserGroups[0].slug + "-allgemein11";
          const roomName = "#" + roomNameLocalPart + ":" + MX_HS_URL;
          let roomExists;
          let spaceExists;
          // Check if Space exists

          try {
            const existingSpace = await mxClient.getRoomIdForAlias(spaceName);
            console.log("Space exists", existingSpace);
          } catch (e) {
            // Create space
            const spaceResponse = await mxClient.createRoom({
              name: kcUserGroups[0].name,
              room_alias_name: spaceNameLocalPart,
              topic: "Space für " + kcUserGroups[0].name,
              creation_content: { type: "m.space" },
            });
            console.log("Created space", spaceResponse);
            spaceExists = spaceResponse.room_id;
          }

          try {
            const existingRoom = await mxClient.getRoomIdForAlias(roomName);
            console.log("Room exists", existingRoom);
          } catch (e) {
            // Create room
            const roomResponse = await mxClient.createRoom({
              name: kcUserGroups[0].name + " Allgemein",
              room_alias_name: roomNameLocalPart,
              topic: "Allgemeiner Raum für " + kcUserGroups[0].name,
            });
            console.log("Created room", roomResponse);
            roomExists = roomResponse.room_id;
          }

          if (roomExists && spaceExists) {
            const rel1 = await mxClient.sendStateEvent(
              spaceExists,
              "m.space.child",
              {
                via: MX_HS_URL,
                suggested: true
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
            console.log("rel1", rel1);
            console.log("rel2", rel2);
          }

          // Invite to Room
          spaceExists && mxClient.invite(spaceExists, senderId);
          roomExists && mxClient.invite(roomExists, senderId);

          // try {
          //     inviteToMatrixRoom(userMxId, spaceId);
          //     inviteToMatrixRoom(userMxId, roomId);
          // } catch (Exception e) {
          //     log.info(e);
          // }
        }
      }
    }
  );
})();

// const getKcGroupsForMxId = async (mxId: string) => {
//   const synapseUser = (await synapseClient.getUser(
//     mxId
//   )) as ExtendedSynapseUser;

//   const kcId = synapseUser.external_ids.find(
//     (entry) => entry.auth_provider === "oidc-keycloak"
//   )?.external_id;

//   if (kcId) {
//     const kcUserGroups = (
//       await kcAdminClient.users.listGroups({
//         id: kcId,
//         briefRepresentation: false,
//       })
//     ).map((groupObject) => ({
//       slug: groupObject?.attributes?.workshopSlug[0],
//       name: groupObject?.attributes?.workshopName[0],
//     }));

//     return kcUserGroups;
//   }
//   return null;
// };
