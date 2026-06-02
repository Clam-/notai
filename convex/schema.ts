import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    clientId: v.string(),
    name: v.string(),
    status: v.union(
      v.literal("waiting"),
      v.literal("transitioning"),
      v.literal("joined"),
    ),
    joinedAt: v.union(v.number(), v.null()),
  })
    .index("by_clientId", ["clientId"])
    .index("by_status", ["status"]),

  sessions: defineTable({
    key: v.string(),
    status: v.union(v.literal("idle"), v.literal("active"), v.literal("ended")),
    mode: v.union(v.literal("none"), v.literal("nextWord"), v.literal("followMe")),
    roundNumber: v.number(),
    currentWord: v.string(),
    context: v.string(),
    seedKind: v.optional(v.union(v.literal("startingWord"), v.literal("topic"))),
    seedText: v.optional(v.string()),
    wordsPerRound: v.number(),
    wordsShownPerRound: v.number(),
    wordsEnteredPerRound: v.number(),
    showToAll: v.boolean(),
    topicHideAfterTurns: v.optional(v.number()),
    topicFirstOnly: v.optional(v.boolean()),
    turnIndex: v.number(),
    endedOutput: v.string(),
    keepaliveTimeoutMs: v.optional(v.number()),
  }).index("by_key", ["key"]),

  entries: defineTable({
    roundNumber: v.number(),
    mode: v.union(v.literal("nextWord"), v.literal("followMe")),
    userId: v.id("users"),
    words: v.array(v.string()),
    text: v.string(),
  })
    .index("by_roundNumber", ["roundNumber"])
    .index("by_userId_and_roundNumber", ["userId", "roundNumber"]),

  adminSessions: defineTable({
    token: v.string(),
    createdAt: v.number(),
  }).index("by_token", ["token"]),

  presences: defineTable({
    userId: v.id("users"),
    clientId: v.string(),
    lastSeen: v.number(),
    wakeLockStatus: v.optional(
      v.union(
        v.literal("unknown"),
        v.literal("active"),
        v.literal("unsupported"),
        v.literal("failed"),
        v.literal("released"),
        v.literal("inactive"),
      ),
    ),
    wakeLockMessage: v.optional(v.union(v.string(), v.null())),
    wakeLockUpdatedAt: v.optional(v.number()),
  })
    .index("by_userId", ["userId"])
    .index("by_clientId", ["clientId"]),
});
