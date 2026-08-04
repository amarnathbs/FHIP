// Flags language that crosses from education into regulated personal advice.
const BANNED = [
  /\byou should buy\b/i,
  /\byou should sell\b/i,
  /\bswitch to\b/i,
  /\bwe recommend (buying|purchasing|investing in)\b/i,
  /\bguaranteed return\b/i,
];

export function violatesAdviceBoundary(text: string): boolean {
  return BANNED.some((rx) => rx.test(text));
}
