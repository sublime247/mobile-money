import { sha256Report } from "../security/reportSigner";

/** SHA-256 sums of payload files. The manifest and its detached signature exclude themselves. */
export function createAuditManifest(files: Map<string, Buffer>): Buffer {
  return Buffer.from(
    [...files.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, content]) => {
        if (
          !/^[a-zA-Z0-9_./-]+$/.test(name) ||
          name.split("/").includes("..")
        ) {
          throw new Error("Unsafe audit archive filename");
        }
        return `${sha256Report(content)}  ${name}\n`;
      })
      .join(""),
  );
}
