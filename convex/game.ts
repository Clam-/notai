import { v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

declare const process: { env: { ADMIN_PASSWORD?: string } };

const SESSION_KEY = "main";

type SessionDoc = Doc<"sessions">;
type EntryDoc = Doc<"entries">;
type UserDoc = Doc<"users">;

type OutputSegment = {
  text: string;
  roundNumber: number;
  mode: "admin" | "nextWord" | "followMe";
  authors: string[];
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

function userName(userNameById: Map<Id<"users">, string>, userId: Id<"users">) {
  return userNameById.get(userId) ?? "Unknown participant";
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
  const output = session?.endedOutput.trim();
  if (!session || session.status !== "ended" || !output) {
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
            summary: "Initial context added by Admin",
          },
        ]
      : [];

    segments.push(
      ...followEntries.map((entry): OutputSegment => {
        const author = userName(userNameById, entry.userId);
        return {
          text: entry.text || entry.words.join(" "),
          roundNumber: entry.roundNumber,
          mode: "followMe",
          authors: [author],
          summary: `Round ${entry.roundNumber}: added by ${author}`,
        };
      }),
    );

    return segments.filter((segment) => segment.text.trim());
  }

  if (session.mode === "nextWord") {
    const winners = includedNextWordWinners(output, recentEntries);
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
      segments.push({
        text: winner.word,
        roundNumber: winner.roundNumber,
        mode: "nextWord",
        authors,
        summary: `Round ${winner.roundNumber}: winning word submitted by ${authorText}`,
      });
    });

    return segments;
  }

  return [];
}

async function listJoinedUsers(ctx: MutationCtx) {
  const users = await ctx.db.query("users").collect();
  return users
    .filter((user) => user.status === "joined")
    .sort((a, b) => {
      const joinedA = a.joinedAt ?? a._creationTime;
      const joinedB = b.joinedAt ?? b._creationTime;
      return joinedA - joinedB;
    });
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
  await ctx.db.patch(session._id, {
    turnIndex: (session.turnIndex + 1) % joinedUsers.length,
    roundNumber: session.roundNumber + 1,
  });
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
    };
  },
});

export const getAdminState = query({
  args: { adminToken: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    if (!args.adminToken) {
      return { authorized: false, users: [], session: null, entries: [], outputSegments: [] };
    }

    const adminSession = await ctx.db
      .query("adminSessions")
      .withIndex("by_token", (q) => q.eq("token", args.adminToken ?? ""))
      .unique();
    if (!adminSession) {
      return { authorized: false, users: [], session: null, entries: [], outputSegments: [] };
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

    return {
      authorized: true,
      users: users.sort((a, b) => {
        const joinedA = a.joinedAt ?? a._creationTime;
        const joinedB = b.joinedAt ?? b._creationTime;
        return joinedA - joinedB;
      }),
      session,
      entries,
      outputSegments,
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
      return existing._id;
    }

    return await ctx.db.insert("users", {
      clientId: args.clientId,
      name,
      status: "waiting",
      joinedAt: null,
    });
  },
});

export const adminLogin = mutation({
  args: {
    password: v.string(),
    clientConfiguredPassword: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const configuredPassword = process.env.ADMIN_PASSWORD ?? args.clientConfiguredPassword;
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
    if (!startingWord) {
      throw new Error(seedKind === "topic" ? "Topic is required" : "Starting word is required");
    }

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

    const cleanedWords = args.words
      .map((word) => word.trim())
      .filter(Boolean)
      .slice(0, session.wordsPerRound);

    const [existing, ...duplicateEntries] = await entriesForUserRound(
      ctx,
      user._id,
      session.roundNumber,
      "nextWord",
    );
    await deleteEntries(ctx, duplicateEntries);

    const existingWords = existing?.words.map((word) => word.trim()).filter(Boolean) ?? [];
    if (existingWords.length >= session.wordsPerRound) {
      throw new Error("All words submitted");
    }

    const nextWords =
      existingWords.length > 0 && cleanedWords.length === 1
        ? [...existingWords, cleanedWords[0]]
        : cleanedWords;
    const limitedWords = nextWords.slice(0, session.wordsPerRound);
    if (limitedWords.length === 0) {
      throw new Error("Enter at least one word");
    }

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

    const joinedUsers = await listJoinedUsers(ctx);
    const roundEntries = await ctx.db
      .query("entries")
      .withIndex("by_roundNumber", (q) => q.eq("roundNumber", session.roundNumber))
      .collect();
    const submittedUserIds = new Set(
      roundEntries
        .filter((entry) => entry.mode === "nextWord" && entry.words.length >= session.wordsPerRound)
        .map((entry) => entry.userId),
    );

    if (
      joinedUsers.length > 0 &&
      joinedUsers.every((joinedUser) => submittedUserIds.has(joinedUser._id))
    ) {
      await advanceNextWordRound(ctx, session);
    }
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

    const joinedUsers = await listJoinedUsers(ctx);
    const currentUser = joinedUsers[session.turnIndex % joinedUsers.length];
    if (!currentUser || currentUser._id !== user._id) {
      throw new Error("It is not your turn");
    }

    const words = splitWords(args.text);
    if (words.length === 0) {
      throw new Error("Enter at least one word");
    }
    if (words.length > session.wordsEnteredPerRound) {
      throw new Error("Too many words");
    }

    await ctx.db.insert("entries", {
      roundNumber: session.roundNumber,
      mode: "followMe",
      userId: user._id,
      words,
      text: words.join(" "),
    });
    await ctx.db.patch(session._id, { context: appendContext(session.context, words.join(" ")) });

    const latestSession = await ctx.db.get(session._id);
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
    });
  },
});
