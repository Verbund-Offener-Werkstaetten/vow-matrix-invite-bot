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
