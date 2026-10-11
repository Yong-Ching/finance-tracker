import type { Parser } from "./types";
import { dbsParser } from "./dbs";
import { citibankParser } from "./citibank";
import { youtripParser } from "./youtrip";

/** Every parser the app knows. */
export const PARSERS: Parser[] = [dbsParser, citibankParser, youtripParser];

export interface Detection {
  parser: Parser;
  confidence: number;
}

/** Ranked guesses at which parser understands this document. */
export function detectParsers(text: string): Detection[] {
  return PARSERS.map((parser) => ({ parser, confidence: parser.detect(text) }))
    .filter((d) => d.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence);
}

export * from "./types";
