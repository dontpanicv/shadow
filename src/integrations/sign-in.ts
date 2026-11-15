/** The OAuth callback on the address where people open Shadow. */
export const callbackAddress = (baseUrl: string) =>
  new URL("/api/v1/integrations/callback", baseUrl).href;
