import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, CloudUpload, GitBranch, Minus, Plus, RefreshCw, Undo2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { GitCommit, GitDiffTarget, GitFile } from "../../../core/types";
import { useT } from "../../../i18n";
import { useActions } from "../../client-context";
import { desktop } from "../../desktop";
import { baseName, cx, relativeTime } from "../../format";
import type { DiffLine } from "../../transcript/tools/diff";
import { DiffView } from "../../transcript/tools/DiffView";
import { langOf } from "../../transcript/tools/highlight";
import { ChangeLayout, Message, STATUS_LETTER } from "../Changes";
import { dirName, relativeTo } from "../paths";
import { parseUnified } from "../patch";
import type { GitState } from "../useGit";
import { Author, BranchMenu } from "./BranchMenu";
import { authorsOf, commitPlan, pathCount, splitFiles, syncPlan } from "./model";

type View = "changes" | "history";
interface Selection {
  path: string;
  target: GitDiffTarget;
}

const same = (a: Selection | undefined, b: Selection) => a?.path === b.path && JSON.stringify(a.target) === JSON.stringify(b.target);
const COMMIT_KEY = desktop?.platform === "darwin" ? "⌘↵" : "Ctrl+↵";
const LOG_LIMIT = 100;

/** A button that asks for a second click before it does something that cannot be undone. */
function DangerButton({ label, armedLabel, onConfirm, children }: { label: string; armedLabel: string; onConfirm: () => void; children: ReactNode }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 3000);
    return () => window.clearTimeout(timer);
  }, [armed]);
  const title = armed ? armedLabel : label;
  return (
    <button
      type="button"
      className={cx("git-act", armed && "armed")}
      title={title}
      aria-label={title}
      onBlur={() => setArmed(false)}
      onClick={(e) => {
        e.stopPropagation();
        if (armed) (setArmed(false), onConfirm());
        else setArmed(true);
      }}
    >
      {children}
    </button>
  );
}

function ActionButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="git-act" title={label} aria-label={label} onClick={(e) => (e.stopPropagation(), onClick())}>
      {children}
    </button>
  );
}

function FileRow({ file, cwd, active, onSelect, actions }: { file: GitFile; cwd: string; active: boolean; onSelect: () => void; actions?: ReactNode }) {
  const t = useT();
  const rel = relativeTo(cwd, file.path);
  const dir = dirName(rel);
  return (
    <div className={cx("chg-row", "git-file", active && "active")} role="button" tabIndex={0} title={rel} onClick={onSelect} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onSelect())}>
      <span className="stat-letter" data-kind={file.status} title={t(`right.status.${file.status}`)}>
        {STATUS_LETTER[file.status]}
      </span>
      <span className="chg-name">{baseName(rel)}</span>
      {dir && <span className="chg-dir">{dir}</span>}
      <span className="git-acts">{actions}</span>
    </div>
  );
}

function Section({ title, count, actions, children }: { title: string; count: number; actions?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="git-section">
      <div className="git-section-head" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown className="i" /> : <ChevronRight className="i" />}
        <span className="git-section-title">{title}</span>
        <span className="git-acts">{actions}</span>
        <span className="right-count">{count}</span>
      </div>
      {open && children}
    </section>
  );
}

/** The newest commits and the files of the one that is open; `reload` reloads them. */
function useLog(reload: GitState, enabled: boolean) {
  const actions = useActions();
  const [log, setLog] = useState<{ commits: GitCommit[]; error?: string }>();
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    actions.gitLog(LOG_LIMIT).then(
      (commits) => live && setLog({ commits }),
      (e) => live && setLog({ commits: [], error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [actions, enabled, reload]);
  return log;
}

function CommitRow({ commit, me, open, onClick }: { commit: GitCommit; me?: string; open: boolean; onClick: () => void }) {
  const t = useT();
  return (
    <button type="button" className={cx("commit-row", open && "open")} onClick={onClick} title={`${commit.hash.slice(0, 7)} · ${commit.email}`}>
      <Author name={commit.author} />
      <span className="commit-subject">{commit.subject}</span>
      <span className="commit-meta">
        {commit.author === me ? t("git.you") : commit.author} · {relativeTime(commit.time)}
      </span>
    </button>
  );
}

/**
 * Source control, after VS Code: the branch and how it stands against its upstream (with one button to sync), a commit box, then the staged,
 * changed and conflicted files, each stageable one by one. A History view lists the commits of the branch with the teammates' unpulled
 * ones on top, and opens any commit's files. The diff of the selected file is below.
 */
export function GitPane({ git, cwd, draft, setDraft, onChanged }: { git: GitState; cwd: string; draft: string; setDraft: (text: string) => void; onChanged: () => void }) {
  const t = useT();
  const actions = useActions();
  const [view, setView] = useState<View>("changes");
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Selection>();
  const [openCommit, setOpenCommit] = useState<{ hash: string; files?: GitFile[] }>();
  const log = useLog(git, view === "history");

  /** Runs one Git operation: the panel reloads after it, and a refusal from Git is shown as it came. */
  const run = useCallback(
    async (op: () => Promise<unknown>, done?: string) => {
      setBusy(true);
      try {
        await op();
        if (done) actions.notify(done);
      } catch (e) {
        actions.notify(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
        onChanged();
      }
    },
    [actions, onChanged],
  );

  const { merge, staged, changes } = splitFiles(git.files);
  const ordered = [...merge, ...staged, ...changes];
  const fallback = ordered.find((f) => f.status !== "deleted") ?? ordered[0];
  const wanted: Selection | undefined = view === "history" ? selected : selected && ordered.some((f) => f.path === selected.path && (selected.target === "staged") === f.staged) ? selected : fallback && { path: fallback.path, target: fallback.staged ? "staged" : "changes" };

  const [diff, setDiff] = useState<{ key: string; lines?: DiffLine[]; error?: string }>();
  const request = useRef(0);
  const key = wanted ? `${wanted.path}\0${JSON.stringify(wanted.target)}` : undefined;
  useEffect(() => {
    if (!wanted || !key) return;
    const mine = ++request.current;
    setDiff((d) => (d?.key === key ? d : undefined)); // the same file refreshing keeps its old diff until the new one arrives
    actions.gitDiff(wanted.path, wanted.target).then(
      (patch) => mine === request.current && setDiff({ key, lines: patch ? parseUnified(patch) : [] }),
      (e) => mine === request.current && setDiff({ key, error: e instanceof Error ? e.message : String(e) }),
    );
  }, [actions, key, git]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setOpenCommit(undefined), [cwd, git.branch]);
  const toggleCommit = (hash: string) => {
    if (openCommit?.hash === hash) return setOpenCommit(undefined);
    setOpenCommit({ hash });
    actions.gitCommitFiles(hash).then(
      (files) => setOpenCommit((c) => (c?.hash === hash ? { hash, files } : c)),
      (e) => (actions.notify(e instanceof Error ? e.message : String(e)), setOpenCommit(undefined)),
    );
  };

  if (git.error) return <Message>{t("right.failed", { error: git.error })}</Message>;
  if (git.loading && !git.files.length && !git.branch) return <Message>{t("right.loading")}</Message>;
  if (!git.isRepo) return <Message>{t("right.git.notRepo")}</Message>;

  const plan = syncPlan(git);
  const branchName = git.branch ?? t("git.detached", { hash: git.detached ?? "" });
  const syncLabel = t(`git.sync.${plan}`, { branch: branchName, ahead: git.ahead, behind: git.behind });
  const sync = () =>
    run(async () => {
      if (plan === "fetch") return actions.gitFetch();
      if (plan === "pull" || plan === "both") await actions.gitPull();
      if (plan === "push" || plan === "both" || plan === "publish") await actions.gitPush();
    });
  const commit = commitPlan(staged.length, changes.length, draft);
  const submit = () =>
    commit !== "none" &&
    run(async () => {
      if (commit === "all") await actions.gitStage("all");
      await actions.gitCommit(draft);
      setDraft("");
    }, t("git.committed"));
  const paths = (files: GitFile[]) => files.map((f) => f.path);
  const incoming = (log?.commits ?? []).filter((c) => c.direction === "incoming");

  const fileRows = (files: GitFile[], side: "staged" | "changes" | "merge") =>
    files.map((f) => {
      const sel: Selection = { path: f.path, target: f.staged ? "staged" : "changes" };
      return (
        <FileRow
          key={`${side}:${f.path}`}
          file={f}
          cwd={cwd}
          active={same(wanted, sel)}
          onSelect={() => setSelected(sel)}
          actions={
            side === "staged" ? (
              <ActionButton label={t("git.unstage")} onClick={() => void run(() => actions.gitUnstage([f.path]))}>
                <Minus className="i" />
              </ActionButton>
            ) : (
              <>
                <DangerButton label={t("git.discard")} armedLabel={t("git.discardConfirm")} onConfirm={() => void run(() => actions.gitDiscard([f.path]))}>
                  <Undo2 className="i" />
                </DangerButton>
                <ActionButton label={t("git.stage")} onClick={() => void run(() => actions.gitStage([f.path]))}>
                  <Plus className="i" />
                </ActionButton>
              </>
            )
          }
        />
      );
    });

  const header = (
    <div className="git-head">
      <div className="git-branch-wrap">
        <button type="button" className="git-branch" title={git.upstream ? `${t("git.branch")} · ${t("git.upstream", { upstream: git.upstream })}` : t("git.branch")} aria-haspopup="dialog" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>
          <GitBranch className="i" />
          <span className="git-branch-name">{branchName}</span>
          <ChevronDown className="i" />
        </button>
        {menu && (
          <BranchMenu
            current={git.branch}
            onClose={() => setMenu(false)}
            onPick={(branch, create) => {
              setMenu(false);
              void run(() => actions.gitCheckout(branch, create), t("git.checkedOut", { branch: branch.replace(/^origin\//, "") }));
            }}
          />
        )}
      </div>
      <button type="button" className={cx("git-sync", plan !== "fetch" && "due")} title={syncLabel} aria-label={syncLabel} disabled={busy} onClick={() => void sync()}>
        {plan === "publish" ? <CloudUpload className="i" /> : <RefreshCw className={cx("i", busy && "spin")} />}
        {git.behind > 0 && (
          <span className="git-count">
            <ArrowDown className="i" />
            {git.behind}
          </span>
        )}
        {git.ahead > 0 && (
          <span className="git-count">
            <ArrowUp className="i" />
            {git.ahead}
          </span>
        )}
      </button>
      <div className="git-seg" role="tablist">
        {(["changes", "history"] as const).map((v) => (
          <button key={v} type="button" role="tab" aria-selected={view === v} className={cx(view === v && "active")} onClick={() => (setView(v), setSelected(undefined))}>
            {t(`git.${v}`)}
            {v === "changes" && pathCount(git.files) > 0 && <span className="right-count">{pathCount(git.files)}</span>}
          </button>
        ))}
      </div>
    </div>
  );

  const incomingBanner = git.behind > 0 && view === "changes" && (
    <button type="button" className="git-banner" onClick={() => setView("history")}>
      <ArrowDown className="i" />
      {t("git.sync.pull", { behind: git.behind })}
      {incoming.length > 0 && <span> · {t("git.incomingBy", { who: authorsOf(incoming).join("、") })}</span>}
    </button>
  );

  const commitBox = view === "changes" && (
    <div className="git-commit">
      <textarea
        value={draft}
        rows={2}
        placeholder={t("git.message", { key: COMMIT_KEY, branch: branchName })}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && (e.preventDefault(), void submit())}
      />
      <button type="button" className="git-commit-btn" disabled={commit === "none" || busy} onClick={() => void submit()}>
        {commit === "all" ? t("git.commitAll") : t("git.commit")}
      </button>
    </div>
  );

  const shown = wanted && diff?.key === key ? diff : undefined;
  const diffBody = !wanted ? <Message>{t("right.git.pick")}</Message> : !shown ? <Message>{t("right.loading")}</Message> : shown.error ? <Message>{t("right.failed", { error: shown.error })}</Message> : shown.lines?.length ? <DiffView lines={shown.lines} lang={langOf(wanted.path)} /> : <Message>{t("right.git.noDiff")}</Message>;

  let list: ReactNode;
  if (view === "changes") {
    list = (
      <>
        {incomingBanner}
        {!ordered.length && <div className="right-note">{t("right.git.empty")}</div>}
        {merge.length > 0 && <Section title={t("git.merge")} count={merge.length}>{fileRows(merge, "merge")}</Section>}
        {staged.length > 0 && (
          <Section
            title={t("git.staged")}
            count={staged.length}
            actions={
              <ActionButton label={t("git.unstageAll")} onClick={() => void run(() => actions.gitUnstage("all"))}>
                <Minus className="i" />
              </ActionButton>
            }
          >
            {fileRows(staged, "staged")}
          </Section>
        )}
        {changes.length > 0 && (
          <Section
            title={t("git.unstaged")}
            count={changes.length}
            actions={
              <>
                <DangerButton label={t("git.discardAll")} armedLabel={t("git.discardConfirm")} onConfirm={() => void run(() => actions.gitDiscard(paths(changes)))}>
                  <Undo2 className="i" />
                </DangerButton>
                <ActionButton label={t("git.stageAll")} onClick={() => void run(() => actions.gitStage("all"))}>
                  <Plus className="i" />
                </ActionButton>
              </>
            }
          >
            {fileRows(changes, "changes")}
          </Section>
        )}
      </>
    );
  } else if (!log) list = <div className="right-note">{t("right.loading")}</div>;
  else if (log.error) list = <div className="right-note">{t("right.failed", { error: log.error })}</div>;
  else if (!log.commits.length) list = <div className="right-note">{t("git.noHistory")}</div>;
  else {
    const groups = (["incoming", "outgoing", "shared"] as const).map((direction) => ({ direction, commits: log.commits.filter((c) => c.direction === direction) })).filter((g) => g.commits.length);
    list = groups.map(({ direction, commits }) => (
      <Section key={direction} title={`${t(`git.${direction}`)}${direction === "incoming" ? ` · ${authorsOf(commits).join("、")}` : ""}`} count={commits.length}>
        {commits.map((c) => (
          <div key={c.hash}>
            <CommitRow commit={c} me={git.user?.name} open={openCommit?.hash === c.hash} onClick={() => toggleCommit(c.hash)} />
            {openCommit?.hash === c.hash && (
              <div className="commit-files">
                {!openCommit.files && <div className="right-note">{t("right.loading")}</div>}
                {openCommit.files?.map((f) => {
                  const sel: Selection = { path: f.path, target: { commit: c.hash } };
                  return <FileRow key={f.path} file={f} cwd={cwd} active={same(wanted, sel)} onSelect={() => setSelected(sel)} />;
                })}
              </div>
            )}
          </div>
        ))}
      </Section>
    ));
  }

  return (
    <div className="git">
      {header}
      {commitBox}
      <ChangeLayout rows={list}>{diffBody}</ChangeLayout>
    </div>
  );
}
