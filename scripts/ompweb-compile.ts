// Run by scripts/build-ompweb.mjs with the ompweb checkout's own Bun (cwd = checkout, after its client build):
//   bun scripts/ompweb-compile.ts <checkout> <outDir> <bun-target>
// Compiles server/binary.ts into <outDir>/ompweb(.exe) and lays out the static root next to it (dist/, public/,
// node_modules/katex, font licenses, licenses/), the same layout the ompweb release archives have minus the `ompweb-omp`
// runner: the desktop points OMP_WEB_OMP_BIN at its own omp. Nothing is written inside the checkout.
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
const [checkout, outDir, target] = Bun.argv.slice(2) as [string, string, Bun.Build.CompileTarget];
if (!checkout || !outDir || !target) throw new Error("usage: ompweb-compile.ts <checkout> <outDir> <bun-target>");
// The checkout's location is only known at run time, hence the dynamic import.
const { bundledPackageDirs, writeLicenses } = (await import(path.join(checkout, "scripts", "licenses.ts"))) as {
  bundledPackageDirs(metafile: Bun.BuildMetafile, cwd: string): string[];
  writeLicenses(out: string, packageDirs: string[], bunLicense: string): void;
};
const windows = target.startsWith("bun-windows-");

const clientPackagesFile = path.join(checkout, "build", "client-packages.json");
if (!existsSync(clientPackagesFile)) throw new Error("No build/client-packages.json: the client build did not run");
const bunLicense = path.join(checkout, "scripts", `bun-LICENSE-${Bun.version}.md`);
if (!existsSync(bunLicense)) throw new Error(`No scripts/bun-LICENSE-${Bun.version}.md in the ompweb checkout`);

rmSync(outDir, { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: [path.join(checkout, "server", "binary.ts")],
  compile: { target, outfile: path.join(outDir, windows ? "ompweb.exe" : "ompweb"), autoloadDotenv: false, autoloadBunfig: false },
  minify: true,
  metafile: true,
  // As `bun build --compile --production`: without it the server never writes the local daemon link.
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  throw: false,
});
for (const log of result.logs) console.log(log);
if (!result.success) process.exit(1);

const copy = (from: string, to: string) => cpSync(from, path.join(outDir, to), { recursive: true });
for (const file of ["dist", "public", "LICENSE"]) copy(path.join(checkout, file), file);
for (const file of new Bun.Glob("app/fonts/*-{OFL.txt,LICENSE.*}").scanSync(checkout)) copy(path.join(checkout, file), file);
const katex = path.dirname(Bun.resolveSync("katex/package.json", checkout));
for (const file of ["package.json", "LICENSE", "dist/katex.min.css", "dist/fonts"]) copy(path.join(katex, file), `node_modules/katex/${file}`);
// The desktop is CGS-branded: the page title (which ompweb also uses as its app name) and the PWA title in the copied
// index.html; the checkout itself stays untouched.
const indexHtml = path.join(outDir, "dist", "index.html");
const branded = readFileSync(indexHtml, "utf8")
  .replace("<title>omp web</title>", "<title>CGS Desktop</title>")
  .replace('name="apple-mobile-web-app-title" content="omp web"', 'name="apple-mobile-web-app-title" content="CGS Desktop"')
  .replace('aria-label="Loading omp web"', 'aria-label="Loading CGS Desktop"');
if (!branded.includes("<title>CGS Desktop</title>")) throw new Error("ompweb's index.html no longer has <title>omp web</title>; update the branding patch");
writeFileSync(indexHtml, branded);
const clientPackages = (JSON.parse(readFileSync(clientPackagesFile, "utf8")) as string[]).map((dir) => path.resolve(checkout, dir));
writeLicenses(outDir, [...new Set([...bundledPackageDirs(result.metafile!, process.cwd()), ...clientPackages])].sort(), bunLicense);
console.log(`built ${outDir}`);
