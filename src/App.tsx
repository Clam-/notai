import { FormEvent, useEffect, useState } from "react";
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

      {adminOpen ? <AdminDashboard onClose={() => setAdminOpen(false)} /> : null}
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
  const [choices, setChoices] = useState<string[]>([""]);
  const [followText, setFollowText] = useState("");
  const [error, setError] = useState("");

  const session = state?.session;
  const user = state?.user;
  const wordsPerRound = session?.wordsPerRound ?? 1;

  useEffect(() => {
    setChoices((current) =>
      Array.from({ length: wordsPerRound }, (_, index) => current[index] ?? ""),
    );
  }, [session?.roundNumber, wordsPerRound]);

  useEffect(() => {
    setFollowText("");
    setError("");
  }, [session?.roundNumber]);

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
    return <OutputPanel output={session.endedOutput} />;
  }

  if (session.mode === "nextWord") {
    if (state.ownEntry) {
      return <StatusPanel title="Waiting for next turn..." />;
    }

    return (
      <form
        className="game-panel"
        onSubmit={async (event) => {
          event.preventDefault();
          setError("");
          try {
            await submitNextWord({ clientId, words: choices });
          } catch (err) {
            setError(err instanceof Error ? err.message : "Could not submit.");
          }
        }}
      >
        <p className="eyebrow">Current</p>
        <h1>{session.currentWord}</h1>
        <div className="choice-grid">
          {choices.map((choice, index) => (
            <label key={`${session.roundNumber}-${index}`}>
              {choiceLabel(index, wordsPerRound)}
              <input
                value={choice}
                onChange={(event) => {
                  const next = [...choices];
                  next[index] = event.target.value;
                  setChoices(next);
                }}
              />
            </label>
          ))}
        </div>
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
    const context = visibleContext(session.context, session.wordsShownPerRound);

    if (!state.isCurrentTurn) {
      const peopleInFront = state.peopleInFront ?? 0;
      return (
        <div className="status-panel">
          {session.showToAll && context ? <ContextBlock context={context} /> : null}
          <h1>{peopleInFront === 1 ? "Get ready! You are next." : "Waiting for turn..."}</h1>
          {peopleInFront > 1 ? <p>{peopleInFront} people in front</p> : null}
        </div>
      );
    }

    return (
      <form
        className="game-panel"
        onSubmit={async (event) => {
          event.preventDefault();
          setError("");
          try {
            await submitFollowMe({ clientId, text: followText });
          } catch (err) {
            setError(err instanceof Error ? err.message : "Could not submit.");
          }
        }}
      >
        {shouldShowContext && context ? <ContextBlock context={context} /> : null}
        <label>
          Next words:
          <textarea
            className={`tone-${currentTone}`}
            value={followText}
            onChange={(event) => setFollowText(event.target.value)}
            rows={5}
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

function OutputPanel({ output }: { output: string }) {
  return (
    <div className="status-panel output">
      <p className="eyebrow">Final output</p>
      <h1>{output || "No words were entered."}</h1>
    </div>
  );
}

function ContextBlock({ context }: { context: string }) {
  return (
    <div className="context-block">
      <p className="eyebrow">Context</p>
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
    <div className="admin-backdrop">
      <section className="admin-panel">
        <div className="admin-titlebar">
          <Brand />
          <button className="icon-button" aria-label="Close admin dashboard" onClick={onClose}>
            x
          </button>
        </div>
        {children}
      </section>
    </div>
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
        {!active && session?.status === "ended" ? <OutputPanel output={session.endedOutput} /> : null}
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
    const ready = entries.some((entry) => entry.userId === userId);
    return ready ? "Ready to proceed" : "1 entry needed";
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
  const joined = state?.users.filter((user) => user.status === "joined") ?? [];
  const entries = state?.entries ?? [];
  const ready = entries.length;

  if (!session) {
    return null;
  }

  return (
    <div className="live-summary">
      <p className="eyebrow">{session.mode === "nextWord" ? "Next Word" : "Follow me"}</p>
      {session.mode === "nextWord" ? (
        <>
          <h1>{session.currentWord}</h1>
          <p>
            {ready}/{joined.length} ready
          </p>
        </>
      ) : (
        <>
          <h1>{session.context || "No words yet."}</h1>
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
  const [error, setError] = useState("");

  return (
    <form
      className="setup-panel"
      onSubmit={async (event) => {
        event.preventDefault();
        setError("");
        try {
          await startNextWord({ adminToken: token, wordsPerRound, startingWord });
        } catch (err) {
          setError(err instanceof Error ? err.message : "Could not start game.");
        }
      }}
    >
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
        Starting word
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
            showToAll,
          });
        } catch (err) {
          setError(err instanceof Error ? err.message : "Could not start game.");
        }
      }}
    >
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
