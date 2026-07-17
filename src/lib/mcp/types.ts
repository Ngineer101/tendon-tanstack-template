export const FREE_MCP_SERVER_LIMIT = 3;

export type McpConnectionStatus = "pending" | "connected" | "error";
export type McpAuthType = "none" | "oauth";

export interface McpConnectionDto {
  id: string;
  name: string;
  serverUrl: string;
  status: McpConnectionStatus;
  authType: McpAuthType;
  lastErrorCode: string | null;
  lastTestedAt: string | null;
  lastConnectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface McpConnectionListResponse {
  connections: McpConnectionDto[];
  limits: {
    used: number;
    maximum: number | null;
    unlimited: boolean;
  };
}

export interface McpConnectionMutationResponse {
  connection: McpConnectionDto;
  authorizationUrl?: string;
  connected?: boolean;
}

export interface McpCredentials {
  version: 1;
  accessToken: string;
  refreshToken?: string;
  tokenType: "Bearer";
  scope?: string;
  expiresAt?: number;
  clientId: string;
  clientSecret?: string;
  tokenEndpoint: string;
  tokenEndpointAuthMethod: "none" | "client_secret_basic" | "client_secret_post";
  resource: string;
}

export interface McpOauthPayload {
  version: 1;
  codeVerifier: string;
  clientId: string;
  clientSecret?: string;
  tokenEndpoint: string;
  tokenEndpointAuthMethod: "none" | "client_secret_basic" | "client_secret_post";
  redirectUri: string;
  resource: string;
}
