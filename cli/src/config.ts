import dotenv from "dotenv";
import fs from "fs";
import path from "path";

// Load .momorc from the cli/ directory, fall back to process.env
const MOMORC_PATH = path.resolve(__dirname, "..", ".momorc");
dotenv.config({ path: MOMORC_PATH });

export interface CliConfig {
  apiUrl: string;
  apiKey: string;
  telemetry?: boolean;
}

export interface Profile {
  name: string;
  apiUrl: string;
  apiKey: string;
}

export interface ProfilesFile {
  profiles: Profile[];
  activeProfile?: string;
}

const PROFILES_FILE = path.resolve(__dirname, "..", ".momo-profiles.json");

function loadProfiles(): ProfilesFile {
  if (!fs.existsSync(PROFILES_FILE)) {
    return { profiles: [] };
  }
  try {
    const content = fs.readFileSync(PROFILES_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return { profiles: [] };
  }
}

function saveProfiles(data: ProfilesFile): void {
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(data, null, 2), "utf-8");
}

export function getConfig(): CliConfig {
  const profiles = loadProfiles();
  let apiKey: string | undefined;
  let apiUrl: string | undefined;

  // If an active profile is set, use it
  if (profiles.activeProfile) {
    const activeProfile = profiles.profiles.find(
      (p) => p.name === profiles.activeProfile,
    );
    if (activeProfile) {
      apiUrl = activeProfile.apiUrl;
      apiKey = activeProfile.apiKey;
    }
  }

  // Fall back to environment variables
  if (!apiKey) {
    apiKey = process.env.MOMO_API_KEY;
  }
  if (!apiUrl) {
    apiUrl = process.env.MOMO_API_URL;
  }

  if (!apiKey) {
    throw new Error(
      "MOMO_API_KEY is required. Set it in cli/.momorc, as an environment variable, or use 'momo-cli profile save'.",
    );
  }

  return {
    apiUrl: apiUrl ?? "http://localhost:3000",
    apiKey,
    telemetry: getTelemetryEnabled(),
  };
}

/**
 * Returns whether anonymous telemetry collection is enabled.
 * Defaults to true if not explicitly set to "false".
 */
export function getTelemetryEnabled(): boolean {
  return process.env.MOMO_TELEMETRY !== "false";
}

/**
 * Persists the telemetry setting to the .momorc config file.
 * Reads existing key=value lines and upserts MOMO_TELEMETRY.
 */
export function setTelemetryEnabled(enabled: boolean): void {
  const value = enabled ? "true" : "false";

  let lines: string[] = [];

  // Read existing .momorc if it exists
  if (fs.existsSync(MOMORC_PATH)) {
    lines = fs.readFileSync(MOMORC_PATH, "utf-8").split("\n");
  }

  const key = "MOMO_TELEMETRY";
  const entry = `${key}=${value}`;
  const idx = lines.findIndex((l) => l.trimStart().startsWith(`${key}=`));

  if (idx !== -1) {
    lines[idx] = entry;
  } else {
    lines.push(entry);
  }

  const content =
    lines
      .filter((l, i) => l.trim() !== "" || i < lines.length - 1)
      .join("\n")
      .trimEnd() + "\n";
  fs.writeFileSync(MOMORC_PATH, content, "utf-8");

  // Keep the current process in sync without a restart
  process.env[key] = value;
}

// ---------------------------------------------------------------------------
// Profile management
// ---------------------------------------------------------------------------

/**
 * Save (or overwrite) a named profile.
 */
export function saveProfile(
  name: string,
  apiUrl: string,
  apiKey: string,
): void {
  const data = loadProfiles();
  const existing = data.profiles.findIndex((p) => p.name === name);
  const profile: Profile = { name, apiUrl, apiKey };
  if (existing !== -1) {
    data.profiles[existing] = profile;
  } else {
    data.profiles.push(profile);
  }
  saveProfiles(data);
}

/**
 * Switch the active profile by name. Throws if the profile does not exist.
 */
export function useProfile(name: string): Profile {
  const data = loadProfiles();
  const profile = data.profiles.find((p) => p.name === name);
  if (!profile) {
    throw new Error(
      `Profile "${name}" not found. Use 'momo-cli profile list' to see available profiles.`,
    );
  }
  data.activeProfile = name;
  saveProfiles(data);
  return profile;
}

/**
 * Delete a named profile. Throws if the profile does not exist.
 */
export function deleteProfile(name: string): void {
  const data = loadProfiles();
  const idx = data.profiles.findIndex((p) => p.name === name);
  if (idx === -1) {
    throw new Error(`Profile "${name}" not found.`);
  }
  data.profiles.splice(idx, 1);
  if (data.activeProfile === name) {
    delete data.activeProfile;
  }
  saveProfiles(data);
}

/**
 * Return all profiles and the currently active profile name.
 */
export function listProfiles(): ProfilesFile {
  return loadProfiles();
}
