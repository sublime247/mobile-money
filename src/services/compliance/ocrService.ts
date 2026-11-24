import {
  DetectDocumentTextCommand,
  TextractClient,
} from "@aws-sdk/client-textract";
import { awsConfig } from "../../config/aws";
import { nameSimilarityScore } from "./nameMatcher";

export interface ExtractedIdentityFields {
  fullName: string | null;
  dateOfBirth: string | null;
  text: string;
}

export interface IdentityDetails {
  fullName: string;
  dateOfBirth: string;
}

export interface IdentityVerification {
  nameSimilarity: number;
  dateOfBirthMatches: boolean;
  manualReviewRequired: boolean;
}

const textractClient = new TextractClient({ region: awsConfig.region });

function normalizeDate(value: string): string | null {
  const trimmed = value.trim();
  const namedMonth = trimmed.match(/^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/i);
  if (namedMonth) {
    const month = new Date(`${namedMonth[2]} 1, 2000`).getMonth() + 1;
    if (Number.isNaN(month)) return null;
    return normalizeDate(
      `${namedMonth[3]}-${String(month).padStart(2, "0")}-${namedMonth[1].padStart(2, "0")}`,
    );
  }

  const iso = trimmed.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  let normalized: string | null = null;
  if (iso) {
    normalized = `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  } else {
    const dayFirst = trimmed.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
    if (dayFirst) {
      normalized = `${dayFirst[3]}-${dayFirst[2].padStart(2, "0")}-${dayFirst[1].padStart(2, "0")}`;
    }
  }

  if (!normalized) return null;
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== normalized
    ? null
    : normalized;
}

function labeledValue(lines: string[], label: RegExp): string | null {
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(label);
    if (match?.[1]?.trim()) return match[1].trim();
    if (match && lines[index + 1]) return lines[index + 1].trim();
  }
  return null;
}

export function parseIdentityText(text: string): ExtractedIdentityFields {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const labeledName = labeledValue(
    lines,
    /^(?:full\s*name|name)\s*[:\-]?\s*(.*)$/i,
  );
  const combinedName = [
    labeledValue(lines, /^given\s*names?\s*[:\-]?\s*(.*)$/i),
    labeledValue(lines, /^surname\s*[:\-]?\s*(.*)$/i),
  ]
    .filter(Boolean)
    .join(" ");
  const fullName = labeledName ?? (combinedName || null);
  const dateLine = labeledValue(
    lines,
    /^(?:date\s*of\s*birth|birth\s*date|dob)\s*[:\-]?\s*(.*)$/i,
  );
  const dateMatch = dateLine?.match(
    /\b(?:\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}|\d{1,2}\s+[a-z]+\s+\d{4})\b/i,
  );

  return {
    fullName,
    dateOfBirth: dateMatch ? normalizeDate(dateMatch[0]) : null,
    text,
  };
}

export function verifyIdentityFields(
  extracted: ExtractedIdentityFields,
  submitted: IdentityDetails,
): IdentityVerification {
  const nameSimilarity = extracted.fullName
    ? nameSimilarityScore(extracted.fullName, submitted.fullName)
    : 0;
  const extractedDate = extracted.dateOfBirth;
  const submittedDate = normalizeDate(submitted.dateOfBirth);
  const dateOfBirthMatches =
    extractedDate !== null &&
    submittedDate !== null &&
    extractedDate === submittedDate;

  return {
    nameSimilarity,
    dateOfBirthMatches,
    manualReviewRequired: nameSimilarity < 0.85 || !dateOfBirthMatches,
  };
}

export async function extractIdentityFields(
  image: Buffer,
  mimeType: string,
): Promise<ExtractedIdentityFields> {
  if (mimeType !== "image/jpeg" && mimeType !== "image/png" && mimeType !== "image/jpg") {
    throw new Error("OCR supports JPEG and PNG identity document images only");
  }
  if (image.length === 0) {
    throw new Error("Identity document image is empty");
  }

  const result = await textractClient.send(
    new DetectDocumentTextCommand({ Document: { Bytes: image } }),
  );
  const text = (result.Blocks ?? [])
    .filter((block) => block.BlockType === "LINE" && block.Text)
    .map((block) => block.Text)
    .join("\n");
  return parseIdentityText(text);
}

export async function extractAndVerifyIdentity(
  image: Buffer,
  mimeType: string,
  submitted: IdentityDetails,
): Promise<IdentityVerification> {
  return verifyIdentityFields(
    await extractIdentityFields(image, mimeType),
    submitted,
  );
}
