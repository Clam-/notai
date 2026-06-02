import { v } from "convex/values";
import { env, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

const SESSION_KEY = "main";
const DEFAULT_KEEPALIVE_TIMEOUT_MS = 2 * 60 * 1000;
const KEEPALIVES_PER_TIMEOUT = 5;
const MIN_KEEPALIVE_TIMEOUT_MS = 15 * 1000;
const MAX_KEEPALIVE_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_WAKE_LOCK_MESSAGE_LENGTH = 160;

type SessionDoc = Doc<"sessions">;
type EntryDoc = Doc<"entries">;
type UserDoc = Doc<"users">;
type PresenceDoc = Doc<"presences">;
type WakeLockStatus = "unknown" | "active" | "unsupported" | "failed" | "released" | "inactive";

type OutputSegment = {
  text: string;
  roundNumber: number;
  mode: "admin" | "nextWord" | "followMe";
  authors: string[];
  choices: {
    userName: string;
    word: string;
    count: number;
    total: number;
    percent: number;
    picked: boolean;
  }[];
  summary: string;
};

type SeedKind = "startingWord" | "topic";

async function getSession(ctx: MutationCtx): Promise<SessionDoc> {
  const existing = await ctx.db
    .query("sessions")
    .withIndex("by_key", (q) => q.eq("key", SESSION_KEY))
    .unique();

  if (existing) {
    return existing;
  }

  const id = await ctx.db.insert("sessions", {
    key: SESSION_KEY,
    status: "idle",
    mode: "none",
    roundNumber: 1,
    currentWord: "",
    context: "",
    seedKind: "startingWord",
    seedText: "",
    wordsPerRound: 1,
    wordsShownPerRound: 0,
    wordsEnteredPerRound: 5,
    showToAll: false,
    turnIndex: 0,
    endedOutput: "",
    keepaliveTimeoutMs: DEFAULT_KEEPALIVE_TIMEOUT_MS,
  });
  const session = await ctx.db.get(id);
  if (!session) {
    throw new Error("Unable to create session");
  }
  return session;
}

async function requireAdmin(ctx: MutationCtx, token: string) {
  const adminSession = await ctx.db
    .query("adminSessions")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();

  if (!adminSession) {
    throw new Error("Admin access required");
  }
}

function cleanName(name: string) {
  return name.trim().replace(/\s+/g, " ").slice(0, 60);
}

function splitWords(text: string) {
  return text
    .trim()
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);
}

function appendContext(context: string, next: string) {
  const cleaned = next.trim();
  if (!cleaned) {
    return context;
  }
  return context ? `${context} ${cleaned}` : cleaned;
}

function cleanSeedKind(kind: string): SeedKind {
  return kind === "topic" ? "topic" : "startingWord";
}

function sessionKeepaliveTimeoutMs(session: Pick<SessionDoc, "keepaliveTimeoutMs"> | null | undefined) {
  return session?.keepaliveTimeoutMs ?? DEFAULT_KEEPALIVE_TIMEOUT_MS;
}

function keepaliveIntervalMs(timeoutMs: number) {
  return Math.max(1000, Math.floor(timeoutMs / KEEPALIVES_PER_TIMEOUT));
}

function clampKeepaliveTimeoutMs(timeoutMs: number) {
  if (!Number.isFinite(timeoutMs)) {
    return DEFAULT_KEEPALIVE_TIMEOUT_MS;
  }
  return Math.max(
    MIN_KEEPALIVE_TIMEOUT_MS,
    Math.min(MAX_KEEPALIVE_TIMEOUT_MS, Math.round(timeoutMs)),
  );
}

function presenceStatus(
  lastSeen: number | null,
  timeoutMs: number,
  now: number,
): "online" | "idle" | "offline" {
  if (lastSeen === null) {
    return "offline";
  }
  const age = now - lastSeen;
  if (age >= timeoutMs) {
    return "offline";
  }
  if (age >= keepaliveIntervalMs(timeoutMs) * 2) {
    return "idle";
  }
  return "online";
}

function presenceByUserId(presences: PresenceDoc[]) {
  return new Map(presences.map((presence) => [presence.userId, presence]));
}

function presenceViewsForUsers(users: UserDoc[], presences: PresenceDoc[], timeoutMs: number, now: number) {
  const presenceMap = presenceByUserId(presences);
  return users.map((user) => {
    const presence = presenceMap.get(user._id);
    const lastSeen = presence?.lastSeen ?? null;
    return {
      userId: user._id,
      lastSeen,
      status: presenceStatus(lastSeen, timeoutMs, now),
      wakeLockStatus: presence?.wakeLockStatus ?? "unknown",
      wakeLockMessage: presence?.wakeLockMessage ?? null,
      wakeLockUpdatedAt: presence?.wakeLockUpdatedAt ?? null,
    };
  });
}

function isUserActive(
  user: UserDoc,
  presenceByUser: Map<Id<"users">, PresenceDoc>,
  timeoutMs: number,
  now: number,
) {
  return presenceStatus(presenceByUser.get(user._id)?.lastSeen ?? null, timeoutMs, now) !== "offline";
}

function userName(userNameById: Map<Id<"users">, string>, userId: Id<"users">) {
  return userNameById.get(userId) ?? "Unknown participant";
}

function cleanWakeLockMessage(message: string | null) {
  return message ? message.trim().replace(/\s+/g, " ").slice(0, MAX_WAKE_LOCK_MESSAGE_LENGTH) : null;
}

async function upsertPresence(
  ctx: MutationCtx,
  user: Pick<UserDoc, "_id" | "clientId">,
  now: number,
) {
  const existing = await ctx.db
    .query("presences")
    .withIndex("by_clientId", (q) => q.eq("clientId", user.clientId))
    .unique();

  if (existing) {
    await ctx.db.patch(existing._id, { userId: user._id, lastSeen: now });
    return;
  }

  await ctx.db.insert("presences", {
    userId: user._id,
    clientId: user.clientId,
    lastSeen: now,
    wakeLockStatus: "unknown",
    wakeLockMessage: null,
    wakeLockUpdatedAt: now,
  });
}

async function entriesForUserRound(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  roundNumber: number,
  mode: EntryDoc["mode"],
) {
  const entries = await ctx.db
    .query("entries")
    .withIndex("by_userId_and_roundNumber", (q) =>
      q.eq("userId", userId).eq("roundNumber", roundNumber),
    )
    .collect();

  return entries
    .filter((entry) => entry.mode === mode)
    .sort((a, b) => b._creationTime - a._creationTime);
}

async function latestEntryForUserRound(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  roundNumber: number,
  mode: EntryDoc["mode"],
) {
  return (await entriesForUserRound(ctx, userId, roundNumber, mode))[0] ?? null;
}

async function deleteEntries(ctx: MutationCtx, entries: EntryDoc[]) {
  await Promise.all(entries.map((entry) => ctx.db.delete(entry._id)));
}

function namesForWinningWord(
  entries: EntryDoc[],
  winningWord: string,
  userNameById: Map<Id<"users">, string>,
) {
  const key = winningWord.toLocaleLowerCase();
  const names = entries
    .filter((entry) => entry.words.some((word) => word.trim().toLocaleLowerCase() === key))
    .map((entry) => userName(userNameById, entry.userId));
  return [...new Set(names)];
}

function nextWordChoicesForRound(
  entries: EntryDoc[],
  winningWord: string,
  userNameById: Map<Id<"users">, string>,
) {
  const submissions = entries.flatMap((entry) =>
    entry.words
      .map((word) => word.trim())
      .filter(Boolean)
      .map((word) => ({
        userName: userName(userNameById, entry.userId),
        word,
      })),
  );
  const total = submissions.length;
  const counts = submissions.reduce((nextCounts, submission) => {
    const key = submission.word.toLocaleLowerCase();
    nextCounts.set(key, (nextCounts.get(key) ?? 0) + 1);
    return nextCounts;
  }, new Map<string, number>());
  const winningKey = winningWord.toLocaleLowerCase();

  return submissions
    .map((submission) => {
      const key = submission.word.toLocaleLowerCase();
      const count = counts.get(key) ?? 0;
      return {
        ...submission,
        count,
        total,
        percent: total > 0 ? Math.round((count / total) * 100) : 0,
        picked: key === winningKey,
      };
    })
    .sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      if (a.picked !== b.picked) {
        return a.picked ? -1 : 1;
      }
      return `${a.word} ${a.userName}`.localeCompare(`${b.word} ${b.userName}`);
    });
}

function wordCountForEntry(entry: EntryDoc) {
  return (entry.text || entry.words.join(" ")).trim().split(/\s+/).filter(Boolean).length;
}

function winningEntryForRound(entries: EntryDoc[]) {
  const counts = new Map<string, { word: string; count: number; firstSeen: number }>();
  entries.forEach((entry) => {
    entry.words.forEach((word) => {
      const trimmed = word.trim();
      if (!trimmed) {
        return;
      }
      const key = trimmed.toLocaleLowerCase();
      const existing = counts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(key, { word: trimmed, count: 1, firstSeen: entry._creationTime });
      }
    });
  });

  return [...counts.values()].sort((a, b) => {
    if (b.count !== a.count) {
      return b.count - a.count;
    }
    return a.firstSeen - b.firstSeen;
  })[0];
}

function includedNextWordWinners(output: string, entries: EntryDoc[]) {
  const entriesByRound = new Map<number, EntryDoc[]>();
  entries
    .filter((entry) => entry.mode === "nextWord")
    .forEach((entry) => {
      entriesByRound.set(entry.roundNumber, [
        ...(entriesByRound.get(entry.roundNumber) ?? []),
        entry,
      ]);
    });

  const candidates = [...entriesByRound.entries()]
    .sort(([roundA], [roundB]) => roundA - roundB)
    .map(([roundNumber, roundEntries]) => {
      const winner = winningEntryForRound(roundEntries);
      return winner ? { roundNumber, word: winner.word } : null;
    })
    .filter((winner): winner is { roundNumber: number; word: string } => winner !== null);

  for (let count = candidates.length; count > 0; count -= 1) {
    const winners = candidates.slice(0, count);
    const appendedText = winners.map((winner) => winner.word).join(" ");
    if (!appendedText) {
      continue;
    }
    if (output === appendedText) {
      return winners;
    }
    const prefixLength = output.endsWith(` ${appendedText}`) ? output.length - appendedText.length : -1;
    if (prefixLength > 0 && output.slice(0, prefixLength).trim()) {
      return winners;
    }
  }

  return [];
}

function followMeEntriesForOutput(output: string, entries: EntryDoc[]) {
  const candidates = entries
    .filter((entry) => entry.mode === "followMe")
    .sort((a, b) => a._creationTime - b._creationTime);

  for (let start = candidates.length - 1; start >= 0; start -= 1) {
    const entryText = candidates
      .slice(start)
      .map((entry) => entry.text || entry.words.join(" "))
      .join(" ")
      .trim();
    if (entryText === output) {
      return candidates.slice(start);
    }
  }

  return candidates;
}

async function outputSegmentsForSession(
  ctx: QueryCtx,
  session: SessionDoc | null,
): Promise<OutputSegment[]> {
  const output =
    session?.status === "ended"
      ? session.endedOutput.trim()
      : session?.status === "active"
        ? session.context.trim()
        : "";
  if (!session || !output) {
    return [];
  }

  const [users, entries] = await Promise.all([
    ctx.db.query("users").take(500),
    ctx.db.query("entries").order("desc").take(2000),
  ]);
  const userNameById = new Map((users as UserDoc[]).map((user) => [user._id, user.name]));
  const recentEntries = entries.slice().reverse();

  if (session.mode === "followMe") {
    const followEntries = followMeEntriesForOutput(output, recentEntries).sort(
      (a, b) => a.roundNumber - b.roundNumber || a._creationTime - b._creationTime,
    );
    const appendedText = followEntries
      .map((entry) => entry.text || entry.words.join(" "))
      .join(" ")
      .trim();
    const initialText =
      appendedText && output.endsWith(appendedText)
        ? output.slice(0, output.length - appendedText.length).trim()
        : output;
    const segments: OutputSegment[] = session.seedKind === "topic"
      ? []
      : initialText
      ? [
          {
            text: initialText,
            roundNumber: 0,
            mode: "admin",
            authors: ["Admin"],
            choices: [],
            summary: "Initial context added by Admin",
          },
        ]
      : [];

    segments.push(
      ...followEntries.map((entry): OutputSegment => {
        const author = userName(userNameById, entry.userId);
        const wordCount = wordCountForEntry(entry);
        return {
          text: entry.text || entry.words.join(" "),
          roundNumber: entry.roundNumber,
          mode: "followMe",
          authors: [author],
          choices: [],
          summary: `Round ${entry.roundNumber}: ${wordCount} ${wordCount === 1 ? "word" : "words"} added by ${author}`,
        };
      }),
    );

    return segments.filter((segment) => segment.text.trim());
  }

  if (session.mode === "nextWord") {
    let winners = includedNextWordWinners(output, recentEntries);
    if (session.seedKind !== "topic") {
      while (winners.length > 0) {
        const candidateText = winners.map((winner) => winner.word).join(" ");
        const prefixLength = output.endsWith(` ${candidateText}`)
          ? output.length - candidateText.length
          : -1;
        if (prefixLength > 0 && output.slice(0, prefixLength).trim()) {
          break;
        }
        winners = winners.slice(0, -1);
      }
    }
    const appendedText = winners.map((winner) => winner.word).join(" ");
    const startingText = appendedText ? output.slice(0, output.length - appendedText.length).trim() : output;
    const segments: OutputSegment[] = session.seedKind === "topic"
      ? []
      : startingText
      ? [
          {
            text: startingText,
            roundNumber: 0,
            mode: "admin",
            authors: ["Admin"],
            choices: [],
            summary: "Starting word added by Admin",
          },
        ]
      : [];

    winners.forEach((winner) => {
      const roundEntries = recentEntries.filter(
        (entry) => entry.mode === "nextWord" && entry.roundNumber === winner.roundNumber,
      );
      const authors = namesForWinningWord(roundEntries, winner.word, userNameById);
      const authorText = authors.length > 0 ? authors.join(", ") : "Unknown participant";
      const choices = nextWordChoicesForRound(roundEntries, winner.word, userNameById);
      const matchingEntries = choices.find((choice) => choice.picked)?.count ?? 0;
      const totalChoices = choices[0]?.total ?? 0;
      segments.push({
        text: winner.word,
        roundNumber: winner.roundNumber,
        mode: "nextWord",
        authors,
        choices,
        summary: `Round ${winner.roundNumber}: winning word submitted by ${authorText}; ${matchingEntries}/${totalChoices} matching`,
      });
    });

    return segments;
  }

  return [];
}

async function listJoinedUsers(ctx: QueryCtx | MutationCtx) {
  const users = await ctx.db.query("users").collect();
  return users
    .filter((user) => user.status === "joined")
    .sort((a, b) => {
      const joinedA = a.joinedAt ?? a._creationTime;
      const joinedB = b.joinedAt ?? b._creationTime;
      return joinedA - joinedB;
    });
}

async function activeJoinedUsers(ctx: MutationCtx, session: SessionDoc, joinedUsers: UserDoc[]) {
  const timeoutMs = sessionKeepaliveTimeoutMs(session);
  const now = Date.now();
  const presenceMap = presenceByUserId(await ctx.db.query("presences").collect());
  return joinedUsers.filter((user) => isUserActive(user, presenceMap, timeoutMs, now));
}

async function advanceNextWordRound(ctx: MutationCtx, session: SessionDoc) {
  const entries = await ctx.db
    .query("entries")
    .withIndex("by_roundNumber", (q) => q.eq("roundNumber", session.roundNumber))
    .collect();
  const currentEntries = entries.filter((entry) => entry.mode === "nextWord");

  const counts = new Map<string, { word: string; count: number; firstSeen: number }>();
  currentEntries.forEach((entry) => {
    entry.words.forEach((word) => {
      const trimmed = word.trim();
      if (!trimmed) {
        return;
      }
      const key = trimmed.toLocaleLowerCase();
      const existing = counts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(key, { word: trimmed, count: 1, firstSeen: entry._creationTime });
      }
    });
  });

  const winner = [...counts.values()].sort((a, b) => {
    if (b.count !== a.count) {
      return b.count - a.count;
    }
    return a.firstSeen - b.firstSeen;
  })[0];

  const nextWord = winner?.word ?? session.currentWord;
  await ctx.db.patch(session._id, {
    currentWord: nextWord,
    context: winner ? appendContext(session.context, nextWord) : session.context,
    roundNumber: session.roundNumber + 1,
  });
}

async function advanceFollowMeTurn(ctx: MutationCtx, session: SessionDoc) {
  const joinedUsers = await listJoinedUsers(ctx);
  if (joinedUsers.length === 0) {
    return;
  }
  const activeUsers = await activeJoinedUsers(ctx, session, joinedUsers);
  const queue = activeUsers.length > 0 ? activeUsers : joinedUsers;
  const currentUser = joinedUsers[session.turnIndex % joinedUsers.length];
  const currentQueueIndex = currentUser
    ? queue.findIndex((user) => user._id === currentUser._id)
    : -1;
  const nextQueueIndex = currentQueueIndex >= 0 ? currentQueueIndex + 1 : 0;
  const nextUser = queue[nextQueueIndex % queue.length];
  const nextTurnIndex = joinedUsers.findIndex((user) => user._id === nextUser._id);

  await ctx.db.patch(session._id, {
    turnIndex: nextTurnIndex >= 0 ? nextTurnIndex : 0,
    roundNumber: session.roundNumber + 1,
  });
}

async function skipTimedOutFollowMeTurn(ctx: MutationCtx, session: SessionDoc) {
  const joinedUsers = await listJoinedUsers(ctx);
  if (joinedUsers.length === 0) {
    return;
  }

  const activeUsers = await activeJoinedUsers(ctx, session, joinedUsers);
  if (activeUsers.length === 0) {
    return;
  }

  const activeUserIds = new Set(activeUsers.map((user) => user._id));
  const currentIndex = session.turnIndex % joinedUsers.length;
  const currentUser = joinedUsers[currentIndex];
  if (currentUser && activeUserIds.has(currentUser._id)) {
    return;
  }

  for (let skipped = 1; skipped <= joinedUsers.length; skipped += 1) {
    const nextIndex = (currentIndex + skipped) % joinedUsers.length;
    if (activeUserIds.has(joinedUsers[nextIndex]._id)) {
      await ctx.db.patch(session._id, {
        turnIndex: nextIndex,
        roundNumber: session.roundNumber + skipped,
      });
      return;
    }
  }
}

async function maybeAdvanceNextWordRound(ctx: MutationCtx, session: SessionDoc) {
  const joinedUsers = await listJoinedUsers(ctx);
  const activeUsers = await activeJoinedUsers(ctx, session, joinedUsers);
  if (activeUsers.length === 0) {
    return;
  }

  const roundEntries = await ctx.db
    .query("entries")
    .withIndex("by_roundNumber", (q) => q.eq("roundNumber", session.roundNumber))
    .collect();
  const submittedUserIds = new Set(
    roundEntries
      .filter((entry) => entry.mode === "nextWord" && entry.words.length >= session.wordsPerRound)
      .map((entry) => entry.userId),
  );

  if (activeUsers.every((user) => submittedUserIds.has(user._id))) {
    await advanceNextWordRound(ctx, session);
  }
}

async function skipTimedOutTurns(ctx: MutationCtx, session: SessionDoc) {
  if (session.status !== "active") {
    return;
  }
  if (session.mode === "followMe") {
    await skipTimedOutFollowMeTurn(ctx, session);
  } else if (session.mode === "nextWord") {
    await maybeAdvanceNextWordRound(ctx, session);
  }
}

export const getParticipantState = query({
  args: { clientId: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
      .unique();
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_key", (q) => q.eq("key", SESSION_KEY))
      .unique();
    const timeoutMs = sessionKeepaliveTimeoutMs(session);
    const ownPresence = await ctx.db
      .query("presences")
      .withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
      .unique();
    const users = await ctx.db.query("users").collect();
    const joinedUsers = users
      .filter((item) => item.status === "joined")
      .sort((a, b) => {
        const joinedA = a.joinedAt ?? a._creationTime;
        const joinedB = b.joinedAt ?? b._creationTime;
        return joinedA - joinedB;
      });

    const ownEntry =
      user && session?.mode === "nextWord"
        ? await latestEntryForUserRound(ctx, user._id, session.roundNumber, "nextWord")
        : null;

    const turnUser =
      session && joinedUsers.length > 0
        ? joinedUsers[session.turnIndex % joinedUsers.length]
        : null;
    const ownIndex = user
      ? joinedUsers.findIndex((joinedUser) => joinedUser._id === user._id)
      : -1;
    const peopleInFront =
      session && ownIndex >= 0 && joinedUsers.length > 0
        ? (ownIndex - session.turnIndex + joinedUsers.length) % joinedUsers.length
        : null;

    const outputSegments = await outputSegmentsForSession(ctx, session);

    return {
      user,
      session,
      ownEntry,
      joinedCount: joinedUsers.length,
      isCurrentTurn: Boolean(user && turnUser && turnUser._id === user._id),
      peopleInFront,
      outputSegments,
      keepalive: {
        timeoutMs,
        intervalMs: keepaliveIntervalMs(timeoutMs),
        lastSeen: ownPresence?.lastSeen ?? null,
      },
    };
  },
});

export const getAdminState = query({
  args: { adminToken: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    if (!args.adminToken) {
      return {
        authorized: false,
        users: [],
        session: null,
        entries: [],
        outputSegments: [],
        presences: [],
        now: Date.now(),
        keepaliveTimeoutMs: DEFAULT_KEEPALIVE_TIMEOUT_MS,
        keepaliveIntervalMs: keepaliveIntervalMs(DEFAULT_KEEPALIVE_TIMEOUT_MS),
      };
    }

    const adminSession = await ctx.db
      .query("adminSessions")
      .withIndex("by_token", (q) => q.eq("token", args.adminToken ?? ""))
      .unique();
    if (!adminSession) {
      return {
        authorized: false,
        users: [],
        session: null,
        entries: [],
        outputSegments: [],
        presences: [],
        now: Date.now(),
        keepaliveTimeoutMs: DEFAULT_KEEPALIVE_TIMEOUT_MS,
        keepaliveIntervalMs: keepaliveIntervalMs(DEFAULT_KEEPALIVE_TIMEOUT_MS),
      };
    }

    const users = await ctx.db.query("users").collect();
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_key", (q) => q.eq("key", SESSION_KEY))
      .unique();
    const entries = session
      ? await ctx.db
          .query("entries")
          .withIndex("by_roundNumber", (q) => q.eq("roundNumber", session.roundNumber))
          .collect()
      : [];

    const outputSegments = await outputSegmentsForSession(ctx, session);
    const presences = await ctx.db.query("presences").collect();
    const now = Date.now();
    const timeoutMs = sessionKeepaliveTimeoutMs(session);
    const sortedUsers = users.sort((a, b) => {
      const joinedA = a.joinedAt ?? a._creationTime;
      const joinedB = b.joinedAt ?? b._creationTime;
      return joinedA - joinedB;
    });

    return {
      authorized: true,
      users: sortedUsers,
      session,
      entries,
      outputSegments,
      presences: presenceViewsForUsers(sortedUsers as UserDoc[], presences, timeoutMs, now),
      now,
      keepaliveTimeoutMs: timeoutMs,
      keepaliveIntervalMs: keepaliveIntervalMs(timeoutMs),
    };
  },
});

export const join = mutation({
  args: { clientId: v.string(), name: v.string() },
  handler: async (ctx, args) => {
    const name = cleanName(args.name);
    if (!name) {
      throw new Error("Name is required");
    }

    await getSession(ctx);
    const existing = await ctx.db
      .query("users")
      .withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { name });
      await upsertPresence(ctx, existing, Date.now());
      return existing._id;
    }

    const userId = await ctx.db.insert("users", {
      clientId: args.clientId,
      name,
      status: "waiting",
      joinedAt: null,
    });
    await upsertPresence(ctx, { _id: userId, clientId: args.clientId }, Date.now());
    return userId;
  },
});

export const heartbeat = mutation({
  args: { clientId: v.string() },
  handler: async (ctx, args) => {
    const session = await getSession(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
      .unique();
    if (user) {
      await upsertPresence(ctx, user, Date.now());
    }

    const latestSession = await ctx.db.get(session._id);
    if (latestSession) {
      await skipTimedOutTurns(ctx, latestSession);
    }

    const timeoutMs = sessionKeepaliveTimeoutMs(latestSession ?? session);
    return {
      timeoutMs,
      intervalMs: keepaliveIntervalMs(timeoutMs),
    };
  },
});

export const reportWakeLock = mutation({
  args: {
    clientId: v.string(),
    status: v.union(
      v.literal("active"),
      v.literal("unsupported"),
      v.literal("failed"),
      v.literal("released"),
      v.literal("inactive"),
    ),
    message: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
      .unique();
    if (!user) {
      return;
    }

    const now = Date.now();
    const existing = await ctx.db
      .query("presences")
      .withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
      .unique();
    const wakeLockStatus: WakeLockStatus = args.status;
    const wakeLockMessage = cleanWakeLockMessage(args.message);

    if (existing) {
      await ctx.db.patch(existing._id, {
        userId: user._id,
        wakeLockStatus,
        wakeLockMessage,
        wakeLockUpdatedAt: now,
      });
      return;
    }

    await ctx.db.insert("presences", {
      userId: user._id,
      clientId: args.clientId,
      lastSeen: now,
      wakeLockStatus,
      wakeLockMessage,
      wakeLockUpdatedAt: now,
    });
  },
});

export const adminLogin = mutation({
  args: {
    password: v.string(),
    clientConfiguredPassword: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const configuredPassword = env.ADMIN_PASSWORD ?? args.clientConfiguredPassword;
    if (!configuredPassword) {
      throw new Error("Admin password is not configured");
    }
    if (args.password !== configuredPassword) {
      throw new Error("Incorrect password");
    }

    const token = crypto.randomUUID();
    await ctx.db.insert("adminSessions", { token, createdAt: Date.now() });
    await getSession(ctx);
    return token;
  },
});

export const approveUser = mutation({
  args: { adminToken: v.string(), userId: v.id("users") },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.adminToken);
    await ctx.db.patch(args.userId, { status: "joined", joinedAt: Date.now() });
  },
});

export const kickUser = mutation({
  args: { adminToken: v.string(), userId: v.id("users") },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.adminToken);
    const user = await ctx.db.get(args.userId);
    if (!user) {
      return;
    }
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_key", (q) => q.eq("key", SESSION_KEY))
      .unique();
    const joinedUsersBeforeKick =
      session?.status === "active" && session.mode === "followMe" && user.status === "joined"
        ? await listJoinedUsers(ctx)
        : [];
    const currentUserBeforeKick =
      joinedUsersBeforeKick.length > 0
        ? joinedUsersBeforeKick[session!.turnIndex % joinedUsersBeforeKick.length]
        : null;
    const kickedUserIndex = joinedUsersBeforeKick.findIndex((joinedUser) => joinedUser._id === user._id);

    const entries = await ctx.db
      .query("entries")
      .withIndex("by_userId_and_roundNumber", (q) => q.eq("userId", args.userId))
      .collect();
    await Promise.all(entries.map((entry) => ctx.db.delete(entry._id)));

    const presence = await ctx.db
      .query("presences")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .unique();
    if (presence) {
      await ctx.db.delete(presence._id);
    }

    await ctx.db.delete(user._id);

    if (session?.status === "active" && session.mode === "followMe" && user.status === "joined") {
      const joinedUsers = await listJoinedUsers(ctx);
      if (joinedUsers.length === 0) {
        await ctx.db.patch(session._id, { turnIndex: 0 });
        return;
      }

      if (currentUserBeforeKick && currentUserBeforeKick._id !== user._id) {
        const currentTurnIndex = joinedUsers.findIndex(
          (joinedUser) => joinedUser._id === currentUserBeforeKick._id,
        );
        await ctx.db.patch(session._id, {
          turnIndex: currentTurnIndex >= 0 ? currentTurnIndex : session.turnIndex % joinedUsers.length,
        });
        return;
      }

      await ctx.db.patch(session._id, {
        turnIndex: kickedUserIndex >= 0 ? kickedUserIndex % joinedUsers.length : session.turnIndex % joinedUsers.length,
      });
    }
  },
});

export const configureKeepalive = mutation({
  args: { adminToken: v.string(), timeoutMs: v.number() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.adminToken);
    const session = await getSession(ctx);
    const timeoutMs = clampKeepaliveTimeoutMs(args.timeoutMs);
    await ctx.db.patch(session._id, { keepaliveTimeoutMs: timeoutMs });
    return {
      timeoutMs,
      intervalMs: keepaliveIntervalMs(timeoutMs),
    };
  },
});

export const startNextWord = mutation({
  args: {
    adminToken: v.string(),
    wordsPerRound: v.number(),
    startingWord: v.string(),
    seedKind: v.string(),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.adminToken);
    const session = await getSession(ctx);
    const startingWord = args.startingWord.trim();
    const seedKind = cleanSeedKind(args.seedKind);

    await deleteEntries(ctx, await ctx.db.query("entries").collect());
    await ctx.db.patch(session._id, {
      status: "active",
      mode: "nextWord",
      roundNumber: 1,
      currentWord: startingWord,
      context: seedKind === "topic" ? "" : startingWord,
      seedKind,
      seedText: startingWord,
      wordsPerRound: Math.max(1, Math.min(10, Math.floor(args.wordsPerRound))),
      endedOutput: "",
      turnIndex: 0,
    });
  },
});

export const startFollowMe = mutation({
  args: {
    adminToken: v.string(),
    wordsShownPerRound: v.number(),
    wordsEnteredPerRound: v.number(),
    initialContext: v.string(),
    seedKind: v.string(),
    showToAll: v.boolean(),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.adminToken);
    const session = await getSession(ctx);
    const initialContext = args.initialContext.trim();
    const seedKind = cleanSeedKind(args.seedKind);

    await deleteEntries(ctx, await ctx.db.query("entries").collect());
    await ctx.db.patch(session._id, {
      status: "active",
      mode: "followMe",
      roundNumber: 1,
      currentWord: "",
      context: seedKind === "topic" ? "" : initialContext,
      seedKind,
      seedText: initialContext,
      wordsShownPerRound: Math.max(0, Math.min(30, Math.floor(args.wordsShownPerRound))),
      wordsEnteredPerRound: Math.max(1, Math.min(50, Math.floor(args.wordsEnteredPerRound))),
      showToAll: args.showToAll,
      turnIndex: 0,
      endedOutput: "",
    });
  },
});

export const submitNextWord = mutation({
  args: { clientId: v.string(), words: v.array(v.string()) },
  handler: async (ctx, args) => {
    const session = await getSession(ctx);
    if (session.status !== "active" || session.mode !== "nextWord") {
      throw new Error("Next Word is not active");
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
      .unique();
    if (!user || user.status !== "joined") {
      throw new Error("You are not joined");
    }
    await upsertPresence(ctx, user, Date.now());

    const submittedWords = args.words.length > 0 ? args.words : [""];
    const cleanedWords = submittedWords
      .map((word) => word.trim())
      .slice(0, session.wordsPerRound);

    const [existing, ...duplicateEntries] = await entriesForUserRound(
      ctx,
      user._id,
      session.roundNumber,
      "nextWord",
    );
    await deleteEntries(ctx, duplicateEntries);

    const existingWords = existing?.words.map((word) => word.trim()) ?? [];
    if (existingWords.length >= session.wordsPerRound) {
      throw new Error("All words submitted");
    }

    const nextWords =
      existingWords.length > 0 && cleanedWords.length === 1
        ? [...existingWords, cleanedWords[0]]
        : cleanedWords;
    const limitedWords = nextWords.slice(0, session.wordsPerRound);

    if (existing) {
      await ctx.db.patch(existing._id, { words: limitedWords, text: "" });
    } else {
      await ctx.db.insert("entries", {
        roundNumber: session.roundNumber,
        mode: "nextWord",
        userId: user._id,
        words: limitedWords,
        text: "",
      });
    }

    await maybeAdvanceNextWordRound(ctx, session);
  },
});

export const submitFollowMe = mutation({
  args: { clientId: v.string(), text: v.string() },
  handler: async (ctx, args) => {
    const session = await getSession(ctx);
    if (session.status !== "active" || session.mode !== "followMe") {
      throw new Error("Follow Me is not active");
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
      .unique();
    if (!user || user.status !== "joined") {
      throw new Error("You are not joined");
    }
    await upsertPresence(ctx, user, Date.now());
    await skipTimedOutTurns(ctx, session);

    const currentSession = (await ctx.db.get(session._id)) ?? session;
    const joinedUsers = await listJoinedUsers(ctx);
    const currentUser = joinedUsers[currentSession.turnIndex % joinedUsers.length];
    if (!currentUser || currentUser._id !== user._id) {
      throw new Error("It is not your turn");
    }

    const words = splitWords(args.text);
    if (words.length === 0) {
      throw new Error("Enter at least one word");
    }
    if (words.length > currentSession.wordsEnteredPerRound) {
      throw new Error("Too many words");
    }

    await ctx.db.insert("entries", {
      roundNumber: currentSession.roundNumber,
      mode: "followMe",
      userId: user._id,
      words,
      text: words.join(" "),
    });
    await ctx.db.patch(currentSession._id, {
      context: appendContext(currentSession.context, words.join(" ")),
    });

    const latestSession = await ctx.db.get(currentSession._id);
    if (latestSession) {
      await advanceFollowMeTurn(ctx, latestSession);
    }
  },
});

export const nextTurn = mutation({
  args: { adminToken: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.adminToken);
    const session = await getSession(ctx);
    if (session.status !== "active") {
      return;
    }
    if (session.mode === "nextWord") {
      await advanceNextWordRound(ctx, session);
    } else if (session.mode === "followMe") {
      await advanceFollowMeTurn(ctx, session);
    }
  },
});

export const endGame = mutation({
  args: { adminToken: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.adminToken);
    const session = await getSession(ctx);
    await ctx.db.patch(session._id, { status: "ended", endedOutput: session.context });
  },
});

export const resetSession = mutation({
  args: { adminToken: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.adminToken);

    const users = await ctx.db.query("users").collect();
    await Promise.all(users.map((user) => ctx.db.delete(user._id)));
    const entries = await ctx.db.query("entries").collect();
    await Promise.all(entries.map((entry) => ctx.db.delete(entry._id)));
    const presences = await ctx.db.query("presences").collect();
    await Promise.all(presences.map((presence) => ctx.db.delete(presence._id)));
    const session = await getSession(ctx);
    await ctx.db.patch(session._id, {
      status: "idle",
      mode: "none",
      roundNumber: 1,
      currentWord: "",
      context: "",
      seedKind: "startingWord",
      seedText: "",
      wordsPerRound: 1,
      wordsShownPerRound: 0,
      wordsEnteredPerRound: 5,
      showToAll: false,
      turnIndex: 0,
      endedOutput: "",
      keepaliveTimeoutMs: DEFAULT_KEEPALIVE_TIMEOUT_MS,
    });
  },
});
