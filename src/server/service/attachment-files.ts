import { open } from "node:fs/promises";

import { AttachmentError } from "./attachment-error";

const MAX_NAME_BYTES = 120;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function sanitizeAttachmentName(value: string): string {
  const basename = value.normalize("NFC").split(/[\\/]/).at(-1) ?? "";
  let sanitized = basename
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!sanitized) sanitized = "attachment";
  if (WINDOWS_RESERVED_NAME.test(sanitized)) sanitized = `_${sanitized}`;

  let bounded = "";
  for (const character of sanitized) {
    if (byteLength(bounded + character) > MAX_NAME_BYTES) break;
    bounded += character;
  }
  return bounded || "attachment";
}

export async function classifyAttachment(
  filePath: string,
  prefix: Uint8Array,
): Promise<"text" | "pdf" | "image"> {
  if (isExecutable(prefix)) {
    throw new AttachmentError("invalidAttachment", "executable attachments are not supported");
  }
  if (
    startsWith(prefix, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    startsWith(prefix, [0xff, 0xd8, 0xff]) ||
    startsWith(prefix, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWith(prefix, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]) ||
    (startsWith(prefix, [0x52, 0x49, 0x46, 0x46]) &&
      matchesAt(prefix, 8, [0x57, 0x45, 0x42, 0x50]))
  ) {
    return "image";
  }
  if (startsWith(prefix, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf";

  await validateUtf8Text(filePath);
  return "text";
}

async function validateUtf8Text(filePath: string): Promise<void> {
  const handle = await open(filePath, "r");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const buffer = new Uint8Array(65_536);
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      if (chunk.includes(0)) {
        throw new AttachmentError("invalidAttachment", "binary attachments are not supported");
      }
      decoder.decode(chunk, { stream: true });
    }
    decoder.decode();
  } catch (error) {
    if (error instanceof AttachmentError) throw error;
    throw new AttachmentError("invalidAttachment", "attachment is not valid UTF-8 text");
  } finally {
    await handle.close();
  }
}

function isExecutable(value: Uint8Array): boolean {
  return startsWith(value, [0x4d, 0x5a]) ||
    startsWith(value, [0x7f, 0x45, 0x4c, 0x46]) ||
    [
      [0xfe, 0xed, 0xfa, 0xce],
      [0xfe, 0xed, 0xfa, 0xcf],
      [0xce, 0xfa, 0xed, 0xfe],
      [0xcf, 0xfa, 0xed, 0xfe],
      [0xca, 0xfe, 0xba, 0xbe],
      [0xbe, 0xba, 0xfe, 0xca],
    ].some((signature) => startsWith(value, signature));
}

function startsWith(value: Uint8Array, signature: number[]): boolean {
  return matchesAt(value, 0, signature);
}

function matchesAt(value: Uint8Array, offset: number, signature: number[]): boolean {
  return value.byteLength >= offset + signature.length &&
    signature.every((byte, index) => value[offset + index] === byte);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
