import fs from "fs/promises";
import path from "path";
import inquirer from "inquirer";
import { CliConfig } from "./config";

export interface SetupAnswers {
  apiUrl: string;
  apiKey: string;
  overwrite: boolean;
}

export function buildMomorcContent(config: CliConfig): string {
  return [
    `MOMO_API_URL=${config.apiUrl}`,
    `MOMO_API_KEY=${config.apiKey}`,
    "",
  ].join("\n");
}

export function getMomorcPath(): string {
  return path.resolve(__dirname, "..", ".momorc");
}

async function readExistingConfig(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function runSetupWizard(): Promise<CliConfig> {
  const momorcPath = getMomorcPath();
  const exists = await readExistingConfig(momorcPath);

  const answers = await inquirer.prompt<SetupAnswers>([
    {
      type: "input",
      name: "apiUrl",
      message: "Admin API endpoint",
      default: process.env.MOMO_API_URL ?? "http://localhost:3000",
      validate: (value: string) => {
        const trimmed = value.trim();
        if (!trimmed) {
          return "API endpoint is required";
        }

        try {
          new URL(trimmed);
          return true;
        } catch {
          return "Enter a valid URL such as http://localhost:3000";
        }
      },
      filter: (value: string) => value.trim(),
    },
    {
      type: "password",
      name: "apiKey",
      message: "Admin API key",
      mask: "*",
      validate: (value: string) =>
        value.trim().length > 0 ? true : "API key is required",
      filter: (value: string) => value.trim(),
    },
    {
      type: "confirm",
      name: "overwrite",
      message: exists
        ? `cli/.momorc already exists. Overwrite it?`
        : `Write cli/.momorc with these settings?`,
      default: true,
      when: () => exists,
    },
  ]);

  if (exists && !answers.overwrite) {
    throw new Error("Setup cancelled");
  }

  const config: CliConfig = {
    apiUrl: answers.apiUrl,
    apiKey: answers.apiKey,
  };

  await fs.writeFile(momorcPath, buildMomorcContent(config), "utf8");

  return config;
}
