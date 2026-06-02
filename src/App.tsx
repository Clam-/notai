import { FormEvent, useEffect, useRef, useState, type CSSProperties } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

const CLIENT_ID_KEY = "notai.clientId";
const NAME_KEY = "notai.name";
const ADMIN_TOKEN_KEY = "notai.adminToken";
const DEFAULT_KEEPALIVE_INTERVAL_MS = 24 * 1000;

type ParticipantState = NonNullable<ReturnType<typeof useQuery<typeof api.game.getParticipantState>>>;
type AdminState = NonNullable<ReturnType<typeof useQuery<typeof api.game.getAdminState>>>;
type AdminSession = AdminState["session"];
type AdminEntry = AdminState["entries"][number];
type AdminPresence = AdminState["presences"][number];
type OutputSegment = ParticipantState["outputSegments"][number] | AdminState["outputSegments"][number];
type SeedKind = "startingWord" | "topic";
type FollowPiece = {
  text: string;
  segment: OutputSegment;
  endsSentence: boolean;
};
type FollowParagraph = FollowPiece[];
type AuthorStyle = CSSProperties & {
  "--author-color": string;
  "--author-soft": string;
};
type WakeLockSentinel = EventTarget & {
  released: boolean;
  release: () => Promise<void>;
};
type NavigatorWithWakeLock = Navigator & {
  wakeLock?: {
    request: (type: "screen") => Promise<WakeLockSentinel>;
  };
};

function getClientId() {
  const existing = localStorage.getItem(CLIENT_ID_KEY);
  if (existing) {
    return existing;
  }
  const next = crypto.randomUUID();
  localStorage.setItem(CLIENT_ID_KEY, next);
  return next;
}

function Brand() {
  return (
    <div className="brand" aria-label="notai pretend">
      <span className="pretend">play pretend </span>
      <span className="strike">ai</span>
    </div>
  );
}

function choiceLabel(index: number, total: number) {
  if (total === 1) {
    return "Next word:";
  }
  const labels = ["First", "Second", "Third", "Fourth", "Fifth"];
  return `${labels[index] ?? `Choice ${index + 1}`} choice:`;
}

function visibleContext(context: string, wordsShownPerRound: number) {
  const words = context.trim().split(/\s+/).filter(Boolean);
  if (wordsShownPerRound === 0 || words.length <= wordsShownPerRound) {
    return context;
  }
  return words.slice(-wordsShownPerRound).join(" ");
}

function countWords(text: string) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function sentenceParts(text: string) {
  const matches = text.match(/[^.!?]+[.!?]+(?:["')\]]+)?|[^.!?]+$/g);
  return (matches ?? [text])
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => ({
      text: part,
      endsSentence: /[.!?]+["')\]]*$/.test(part),
    }));
}

function followParagraphs(segments: OutputSegment[]) {
  const paragraphs: FollowParagraph[] = [[]];
  let sentenceCount = 0;

  segments.forEach((segment) => {
    sentenceParts(segment.text).forEach((part) => {
      const paragraph = paragraphs[paragraphs.length - 1];
      paragraph.push({ ...part, segment });
      sentenceCount += part.endsSentence ? 1 : 0;
      if (sentenceCount >= 2) {
        paragraphs.push([]);
        sentenceCount = 0;
      }
    });
  });

  return paragraphs.filter((paragraph) => paragraph.length > 0);
}

function hashString(text: string) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function authorColor(author: string) {
  const hue = hashString(author) % 360;
  return {
    color: `hsl(${hue} 62% 42%)`,
    soft: `hsl(${hue} 74% 94%)`,
  };
}

function authorStyle(author: string): AuthorStyle {
  const color = authorColor(author);
  return {
    "--author-color": color.color,
    "--author-soft": color.soft,
  };
}

function seedKindForSession(session: { seedKind?: SeedKind } | null | undefined): SeedKind {
  return session?.seedKind === "topic" ? "topic" : "startingWord";
}

function topicForSession(
  session: { seedKind?: SeedKind; seedText?: string; currentWord?: string } | null | undefined,
) {
  if (seedKindForSession(session) !== "topic") {
    return "";
  }
  return (session?.seedText || session?.currentWord || "").trim();
}

function nextWordPrompt(session: NonNullable<ParticipantState["session"]>) {
  const isInitialTopic = seedKindForSession(session) === "topic" && session.roundNumber === 1;
  return {
    label: isInitialTopic ? "Topic" : "Current",
    text: isInitialTopic ? topicForSession(session) : session.currentWord,
  };
}

function oneLineInput(text: string) {
  return text.replace(/[\r\n]+/g, " ");
}

function useKeepalive(clientId: string, enabled: boolean, intervalMs: number) {
  const heartbeat = useMutation(api.game.heartbeat);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;
    let timer: number | undefined;
    const schedule = (delayMs: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(ping, Math.max(1000, delayMs));
    };
    const ping = async () => {
      try {
        const result = await heartbeat({ clientId });
        if (!cancelled) {
          schedule(result.intervalMs);
        }
      } catch {
        if (!cancelled) {
          schedule(intervalMs);
        }
      }
    };
    const pingNow = () => {
      if (!cancelled) {
        void ping();
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        pingNow();
      }
    };

    pingNow();
    window.addEventListener("focus", pingNow);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.removeEventListener("focus", pingNow);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [clientId, enabled, heartbeat, intervalMs]);
}

function useScreenWakeLock(enabled: boolean) {
  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;
    let sentinel: WakeLockSentinel | null = null;
    const requestWakeLock = async () => {
      const wakeLock = (navigator as NavigatorWithWakeLock).wakeLock;
      if (!wakeLock || document.visibilityState !== "visible") {
        return;
      }
      try {
        sentinel = await wakeLock.request("screen");
      } catch {
        sentinel = null;
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && !sentinel && !cancelled) {
        void requestWakeLock();
      }
    };

    void requestWakeLock();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      void sentinel?.release();
      sentinel = null;
    };
  }, [enabled]);
}

export default function App() {
  const [clientId] = useState(getClientId);
  const [savedName, setSavedName] = useState(() => localStorage.getItem(NAME_KEY) ?? "");
  const [adminOpen, setAdminOpen] = useState(false);
  const join = useMutation(api.game.join);
  const state = useQuery(api.game.getParticipantState, { clientId });
  const keepaliveIntervalMs = state?.keepalive.intervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;

  useKeepalive(clientId, Boolean(savedName), keepaliveIntervalMs);
  useScreenWakeLock(Boolean(savedName && state?.session?.status === "active"));

  useEffect(() => {
    if (!savedName || state?.user) {
      return;
    }
    void join({ clientId, name: savedName });
  }, [clientId, join, savedName, state?.user]);

  if (adminOpen) {
    return <AdminDashboard onClose={() => setAdminOpen(false)} />;
  }

  return (
    <main className="app-shell">
      <button
        className="key-button"
        aria-label="Open admin dashboard"
        title="Admin dashboard"
        onClick={() => setAdminOpen(true)}
      >
        &#128273;
      </button>

      <section className="stage">
        <Brand />
        {!savedName ? (
          <NameGate
            onJoin={async (name) => {
              localStorage.setItem(NAME_KEY, name);
              setSavedName(name);
              await join({ clientId, name });
            }}
          />
        ) : (
          <ParticipantView clientId={clientId} state={state} />
        )}
      </section>
    </main>
  );
}

function NameGate({ onJoin }: { onJoin: (name: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const cleaned = name.trim();
    if (!cleaned) {
      setError("Enter your name.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onJoin(cleaned);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="entry-panel" onSubmit={submit}>
      <label htmlFor="guest-name">Name</label>
      <input
        id="guest-name"
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Ada"
      />
      {error ? <p className="error">{error}</p> : null}
      <button className="primary" disabled={saving}>
        {saving ? "Joining..." : "Join"}
      </button>
    </form>
  );
}

function ParticipantView({
  clientId,
  state,
}: {
  clientId: string;
  state: ParticipantState | undefined;
}) {
  const submitNextWord = useMutation(api.game.submitNextWord);
  const submitFollowMe = useMutation(api.game.submitFollowMe);
  const [nextWordChoice, setNextWordChoice] = useState("");
  const [followText, setFollowText] = useState("");
  const [error, setError] = useState("");
  const nextWordInputRef = useRef<HTMLInputElement | null>(null);
  const followMeFormRef = useRef<HTMLFormElement | null>(null);
  const followMeTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  const session = state?.session;
  const user = state?.user;
  const wordsPerRound = session?.wordsPerRound ?? 1;

  useEffect(() => {
    setNextWordChoice("");
  }, [session?.roundNumber]);

  useEffect(() => {
    setFollowText("");
    setError("");
  }, [session?.roundNumber]);

  useEffect(() => {
    const submittedCount = state?.ownEntry?.words.length ?? 0;
    if (session?.mode === "nextWord" && submittedCount < wordsPerRound) {
      const frame = requestAnimationFrame(() => {
        nextWordInputRef.current?.focus();
      });
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [session?.mode, session?.roundNumber, state?.ownEntry?.words.length, wordsPerRound]);

  useEffect(() => {
    if (session?.mode === "followMe" && state?.isCurrentTurn) {
      const frame = requestAnimationFrame(() => {
        followMeTextareaRef.current?.focus();
      });
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [session?.mode, session?.roundNumber, state?.isCurrentTurn]);

  useEffect(() => {
    const textarea = followMeTextareaRef.current;
    if (!textarea || session?.mode !== "followMe" || !state?.isCurrentTurn) {
      return;
    }
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [followText, session?.mode, state?.isCurrentTurn]);

  if (!state || !session) {
    return <StatusPanel title="Joining..." />;
  }

  if (!user || user.status === "waiting" || user.status === "transitioning") {
    return <StatusPanel title="Joining..." />;
  }

  if (session.status === "idle") {
    return <StatusPanel title="Waiting to begin..." />;
  }

  if (session.status === "ended") {
    return <OutputPanel output={session.endedOutput} segments={state.outputSegments} topic={topicForSession(session)} />;
  }

  if (session.mode === "nextWord") {
    const submittedWords = state.ownEntry?.words ?? [];
    const submittedCount = submittedWords.length;
    const complete = submittedCount >= wordsPerRound;
    const prompt = nextWordPrompt(session);

    if (complete) {
      return <StatusPanel title="Waiting for next turn..." />;
    }

    return (
      <form
        className="game-panel"
        onSubmit={async (event) => {
          event.preventDefault();
          setError("");
          const cleaned = nextWordChoice.trim();
          try {
            await submitNextWord({ clientId, words: [cleaned] });
            setNextWordChoice("");
          } catch (err) {
            setError(err instanceof Error ? err.message : "Could not submit.");
          }
        }}
      >
        <p className="eyebrow">{prompt.label}</p>
        <h1>{prompt.text}</h1>
        <label>
          {choiceLabel(submittedCount, wordsPerRound)}
          <input
            ref={nextWordInputRef}
            value={nextWordChoice}
            onChange={(event) => setNextWordChoice(event.target.value)}
          />
        </label>
        {wordsPerRound > 1 ? (
          <p className="meter">
            {submittedCount}/{wordsPerRound} submitted
          </p>
        ) : null}
        {error ? <p className="error">{error}</p> : null}
        <button className="primary">Submit</button>
      </form>
    );
  }

  if (session.mode === "followMe") {
    const wordCount = countWords(followText);
    const limit = session.wordsEnteredPerRound;
    const currentTone =
      wordCount === 0
        ? "empty"
        : wordCount > limit
          ? "over"
          : wordCount >= limit * 0.75
            ? "warn"
            : "ok";
    const shouldShowContext = session.showToAll || state.isCurrentTurn;
    const topic = topicForSession(session);
    const context = visibleContext(session.context, session.wordsShownPerRound);

    if (!state.isCurrentTurn) {
      const peopleInFront = state.peopleInFront ?? 0;
      return (
        <div className="status-panel">
          {session.showToAll && topic ? <ContextBlock label="Topic" context={topic} /> : null}
          {session.showToAll && context ? <ContextBlock context={context} /> : null}
          <h1>{peopleInFront === 1 ? "Get ready! You are next." : "Waiting for turn..."}</h1>
          {peopleInFront > 1 ? <p>{peopleInFront} people in front</p> : null}
        </div>
      );
    }

    return (
      <form
        ref={followMeFormRef}
        className="game-panel"
        onSubmit={async (event) => {
          event.preventDefault();
          setError("");
          try {
            await submitFollowMe({ clientId, text: followText });
            setFollowText("");
          } catch (err) {
            setError(err instanceof Error ? err.message : "Could not submit.");
          }
        }}
      >
        {shouldShowContext && topic ? <ContextBlock label="Topic" context={topic} /> : null}
        {shouldShowContext && context ? <ContextBlock context={context} /> : null}
        <label>
          Next words:
          <textarea
            ref={followMeTextareaRef}
            className={`auto-grow-textarea tone-${currentTone}`}
            value={followText}
            onChange={(event) => setFollowText(oneLineInput(event.target.value))}
            onKeyDown={(event) => {
              if (event.key !== "Enter") {
                return;
              }
              event.preventDefault();
              if (!event.shiftKey && wordCount > 0 && wordCount <= limit) {
                followMeFormRef.current?.requestSubmit();
              }
            }}
            rows={1}
          />
        </label>
        <p className="meter">
          {wordCount}/{limit} words
        </p>
        {error ? <p className="error">{error}</p> : null}
        <button className="primary" disabled={wordCount === 0 || wordCount > limit}>
          Submit
        </button>
      </form>
    );
  }

  return <StatusPanel title="Waiting to begin..." />;
}

function StatusPanel({ title }: { title: string }) {
  return (
    <div className="status-panel">
      <h1>{title}</h1>
    </div>
  );
}

function OutputPanel({
  output,
  segments = [],
  topic = "",
}: {
  output: string;
  segments?: OutputSegment[];
  topic?: string;
}) {
  const visibleSegments = segments.filter((segment) => segment.text.trim());

  return (
    <div className="status-panel output">
      <p className="eyebrow">Final output</p>
      {topic ? <ContextBlock label="Topic" context={topic} /> : null}
      {output ? <OutputContent output={output} segments={visibleSegments} /> : <h1>No words were entered.</h1>}
    </div>
  );
}

function OutputContent({ output, segments }: { output: string; segments: OutputSegment[] }) {
  const visibleSegments = segments.filter((segment) => segment.text.trim());
  if (visibleSegments.some((segment) => segment.mode === "followMe")) {
    return <FollowMeOutput segments={visibleSegments} />;
  }

  return (
    <h1 className="attributed-output">
      <AttributedOutputText output={output} segments={visibleSegments} />
    </h1>
  );
}

function AttributedOutputText({ output, segments }: { output: string; segments: OutputSegment[] }) {
  const visibleSegments = segments.filter((segment) => segment.text.trim());

  if (visibleSegments.length === 0) {
    return output;
  }

  return (
    <>
      {visibleSegments.map((segment, index) => (
        <span className="output-segment-wrap" key={`${segment.roundNumber}-${index}-${segment.text}`}>
          <span
            className={`output-segment ${segment.mode === "nextWord" ? "output-segment-picked" : ""}`}
            tabIndex={0}
            aria-label={segment.summary}
          >
            {segment.text}
          </span>
          <SegmentPopup segment={segment} />
          {index < visibleSegments.length - 1 ? " " : null}
        </span>
      ))}
    </>
  );
}

function SegmentPopup({ segment }: { segment: OutputSegment }) {
  if (segment.mode === "nextWord" && segment.choices.length > 0) {
    return (
      <span className="segment-popup next-word-popup" role="tooltip">
        <span className="popup-title">Round {segment.roundNumber}:</span>
        {segment.choices.map((choice, index) => (
          <span
            className={`next-word-choice ${choice.picked ? "choice-picked" : "choice-unpicked"}`}
            key={`${choice.userName}-${choice.word}-${index}`}
          >
            <span>
              {choice.userName} - {choice.word}
            </span>
            <span>
              ({choice.count}/{choice.total} {choice.percent}%)
            </span>
          </span>
        ))}
      </span>
    );
  }

  return (
    <span className="segment-popup" role="tooltip">
      {segment.summary}
    </span>
  );
}

function FollowMeOutput({ segments }: { segments: OutputSegment[] }) {
  const [activeAuthor, setActiveAuthor] = useState<string | null>(null);
  const paragraphs = followParagraphs(segments);
  const authors = [
    ...new Map(
      segments.map((segment) => {
        const author = segment.authors[0] ?? "Unknown participant";
        return [author, author] as const;
      }),
    ).values(),
  ];
  const activeClass = activeAuthor ? " follow-output-highlighting" : "";

  return (
    <div className={`follow-output${activeClass}`}>
      <div className="follow-author-key" aria-label="Follow Me authors">
        {authors.map((author) => (
          <span
            className={`follow-author-key-item ${
              activeAuthor && activeAuthor !== author ? "follow-muted" : ""
            } ${activeAuthor === author ? "follow-active" : ""}`}
            style={authorStyle(author)}
            tabIndex={0}
            aria-label={`Highlight ${author}`}
            key={author}
            onBlur={() => setActiveAuthor(null)}
            onFocus={() => setActiveAuthor(author)}
            onMouseEnter={() => setActiveAuthor(author)}
            onMouseLeave={() => setActiveAuthor(null)}
          >
            <span className="follow-author-swatch" />
            {author}
          </span>
        ))}
      </div>
      <div className="follow-paragraphs">
        {paragraphs.map((paragraph, paragraphIndex) => (
          <p key={paragraph.map((piece) => piece.text).join(" ") || paragraphIndex}>
            {paragraph.map((piece, pieceIndex) => {
              const author = piece.segment.authors[0] ?? "Unknown participant";
              const highlighted = activeAuthor === author;
              const muted = Boolean(activeAuthor && !highlighted);
              return (
                <span key={`${piece.segment.roundNumber}-${pieceIndex}-${piece.text}`}>
                  <span
                    className={`follow-output-segment ${muted ? "follow-muted" : ""} ${
                      highlighted ? "follow-active" : ""
                    }`}
                    style={authorStyle(author)}
                    title={author}
                    tabIndex={0}
                    onBlur={() => setActiveAuthor(null)}
                    onFocus={() => setActiveAuthor(author)}
                    onMouseEnter={() => setActiveAuthor(author)}
                    onMouseLeave={() => setActiveAuthor(null)}
                  >
                    {piece.text}
                  </span>
                  {pieceIndex < paragraph.length - 1 ? " " : null}
                </span>
              );
            })}
          </p>
        ))}
      </div>
    </div>
  );
}

function ContextBlock({ context, label = "Context" }: { context: string; label?: string }) {
  return (
    <div className="context-block">
      <p className="eyebrow">{label}</p>
      <p>{context}</p>
    </div>
  );
}

function AdminDashboard({ onClose }: { onClose: () => void }) {
  const [token, setToken] = useState(() => localStorage.getItem(ADMIN_TOKEN_KEY));
  const state = useQuery(api.game.getAdminState, { adminToken: token });
  const login = useMutation(api.game.adminLogin);

  if (!token || state?.authorized === false) {
    return (
      <AdminFrame onClose={onClose}>
        <AdminLogin
          onLogin={async (password) => {
            const nextToken = await login({
              password,
              clientConfiguredPassword: import.meta.env.VITE_ADMIN_PASSWORD ?? null,
            });
            localStorage.setItem(ADMIN_TOKEN_KEY, nextToken);
            setToken(nextToken);
          }}
        />
      </AdminFrame>
    );
  }

  return (
    <AdminFrame onClose={onClose}>
      <DashboardContent token={token} state={state} />
    </AdminFrame>
  );
}

function AdminFrame({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <main className="admin-page">
      <section className="admin-shell">
        <div className="admin-titlebar">
          <button className="back-button" aria-label="Back to game" onClick={onClose}>
            <span aria-hidden="true">&larr;</span>
          </button>
          <Brand />
        </div>
        {children}
      </section>
    </main>
  );
}

function AdminLogin({ onLogin }: { onLogin: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  return (
    <form
      className="entry-panel compact"
      onSubmit={async (event) => {
        event.preventDefault();
        setError("");
        try {
          await onLogin(password);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Could not log in.");
        }
      }}
    >
      <label>
        Password
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoFocus
        />
      </label>
      {error ? <p className="error">{error}</p> : null}
      <button className="primary">Enter dashboard</button>
    </form>
  );
}

function DashboardContent({
  token,
  state,
}: {
  token: string;
  state: AdminState | undefined;
}) {
  const [setup, setSetup] = useState<"none" | "nextWord" | "followMe">("none");
  const nextTurn = useMutation(api.game.nextTurn);
  const endGame = useMutation(api.game.endGame);
  const resetSession = useMutation(api.game.resetSession);
  const session = state?.session;
  const active = session?.status === "active";

  return (
    <div className="dashboard-grid">
      <aside className="user-rail">
        <UserGroups state={state} token={token} />
        <KeepaliveSettings token={token} state={state} />
      </aside>
      <section className="admin-workspace">
        <div className="toolbar">
          {active ? (
            <>
              <button onClick={() => nextTurn({ adminToken: token })}>Next turn</button>
              <button onClick={() => endGame({ adminToken: token })}>End game</button>
            </>
          ) : (
            <>
              <button onClick={() => setSetup("nextWord")}>Next Word</button>
              <button onClick={() => setSetup("followMe")}>Follow me</button>
            </>
          )}
          <button className="danger" onClick={() => resetSession({ adminToken: token })}>
            Reset session
          </button>
        </div>

        {active && session ? <LiveAdminSummary session={session} state={state} /> : null}
        {!active && session?.status === "ended" ? (
          <OutputPanel
            output={session.endedOutput}
            segments={state?.outputSegments}
            topic={topicForSession(session)}
          />
        ) : null}
        {!active && setup === "nextWord" ? <NextWordSetup token={token} /> : null}
        {!active && setup === "followMe" ? <FollowMeSetup token={token} /> : null}
        {!active && setup === "none" && session?.status !== "ended" ? (
          <div className="empty-admin">
            <h1>Waiting for a game.</h1>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function presenceForUser(presences: AdminPresence[], userId: string) {
  return presences.find((presence) => presence.userId === userId) ?? null;
}

function formatLastSeen(lastSeen: number | null, now: number) {
  if (lastSeen === null) {
    return "last seen never";
  }
  const ageSeconds = Math.max(0, Math.floor((now - lastSeen) / 1000));
  if (ageSeconds < 5) {
    return "last seen just now";
  }
  if (ageSeconds < 60) {
    return `last seen ${ageSeconds} seconds ago`;
  }
  const ageMinutes = Math.floor(ageSeconds / 60);
  if (ageMinutes < 60) {
    return `last seen ${ageMinutes} ${ageMinutes === 1 ? "minute" : "minutes"} ago`;
  }
  const ageHours = Math.floor(ageMinutes / 60);
  return `last seen ${ageHours} ${ageHours === 1 ? "hour" : "hours"} ago`;
}

function PresenceDot({
  presence,
  now,
}: {
  presence: AdminPresence | null;
  now: number;
}) {
  const status = presence?.status ?? "offline";
  const label = formatLastSeen(presence?.lastSeen ?? null, now);
  return (
    <span
      className={`presence-dot presence-${status}`}
      aria-label={`${status}, ${label}`}
      title={label}
    />
  );
}

function UserGroups({ state, token }: { token: string; state: AdminState | undefined }) {
  const approveUser = useMutation(api.game.approveUser);
  const users = state?.users ?? [];
  const waiting = users.filter((user) => user.status !== "joined");
  const joined = users.filter((user) => user.status === "joined");
  const session = state?.session;
  const entries = state?.entries ?? [];
  const presences = state?.presences ?? [];
  const now = state?.now ?? Date.now();

  return (
    <div className="user-groups">
      <h2>Users</h2>
      <section>
        <h3>Waiting to be approved</h3>
        {waiting.length === 0 ? <p className="muted">None</p> : null}
        {waiting.map((user) => (
          <div className="user-row" key={user._id}>
            <span className="user-name">
              <PresenceDot presence={presenceForUser(presences, user._id)} now={now} />
              {user.name}
              {user.status === "transitioning" ? " ..." : ""}
            </span>
            <button onClick={() => approveUser({ adminToken: token, userId: user._id as Id<"users"> })}>
              Approve
            </button>
          </div>
        ))}
      </section>
      <section>
        <h3>Joined</h3>
        {joined.length === 0 ? <p className="muted">None</p> : null}
        {joined.map((user, index) => (
          <div className="user-row stacked" key={user._id}>
            <span className="user-name">
              <PresenceDot presence={presenceForUser(presences, user._id)} now={now} />
              {user.name}
            </span>
            <small>{adminUserStatus(user._id, index, joined.length, session, entries)}</small>
          </div>
        ))}
      </section>
    </div>
  );
}

function KeepaliveSettings({
  token,
  state,
}: {
  token: string;
  state: AdminState | undefined;
}) {
  const configureKeepalive = useMutation(api.game.configureKeepalive);
  const [timeoutSeconds, setTimeoutSeconds] = useState(120);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (state?.keepaliveTimeoutMs) {
      setTimeoutSeconds(Math.round(state.keepaliveTimeoutMs / 1000));
    }
  }, [state?.keepaliveTimeoutMs]);

  return (
    <form
      className="settings-panel"
      onSubmit={async (event) => {
        event.preventDefault();
        setError("");
        setSaved("");
        try {
          await configureKeepalive({
            adminToken: token,
            timeoutMs: timeoutSeconds * 1000,
          });
          setSaved("Saved");
        } catch (err) {
          setError(err instanceof Error ? err.message : "Could not save keepalive timeout.");
        }
      }}
    >
      <label>
        Keepalive timeout
        <input
          type="number"
          min={15}
          max={1800}
          step={5}
          value={timeoutSeconds}
          onChange={(event) => setTimeoutSeconds(Number(event.target.value))}
        />
      </label>
      <p className="settings-note">
        Clients ping every {Math.round((state?.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS) / 1000)} seconds.
      </p>
      {saved ? <p className="success">{saved}</p> : null}
      {error ? <p className="error">{error}</p> : null}
      <button className="primary">Save timeout</button>
    </form>
  );
}

function adminUserStatus(
  userId: string,
  index: number,
  joinedCount: number,
  session: AdminSession | undefined,
  entries: AdminEntry[],
) {
  if (!session || session.status !== "active") {
    return "Waiting to begin";
  }

  if (session.mode === "nextWord") {
    const entry = entries.find((item) => item.userId === userId && item.mode === "nextWord");
    const submitted = Math.min(entry?.words.length ?? 0, session.wordsPerRound);
    const remaining = session.wordsPerRound - submitted;
    return remaining === 0
      ? "Ready to proceed"
      : `${remaining} ${remaining === 1 ? "entry" : "entries"} needed`;
  }

  if (joinedCount === 0) {
    return "Waiting to begin";
  }

  const peopleInFront = (index - session.turnIndex + joinedCount) % joinedCount;
  if (peopleInFront === 0) {
    return "Their turn";
  }
  if (peopleInFront === 1) {
    return "Next";
  }
  return `${peopleInFront} in queue`;
}

function EyeIcon({ slash = false }: { slash?: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none">
      <path
        d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {slash ? (
        <path
          d="M4 4l16 16"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      ) : null}
    </svg>
  );
}

function CumulativeIcon({ slash = false }: { slash?: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none">
      <path
        d="M5 7h14M5 12h14M5 17h14"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      {slash ? (
        <path
          d="M4 4l16 16"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      ) : null}
    </svg>
  );
}

function OutputPreview({
  visible,
  output,
  segments,
  emptyText = "No words yet.",
}: {
  visible: boolean;
  output: string;
  segments: OutputSegment[];
  emptyText?: string;
}) {
  if (!visible) {
    return <h1>Progress hidden</h1>;
  }

  if (!output.trim()) {
    return <h1>{emptyText}</h1>;
  }

  return <OutputContent output={output} segments={segments} />;
}

function LiveAdminSummary({ session, state }: { session: AdminSession; state: AdminState | undefined }) {
  const [currentVisible, setCurrentVisible] = useState(false);
  const [cumulativeVisible, setCumulativeVisible] = useState(false);
  const joined = state?.users.filter((user) => user.status === "joined") ?? [];
  const entries = state?.entries ?? [];
  const outputSegments = state?.outputSegments ?? [];
  const activeJoined = joined.filter(
    (user) => (presenceForUser(state?.presences ?? [], user._id)?.status ?? "offline") !== "offline",
  );

  if (!session) {
    return null;
  }

  const ready =
    session.mode === "nextWord"
      ? activeJoined.filter((user) =>
          entries.some(
            (entry) =>
              entry.userId === user._id &&
              entry.mode === "nextWord" &&
              entry.words.length >= session.wordsPerRound,
          ),
        ).length
      : entries.length;

  return (
    <div className="live-summary">
      <div className="summary-header">
        <p className="eyebrow">{session.mode === "nextWord" ? "Next Word" : "Follow me"}</p>
        <div className="summary-actions">
          {session.mode === "nextWord" ? (
            <button
              className="icon-button"
              type="button"
              aria-label={currentVisible ? "Hide current" : "Show current"}
              aria-pressed={currentVisible}
              title={currentVisible ? "Hide current" : "Show current"}
              onClick={() => setCurrentVisible((visible) => !visible)}
            >
              <EyeIcon slash={!currentVisible} />
            </button>
          ) : null}
          <button
            className="icon-button"
            type="button"
            aria-label={cumulativeVisible ? "Hide current cumulative" : "Show current cumulative"}
            aria-pressed={cumulativeVisible}
            title={cumulativeVisible ? "Hide current cumulative" : "Show current cumulative"}
            onClick={() => setCumulativeVisible((visible) => !visible)}
          >
            {session.mode === "nextWord" ? (
              <CumulativeIcon slash={!cumulativeVisible} />
            ) : (
              <EyeIcon slash={!cumulativeVisible} />
            )}
          </button>
        </div>
      </div>
      {session.mode === "nextWord" ? (
        <>
          <div className="summary-preview">
            <p className="eyebrow">{nextWordPrompt(session).label}</p>
            <h1>{currentVisible ? nextWordPrompt(session).text : "Progress hidden"}</h1>
          </div>
          <div className="summary-preview">
            <p className="eyebrow">Current cumulative</p>
            <OutputPreview
              visible={cumulativeVisible}
              output={session.context}
              segments={outputSegments}
            />
          </div>
          <p>
            {ready}/{activeJoined.length} online ready
          </p>
        </>
      ) : (
        <>
          <div className="summary-preview">
            <p className="eyebrow">Current cumulative</p>
            <OutputPreview
              visible={cumulativeVisible}
              output={session.context}
              segments={outputSegments}
            />
          </div>
          <p>Round {session.roundNumber}</p>
        </>
      )}
    </div>
  );
}

function NextWordSetup({ token }: { token: string }) {
  const startNextWord = useMutation(api.game.startNextWord);
  const [wordsPerRound, setWordsPerRound] = useState(1);
  const [startingWord, setStartingWord] = useState("");
  const [seedKind, setSeedKind] = useState<SeedKind>("startingWord");
  const [error, setError] = useState("");

  return (
    <form
      className="setup-panel"
      onSubmit={async (event) => {
        event.preventDefault();
        setError("");
        try {
          await startNextWord({ adminToken: token, wordsPerRound, startingWord, seedKind });
        } catch (err) {
          setError(err instanceof Error ? err.message : "Could not start game.");
        }
      }}
    >
      <SeedKindToggle value={seedKind} onChange={setSeedKind} />
      <label>
        How many words per round
        <input
          type="number"
          min={1}
          max={10}
          value={wordsPerRound}
          onChange={(event) => setWordsPerRound(Number(event.target.value))}
        />
      </label>
      <label>
        {seedKind === "topic" ? "Topic" : "Starting word"}
        <input value={startingWord} onChange={(event) => setStartingWord(event.target.value)} />
      </label>
      {error ? <p className="error">{error}</p> : null}
      <button className="primary">Start</button>
    </form>
  );
}

function FollowMeSetup({ token }: { token: string }) {
  const startFollowMe = useMutation(api.game.startFollowMe);
  const [shown, setShown] = useState(31);
  const [entered, setEntered] = useState(5);
  const [initialContext, setInitialContext] = useState("");
  const [seedKind, setSeedKind] = useState<SeedKind>("startingWord");
  const [showToAll, setShowToAll] = useState(false);
  const [error, setError] = useState("");
  const shownValue = shown === 31 ? 0 : shown;

  return (
    <form
      className="setup-panel"
      onSubmit={async (event) => {
        event.preventDefault();
        setError("");
        try {
          await startFollowMe({
            adminToken: token,
            wordsShownPerRound: shownValue,
            wordsEnteredPerRound: entered,
            initialContext,
            seedKind,
            showToAll,
          });
        } catch (err) {
          setError(err instanceof Error ? err.message : "Could not start game.");
        }
      }}
    >
      <SeedKindToggle value={seedKind} onChange={setSeedKind} />
      <label>
        How many words shown per round
        <input
          type="range"
          min={1}
          max={31}
          value={shown}
          onChange={(event) => setShown(Number(event.target.value))}
        />
        <span className="range-readout">{shown === 31 ? "all" : shown}</span>
      </label>
      <label>
        {seedKind === "topic" ? "Topic" : "Starting word"}
        <textarea
          value={initialContext}
          onChange={(event) => setInitialContext(event.target.value)}
          rows={4}
          placeholder="Set the opening prompt or story so far."
        />
      </label>
      <label>
        How many words entered per round
        <input
          type="number"
          min={1}
          max={50}
          value={entered}
          onChange={(event) => setEntered(Number(event.target.value))}
        />
      </label>
      <label className="toggle-row">
        <input
          type="checkbox"
          checked={showToAll}
          onChange={(event) => setShowToAll(event.target.checked)}
        />
        Show to all
      </label>
      {error ? <p className="error">{error}</p> : null}
      <button className="primary">Start</button>
    </form>
  );
}

function SeedKindToggle({
  value,
  onChange,
}: {
  value: SeedKind;
  onChange: (value: SeedKind) => void;
}) {
  return (
    <div className="segmented-control" role="radiogroup" aria-label="Starting text type">
      <label className={value === "startingWord" ? "selected" : ""}>
        <input
          type="radio"
          name="seed-kind"
          value="startingWord"
          checked={value === "startingWord"}
          onChange={() => onChange("startingWord")}
        />
        Starting word
      </label>
      <label className={value === "topic" ? "selected" : ""}>
        <input
          type="radio"
          name="seed-kind"
          value="topic"
          checked={value === "topic"}
          onChange={() => onChange("topic")}
        />
        Topic
      </label>
    </div>
  );
}
