export interface LocalAuthConfig {
  mode: "local";
  origins: string[];
}

export interface RemoteAuthConfig {
  mode: "remote";
  teamDomain: string;
  audience: string;
  ownerEmail: string;
  publicUrl: string;
  origins: string[];
}

export type AuthConfig = LocalAuthConfig | RemoteAuthConfig;

export function parseAuthConfig(
  env: Record<string, string | undefined>,
): AuthConfig {
  const mode = env.CODEX_WEB_AUTH_MODE ?? "local";
  if (mode === "local") {
    const origins = splitOrigins(env.CODEX_WEB_LOCAL_ORIGINS ?? "");
    return {
      mode,
      origins:
        origins.length > 0
          ? origins
          : ["http://127.0.0.1:4173", "http://127.0.0.1:5173"],
    };
  }
  if (mode !== "remote") {
    throw new Error(`invalid auth mode: ${mode}`);
  }

  const teamDomain = env.CODEX_WEB_CF_TEAM_DOMAIN?.trim();
  const audience = env.CODEX_WEB_CF_AUDIENCE?.trim();
  const ownerEmail = env.CODEX_WEB_OWNER_EMAIL?.trim().toLowerCase();
  const publicUrl = env.CODEX_WEB_PUBLIC_URL?.trim();
  if (!teamDomain || !audience || !ownerEmail || !publicUrl) {
    throw new Error(
      "remote auth requires team domain, audience, owner email, and public URL",
    );
  }
  const origin = new URL(publicUrl).origin;
  if (!origin.startsWith("https://")) {
    throw new Error("remote auth public URL must use HTTPS");
  }
  return {
    mode,
    teamDomain: teamDomain.replace(/^https?:\/\//, "").replace(/\/$/, ""),
    audience,
    ownerEmail,
    publicUrl,
    origins: [origin],
  };
}

function splitOrigins(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => new URL(entry).origin);
}

