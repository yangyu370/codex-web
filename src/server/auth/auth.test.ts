import { describe, expect, test } from "bun:test";
import { generateKeyPair, SignJWT } from "jose";

import { parseAuthConfig } from "./config";
import { verifyCloudflareToken } from "./cloudflare";

describe("parseAuthConfig", () => {
  test("creates a loopback-only local mode with explicit origins", () => {
    expect(
      parseAuthConfig({
        CODEX_WEB_AUTH_MODE: "local",
        CODEX_WEB_LOCAL_ORIGINS: "http://127.0.0.1:4173,http://127.0.0.1:5173",
      }),
    ).toEqual({
      mode: "local",
      origins: ["http://127.0.0.1:4173", "http://127.0.0.1:5173"],
    });
  });

  test("remote mode fails closed when owner configuration is incomplete", () => {
    expect(() =>
      parseAuthConfig({ CODEX_WEB_AUTH_MODE: "remote" }),
    ).toThrow("remote auth requires team domain, audience, owner email, and public URL");
  });
});

describe("verifyCloudflareToken", () => {
  test("validates signature, issuer, audience, expiry, and owner email", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const token = await new SignJWT({ email: "owner@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer("https://team.cloudflareaccess.com")
      .setAudience("audience-1")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    await expect(
      verifyCloudflareToken(
        token,
        {
          mode: "remote",
          teamDomain: "team.cloudflareaccess.com",
          audience: "audience-1",
          ownerEmail: "owner@example.com",
          publicUrl: "https://codex.example.com",
          origins: ["https://codex.example.com"],
        },
        publicKey,
      ),
    ).resolves.toMatchObject({ email: "owner@example.com" });
  });

  test("rejects a valid token belonging to another user", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const token = await new SignJWT({ email: "other@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer("https://team.cloudflareaccess.com")
      .setAudience("audience-1")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    await expect(
      verifyCloudflareToken(
        token,
        {
          mode: "remote",
          teamDomain: "team.cloudflareaccess.com",
          audience: "audience-1",
          ownerEmail: "owner@example.com",
          publicUrl: "https://codex.example.com",
          origins: ["https://codex.example.com"],
        },
        publicKey,
      ),
    ).rejects.toThrow("notAuthenticated: owner email mismatch");
  });
});

