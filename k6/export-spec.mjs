// k6 can't parse YAML, so convert the OpenAPI spec to JSON for k6/examples.js.
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "yaml";

const source = new URL("../public/openapi.yaml", import.meta.url);
const target = new URL("./openapi.json", import.meta.url);

writeFileSync(target, JSON.stringify(parse(readFileSync(source, "utf8")), null, 2));
console.log(`Wrote ${target.pathname}`);
