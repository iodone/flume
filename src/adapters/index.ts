import type { IncomingHttpHeaders } from "node:http";

import type { Envelope, JsonObject } from "../envelope.js";
import * as github from "./github.js";
import * as gitlab from "./gitlab.js";

export interface Adapter {
  readonly NAME: string;
  readonly SECRET_ENV: string;
  verify(headers: IncomingHttpHeaders, body: Buffer, secret: string | undefined): boolean;
  normalize(headers: IncomingHttpHeaders, body: Buffer, document: JsonObject): Envelope;
}

const ADAPTERS: readonly Adapter[] = [github, gitlab];

export function allAdapters(): readonly Adapter[] {
  return ADAPTERS;
}

export function getAdapter(name: string): Adapter | undefined {
  return ADAPTERS.find((adapter) => adapter.NAME === name);
}
