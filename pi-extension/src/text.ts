export const MAX_TOOL_OUTPUT_BYTES = 50 * 1024;
export const MAX_TOOL_OUTPUT_LINES = 2_000;

export interface TextTruncation {
  content: string;
  truncated: boolean;
  outputBytes: number;
  totalBytes: number;
  outputLines: number;
  totalLines: number;
}

export function truncateTextHead(
  text: string,
  options: { maxBytes: number; maxLines: number },
): TextTruncation {
  const totalBytes = Buffer.byteLength(text);
  const lines = text.split("\n");
  const totalLines = lines.length;
  const lineBounded = lines.slice(0, options.maxLines).join("\n");
  const content = truncateUtf8(lineBounded, options.maxBytes);
  const outputBytes = Buffer.byteLength(content);
  const outputLines = content.split("\n").length;

  return {
    content,
    truncated: totalBytes > outputBytes || totalLines > outputLines,
    outputBytes,
    totalBytes,
    outputLines,
    totalLines,
  };
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes}B`;
  const kibibytes = bytes / 1_024;
  if (kibibytes < 1_024) return `${trimDecimal(kibibytes)}KB`;
  return `${trimDecimal(kibibytes / 1_024)}MB`;
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;

  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle)) <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  let end = low;
  if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(0, end);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}
