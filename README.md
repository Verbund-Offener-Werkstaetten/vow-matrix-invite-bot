# vow-matrix-invite-bot

Sequence diagram of the invite logic behind this project:
```mermaid
flowchart TD
    A[User joins monitored room] -->B[User known to Keycloak?]
    B -->|Yes| C[Check Groups]
    B -->|No| D[Do nothing]
    C -->|Crew| E[Space exists?]
    C -->|Owner| F[Space exists?]
    E -->|Yes| G[Invite]
    E -->|No| H[Do nothing]
    F -->|Yes| G
    F -->|No| J[Create Space and Invite]
 ```

## Local development setup
To test/develop this project locally, you need to have Node.js installed (for correct version, see .nvmrc). Just clone the repo, switch to the new folder and run `npm install`. Now add/adjust your `.env` file and then run `npm run dev`.

## Production setup (via Docker)
- Clone the project
- Either create a `.env` file or set the environment variables inside of `docker-compose.yml`
- Run `docker-compose up`