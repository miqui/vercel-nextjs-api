import { beforeEach } from "vitest";
import { resetMemoryKV } from "@/lib/kv";
import { resetMemoryRateLimits } from "@/lib/ratelimit";

beforeEach(() => {
  resetMemoryKV();
  resetMemoryRateLimits();
});
