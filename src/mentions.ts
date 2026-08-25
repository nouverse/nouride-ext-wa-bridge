/**
 * Extract mention JIDs from text and explicit mentions.
 *
 * WhatsApp only turns a text tag (e.g. `@628123456789`) into a real notification link when
 * the outgoing payload includes `mentions: [jid]`.
 */
export function extractMentions(text: string, explicitMentions: string[] = []): string[] {
  const set = new Set<string>();

  for (const m of explicitMentions) {
    if (m) set.add(m);
  }

  const fullJidRegex = /@(\d+(?:@s\.whatsapp\.net|@lid))/gi;
  for (const match of text.matchAll(fullJidRegex)) {
    if (match[1]) set.add(match[1]);
  }

  const phoneRegex = /(?<=^|\s)@(\d{7,15})(?=\s|$|[.,!?])/g;
  for (const match of text.matchAll(phoneRegex)) {
    if (match[1]) set.add(`${match[1]}@s.whatsapp.net`);
  }

  return Array.from(set);
}

/**
 * Remove domain suffixes (@s.whatsapp.net, @lid) from mention tags in outgoing text.
 *
 * E.g. `@267199126233213@lid` becomes `@267199126233213`, which WhatsApp UI converts
 * to `@UserDisplayName` without leaving `@lid` as leftover trailing text.
 */
export function cleanMentionText(text: string): string {
  return text.replace(/@(\d+)(?:@s\.whatsapp\.net|@lid)/gi, "@$1");
}
