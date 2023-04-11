# vow-matrix-invite-bot

This is an invite Bot for Matrix. Depending on the Keycloak groups of a given user, it will create and/or invite users to specific Matrix rooms and/or spaces.

It uses three APIs for this purpose (the [Matrix Client-Server API](https://spec.matrix.org/latest/client-server-api/), the [Synapse Admin API](https://matrix-org.github.io/synapse/latest/usage/administration/admin_api/) and the [Keycloak Admin API](https://www.keycloak.org/docs-api/21.0.2/rest-api/index.html)).

This bot consists of two separate and independent parts:

### 1. Sending a DM when a valid user enters a specific room

Sequence diagram of the DM logic:
```mermaid
flowchart TD
    A[User joins monitored room] -->B[User known to Keycloak?]
    B -->|Yes| C[Check Groups]
    B -->|No| D[Do nothing]
    C -->|Crew| E[Space exists?]
    C -->|Owner| F[Space exists?]
    E -->|Yes| G[Send 'Exists DM' & Invite]
    E -->|No| H[Do nothing]
    F -->|Yes| G
    F -->|No| J[Send 'Create DM']
 ```

### 2. Creating/inviting a user, when user sends a creation command



## Local development setup
To test/develop this project locally, you need to have Node.js installed (for correct version, see .nvmrc). Just clone the repo, switch to the new folder and run `npm install`. Now add/adjust your `.env` file and then run `npm run dev`.

## Production setup (via Docker)
- Clone the project
- Either create a `.env` file or set the environment variables inside of `docker-compose.yml`
- Run `docker-compose up`

## Problems/Todos
- Currently, message encryption is not supported, b/c there seems to be no way to extract a proper token from Synapse when using SSO login. The token that can be extracted from Element is device-specific does not work with encryption enabled.
- DM rooms with users a re not reused, so every time a user leaves and enters the monitored room, there will be a new DM room with the bot.