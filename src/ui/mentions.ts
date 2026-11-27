import { relativeTo } from "./right/paths";

/** The `@path ` mentions omp expands into file contents, for absolute paths; paths inside `cwd` go relative, and ones with spaces are quoted. */
export const mentionText = (cwd: string, paths: string[]): string =>
  paths
    .map((path) => {
      const shown = relativeTo(cwd, path);
      return shown.includes(" ") ? `@"${shown}" ` : `@${shown} `;
    })
    .join("");
