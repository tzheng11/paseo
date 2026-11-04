import { describe, expect, test } from "vitest";
import baseline from "../tests/secret-answer-letter-baselines.json" with { type: "json" };
import { redactSecretPrompt } from "./secret-answer.js";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SYMBOL_ALPHABET = `${LETTERS}0123456789!#$%&*@^~-_.?`;

function mulberry32(seed: number): () => number {
  return () => {
    let value = (seed = (seed + 0x6d2b79f5) >>> 0);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function draw(random: () => number, alphabet: string, length: number): string {
  let value = "";
  while (value.length < length) value += alphabet[Math.floor(random() * alphabet.length)]!;
  return value;
}

const POSITIONS = [
  { name: "password", tier: 1, frame: (value: string) => `password: ${value}` },
  { name: "quoted password", tier: 1, frame: (value: string) => `password: "${value}"` },
  { name: "JSON password", tier: 1, frame: (value: string) => `{"password":"${value}"}` },
  {
    name: "URL password",
    tier: 1,
    frame: (value: string) => `postgres://alice:${value}@example.test/db`,
  },
  { name: "token", tier: 2, frame: (value: string) => `token: ${value}` },
  { name: "quoted token", tier: 2, frame: (value: string) => `token: "${value}"` },
  { name: "JSON token", tier: 2, frame: (value: string) => `{"token":"${value}"}` },
];

describe("ruling 10 random-value rates", () => {
  test.each(baseline.rows)(
    "letter-only $prefix values at length $len seed $seed do not exceed reviewed baseline",
    ({ seed, prefix, len, n, oldPassword, oldToken }) => {
      const random = mulberry32(seed + len);
      const residue = { password: 0, token: 0 };
      for (let count = 0; count < n; ) {
        let value = draw(random, LETTERS, len);
        if (prefix === "lower-led") value = value[0]!.toLowerCase() + value.slice(1);
        if (prefix === "capital-led") value = value[0]!.toUpperCase() + value.slice(1);
        if (!/[a-z]/.test(value) || !/[A-Z]/.test(value)) continue;
        count += 1;
        for (const key of ["password", "token"] as const) {
          if (redactSecretPrompt(`${key}: ${value}`).includes(value)) residue[key] += 1;
        }
      }
      expect(residue.password, JSON.stringify({ seed, prefix, len })).toBeLessThanOrEqual(
        oldPassword,
      );
      expect(residue.token, JSON.stringify({ seed, prefix, len })).toBeLessThanOrEqual(oldToken);
    },
    30_000,
  );

  test.each([0x7491a8c3, 0x129cf73b, 0x8ad30e57])(
    "12-character symbol rates remain within their bar for seed %i",
    (seed) => {
      const random = mulberry32(seed);
      const residue = POSITIONS.map(() => 0);
      const count = 100_000;
      for (let index = 0; index < count; ) {
        const value = draw(random, SYMBOL_ALPHABET, 12);
        if (
          !/^[A-Za-z0-9]/.test(value) ||
          !/[A-Z]/.test(value) ||
          !/[a-z]/.test(value) ||
          !/\d/.test(value) ||
          !/[^A-Za-z0-9]/.test(value)
        )
          continue;
        index += 1;
        for (const [position, { frame }] of POSITIONS.entries()) {
          if (redactSecretPrompt(frame(value)).includes(value)) residue[position]! += 1;
        }
      }
      console.info(
        "ruling-10 symbol rates",
        JSON.stringify({
          seed,
          count,
          positions: POSITIONS.map((position, index) => ({
            name: position.name,
            kept: residue[index],
          })),
        }),
      );
      for (const [index, position] of POSITIONS.entries()) {
        expect(
          residue[index],
          `${position.name}: ${residue[index]}/${count}; seed=${seed}`,
        ).toBeLessThanOrEqual(position.tier === 1 ? 10 : 100);
      }
    },
    180_000,
  );

  test("human-style symbol passwords are protected in every tier-one position", () => {
    const values = new Set([
      "Summer&2024",
      "Welcome&123",
      "Monkey|2024",
      "Password&1234",
      "Football|12345",
      "WordWord2024!",
      "WordWord123!",
      "word123!",
    ]);
    for (const word of ["Summer", "Welcome", "Monkey", "Winter", "Fluffy", "Hunter"]) {
      for (const suffix of ["&2024", "|2024", "!2024", "2024!", ".2024", "?2024", "(2024)"]) {
        values.add(word + suffix);
      }
    }
    const tierOne = [
      ...POSITIONS.filter((position) => position.tier === 1),
      { name: "shell password", frame: (value: string) => `export PASSWORD=${value}` },
      { name: "password copula", frame: (value: string) => `the password is ${value}` },
    ];
    for (const value of values)
      for (const position of tierOne) {
        expect(
          redactSecretPrompt(position.frame(value)).includes(value),
          `${position.name}: ${value}`,
        ).toBe(false);
      }
  });
});
