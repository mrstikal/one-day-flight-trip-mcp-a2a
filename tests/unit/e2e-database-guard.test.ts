import { afterEach, describe, expect, it } from "vitest";
import { databaseUrlOrThrow } from "../e2e/_services.js";

const original = process.env.DATABASE_URL;

afterEach(() => {
  if (original === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = original;
  }
});

describe("e2e database guard", () => {
  it("refuses a database whose name does not end in _test", () => {
    process.env.DATABASE_URL = "postgres://user:secret@127.0.0.1:5442/odft";
    expect(() => databaseUrlOrThrow()).toThrow(/ends in _test/);
  });

  it("accepts a disposable _test database", () => {
    process.env.DATABASE_URL = "postgres://user:secret@127.0.0.1:5442/odft_e2e_test";
    expect(databaseUrlOrThrow()).toBe(process.env.DATABASE_URL);
  });

  it("requires DATABASE_URL", () => {
    delete process.env.DATABASE_URL;
    expect(() => databaseUrlOrThrow()).toThrow(/DATABASE_URL is required/);
  });

  it("rejects a non-postgres URL", () => {
    process.env.DATABASE_URL = "mysql://user:secret@127.0.0.1:3306/odft_e2e_test";
    expect(() => databaseUrlOrThrow()).toThrow(/valid postgres/);
  });

  it("rejects a URL without a database name", () => {
    process.env.DATABASE_URL = "postgres://user:secret@127.0.0.1:5442/";
    expect(() => databaseUrlOrThrow()).toThrow(/must include a database name/);
  });
});
