import { describe, expect, it } from "vitest";
import { demoWorkspace } from "../src/demo/workspace";
import { commitPlan, splitFiles, syncPlan } from "../src/ui/right/git/model";

const cwd = "/home/demo/payments-api";
const path = (rel: string) => `${cwd}/${rel}`;

describe("sync and commit plans", () => {
  it("picks the one button action from where the branch stands", () => {
    expect(syncPlan({ ahead: 0, behind: 0 })).toBe("publish"); // no upstream
    expect(syncPlan({ upstream: "origin/x", ahead: 0, behind: 0 })).toBe("fetch");
    expect(syncPlan({ upstream: "origin/x", ahead: 2, behind: 0 })).toBe("push");
    expect(syncPlan({ upstream: "origin/x", ahead: 0, behind: 3 })).toBe("pull");
    expect(syncPlan({ upstream: "origin/x", ahead: 1, behind: 1 })).toBe("both");
  });

  it("needs a message, and stages everything when nothing is staged", () => {
    expect(commitPlan(2, 1, "  ")).toBe("none");
    expect(commitPlan(2, 1, "msg")).toBe("staged");
    expect(commitPlan(0, 1, "msg")).toBe("all");
    expect(commitPlan(0, 0, "msg")).toBe("none");
  });

  it("lists a file edited after staging on both sides", () => {
    const files = [
      { path: "a", status: "modified" as const, staged: true },
      { path: "a", status: "modified" as const, staged: false },
      { path: "c", status: "conflict" as const, staged: false },
    ];
    const { merge, staged, changes } = splitFiles(files);
    expect([merge.length, staged.length, changes.length]).toEqual([1, 1, 1]);
  });
});

describe("demo repository", () => {
  it("stages, commits what is staged, and leaves the rest changed", async () => {
    const retry = path("gateway/retry.go");
    expect((await demoWorkspace.gitStatus(cwd)).files).toEqual([{ path: retry, status: "modified", staged: false }]);
    await demoWorkspace.gitStage(cwd, [retry]);
    expect((await demoWorkspace.gitStatus(cwd)).files).toEqual([{ path: retry, status: "modified", staged: true }]);
    expect(await demoWorkspace.gitDiff(cwd, retry, "staged")).toContain("+\td := base << attempt");
    expect(await demoWorkspace.gitDiff(cwd, retry, "changes")).toBeUndefined(); // nothing left unstaged
    await expect(demoWorkspace.gitCommit(cwd, "  ")).rejects.toThrow(/empty commit message/);
    await demoWorkspace.gitCommit(cwd, "fix(gateway): jitter\n\nbody");
    const status = await demoWorkspace.gitStatus(cwd);
    expect(status.files).toEqual([]);
    expect(status.ahead).toBe(1);
    expect((await demoWorkspace.gitLog(cwd, 1))[0]).toMatchObject({ subject: "fix(gateway): jitter", author: "林枫", direction: "outgoing" });
    expect(await demoWorkspace.gitCommit(cwd, "again").catch((e: Error) => e.message)).toMatch(/nothing to commit/);
  });

  it("brings a teammate's commit in on fetch, refuses a push until it is pulled, then pushes", async () => {
    // The web workspace has teammates' work waiting on the remote.
    const web = "/home/demo/cgs-web";
    const before = await demoWorkspace.gitStatus(web);
    expect(before.behind).toBeGreaterThan(0);
    await expect(demoWorkspace.gitPush(web)).rejects.toThrow(/Pull first/);
    await demoWorkspace.gitPull(web);
    const pulled = await demoWorkspace.gitStatus(web);
    expect(pulled.behind).toBe(0);
    await demoWorkspace.gitPush(web);
    expect((await demoWorkspace.gitStatus(web)).ahead).toBe(0);
  });

  it("makes a local branch that follows a remote one, and publishes a new branch on its first push", async () => {
    const remote = (await demoWorkspace.gitBranches(cwd)).find((b) => b.remote);
    expect(remote?.name).toBe("origin/fix/callback-timeout");
    await demoWorkspace.gitCheckout(cwd, remote!.name);
    const status = await demoWorkspace.gitStatus(cwd);
    expect(status).toMatchObject({ branch: "fix/callback-timeout", upstream: "origin/fix/callback-timeout" });
    expect((await demoWorkspace.gitBranches(cwd)).some((b) => b.name === remote!.name)).toBe(false); // now followed locally

    await demoWorkspace.gitCheckout(cwd, "feature/new", true);
    expect(syncPlan(await demoWorkspace.gitStatus(cwd))).toBe("publish");
    await demoWorkspace.gitPush(cwd);
    expect((await demoWorkspace.gitStatus(cwd)).upstream).toBe("origin/feature/new");
    await expect(demoWorkspace.gitCheckout(cwd, "feature/new", true)).rejects.toThrow(/already exists/);
  });
});
