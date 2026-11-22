function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

export function levenshteinDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  let current = new Array<number>(right.length + 1);

  for (let row = 1; row <= left.length; row += 1) {
    current[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] +
          (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    for (let column = 0; column <= right.length; column += 1) {
      previous[column] = current[column];
    }
  }

  return previous[right.length];
}

export function nameSimilarityScore(extractedName: string, submittedName: string): number {
  const extracted = normalizeName(extractedName);
  const submitted = normalizeName(submittedName);
  if (!extracted || !submitted) return 0;
  return 1 - levenshteinDistance(extracted, submitted) /
    Math.max(extracted.length, submitted.length);
}
