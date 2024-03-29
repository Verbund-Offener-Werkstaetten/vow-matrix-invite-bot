interface SynapseUser {
  external_ids: Array<{ auth_provider: string; external_id: string }>;
  [x: string]: unknown;
}

export interface SynapseMxId {
  user_id: string;
}

class SynapseAdminClient {
  readonly homeserverUrl: string;
  readonly accessToken: string;

  constructor(homeserverUrl: string, accessToken: string) {
    this.homeserverUrl = homeserverUrl;
    this.accessToken = accessToken;
  }

  async getUser(userId: string): Promise<SynapseUser> {
    return this.doRequest<SynapseUser>(
      "https://" +
        this.homeserverUrl +
        "/_synapse/admin/v2/users/" +
        encodeURIComponent(userId)
    );
  }

  async getMxIdFromKcId(
    authProvider: string,
    kcId: string
  ): Promise<SynapseMxId> {
    return this.doRequest<SynapseMxId>(
      "https://" +
        this.homeserverUrl +
        `/_synapse/admin/v1/auth_providers/${encodeURIComponent(
          authProvider
        )}/users/${encodeURIComponent(kcId)}`
    );
  }

  async doRequest<TResponse>(
    url: string,
    config: RequestInit = {}
  ): Promise<TResponse> {
    return fetch(url, {
      ...config,
      headers: { Authorization: "Bearer " + this.accessToken },
    })
      .then((response) => {
        if (!response.ok) {
          throw response;
        }

        return response.json();
      })
      .then((data) => data as TResponse);
  }
}

export { SynapseAdminClient };
