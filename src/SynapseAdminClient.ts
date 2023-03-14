interface SynapseUser {
  external_ids: Array<{ auth_provider: string; external_id: string }>;
  [x: string]: unknown;
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

  async doRequest<TResponse>(
    url: string,
    config: RequestInit = {}
  ): Promise<TResponse> {
    return fetch(url, {
      ...config,
      headers: { Authorization: "Bearer " + this.accessToken },
    })
      .then((response) => response.json())
      .then((data) => data as TResponse);
  }
}

export { SynapseAdminClient };
