import { describe, expect, test } from "bun:test";
import { cleanMentionText, extractMentions } from "../src/mentions.ts";

describe("extractMentions", () => {
  test("extracts phone numbers prefixed with @ from text", () => {
    const text = "Reminder untuk @628123456789 besok jam 9 pagi";
    const mentions = extractMentions(text);
    expect(mentions).toEqual(["628123456789@s.whatsapp.net"]);
  });

  test("extracts full JIDs from text", () => {
    const text = "cc @267199126233213@lid dan @62899999999@s.whatsapp.net";
    const mentions = extractMentions(text);
    expect(mentions).toContain("267199126233213@lid");
    expect(mentions).toContain("62899999999@s.whatsapp.net");
  });

  test("combines explicit mentions with text mentions without duplicates", () => {
    const text = "halo @628123456789";
    const explicit = ["628123456789@s.whatsapp.net", "628999999999@s.whatsapp.net"];
    const mentions = extractMentions(text, explicit);
    expect(mentions).toEqual(["628123456789@s.whatsapp.net", "628999999999@s.whatsapp.net"]);
  });

  test("returns empty array when text has no mentions", () => {
    const text = "halo guys, selamat pagi!";
    expect(extractMentions(text)).toEqual([]);
  });
});

describe("cleanMentionText", () => {
  test("strips @lid domain suffix from mention tags", () => {
    const text = "@267199126233213@lid Jangan lupa jemput Kak Rina!";
    expect(cleanMentionText(text)).toBe("@267199126233213 Jangan lupa jemput Kak Rina!");
  });

  test("strips @s.whatsapp.net domain suffix from mention tags", () => {
    const text = "cc @628123456789@s.whatsapp.net tolong cek ini";
    expect(cleanMentionText(text)).toBe("cc @628123456789 tolong cek ini");
  });

  test("leaves plain @number tags untouched", () => {
    const text = "halo @628123456789 selamat pagi";
    expect(cleanMentionText(text)).toBe("halo @628123456789 selamat pagi");
  });
});
