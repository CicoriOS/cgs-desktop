/** `path` relative to the workspace when it lies inside it. */
export const relativeTo = (cwd: string, path: string): string => (cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path);

/** The absolute path of one a tool reported, which is usually relative to the workspace. */
export const absoluteIn = (cwd: string, path: string): string => (path.startsWith("/") ? path : `${cwd}/${path}`);

export const dirName = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));
