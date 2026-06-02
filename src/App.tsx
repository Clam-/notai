import { FormEvent, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

const CLIENT_ID_KEY = "notai.clientId";
const NAME_KEY = "notai.name";
const ADMIN_TOKEN_KEY = "notai.adminToken";

type ParticipantState = NonNullable<ReturnType<typeof useQuery<typeof api.game.getParticipantState>>>;
type AdminState = NonNullable<ReturnType<typeof useQuery<typeof api.game.getAdminState>>>;
type AdminSession = AdminState["session"];
type AdminEntry = AdminState["entries"][number];
type OutputSegment = ParticipantState["outputSegments"][number] | AdminState["outputSegments"][number];
type SeedKind = "startingWord" | "topic";

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

export default function App() {
  const [clientId] = useState(getClientId);
  const [savedName, setSavedName] = useState(() => localStorage.getItem(NAME_KEY) ?? "");
  const [adminOpen, setAdminOpen] = useState(false);
  const join = useMutation(api.game.join);
  const state = useQuery(api.game.getParticipantState, { clientId });

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
          if (!cleaned) {
            setError("Enter a word.");
            return;
          }
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
      {output ? (
        <h1 className="attributed-output">
          {visibleSegments.length > 0 ? (
            visibleSegments.map((segment, index) => (
              <span className="output-segment-wrap" key={`${segment.roundNumber}-${index}`}>
                <span
                  className="output-segment"
                  tabIndex={0}
                  aria-label={segment.summary}
                >
                  {segment.text}
                </span>
                <span className="segment-popup" role="tooltip">
                  {segment.summary}
                </span>
                {index < visibleSegments.length - 1 ? " " : null}
              </span>
            ))
          ) : (
            output
          )}
        </h1>
      ) : (
        <h1>No words were entered.</h1>
      )}
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

function UserGroups({ state, token }: { token: string; state: AdminState | undefined }) {
  const approveUser = useMutation(api.game.approveUser);
  const users = state?.users ?? [];
  const waiting = users.filter((user) => user.status !== "joined");
  const joined = users.filter((user) => user.status === "joined");
  const session = state?.session;
  const entries = state?.entries ?? [];

  return (
    <div className="user-groups">
      <h2>Users</h2>
      <section>
        <h3>Waiting to be approved</h3>
        {waiting.length === 0 ? <p className="muted">None</p> : null}
        {waiting.map((user) => (
          <div className="user-row" key={user._id}>
            <span>
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
            <span>{user.name}</span>
            <small>{adminUserStatus(user._id, index, joined.length, session, entries)}</small>
          </div>
        ))}
      </section>
    </div>
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

function LiveAdminSummary({ session, state }: { session: AdminSession; state: AdminState | undefined }) {
  const [progressVisible, setProgressVisible] = useState(false);
  const joined = state?.users.filter((user) => user.status === "joined") ?? [];
  const entries = state?.entries ?? [];

  if (!session) {
    return null;
  }

  const ready =
    session.mode === "nextWord"
      ? entries.filter((entry) => entry.mode === "nextWord" && entry.words.length >= session.wordsPerRound).length
      : entries.length;

  return (
    <div className="live-summary">
      <div className="summary-header">
        <p className="eyebrow">{session.mode === "nextWord" ? "Next Word" : "Follow me"}</p>
        <button
          className="icon-button"
          type="button"
          aria-label={progressVisible ? "Hide current progress" : "Show current progress"}
          aria-pressed={progressVisible}
          title={progressVisible ? "Hide current progress" : "Show current progress"}
          onClick={() => setProgressVisible((visible) => !visible)}
        >
          <span aria-hidden="true">&#128065;</span>
        </button>
      </div>
      {session.mode === "nextWord" ? (
        <>
          <h1>{progressVisible ? nextWordPrompt(session).text : "Progress hidden"}</h1>
          <p>
            {ready}/{joined.length} ready
          </p>
        </>
      ) : (
        <>
          <h1>{progressVisible ? session.context || "No words yet." : "Progress hidden"}</h1>
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
