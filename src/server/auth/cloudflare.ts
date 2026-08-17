import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
} from "jose";

import type { RemoteAuthConfig } from "./config";

type VerifyKey = Parameters<typeof jwtVerify>[1];

const remoteKeySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function verifyCloudflareToken(
  token: string,
  config: RemoteAuthConfig,
  key: VerifyKey = remoteKeySet(config.teamDomain),
): Promise<JWTPayload & { email: string }> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, key, {
      issuer: `https://${config.teamDomain}`,
      audience: config.audience,
    }));
  } catch {
    throw new Error("notAuthenticated: invalid Cloudflare Access assertion");
  }
  const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
  if (email !== config.ownerEmail.toLowerCase()) {
    throw new Error("notAuthenticated: owner email mismatch");
  }
  return { ...payload, email };
}

function remoteKeySet(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  const existing = remoteKeySets.get(teamDomain);
  if (existing) return existing;
  const keySet = createRemoteJWKSet(
    new URL(`https://${teamDomain}/cdn-cgi/access/certs`),
  );
  remoteKeySets.set(teamDomain, keySet);
  return keySet;
}

