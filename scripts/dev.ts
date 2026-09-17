import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(name: string, cwd: string, command: string, args: string[]): void {
  const child = spawn(command, args, { cwd: join(root, cwd), stdio: "inherit", shell: process.platform === "win32" });
  child.on("exit", (code) => {
    process.stdout.write(`[${name}] exited with code ${code}\n`);
  });
}

run("backend", "backend", "npm", ["run", "dev"]);
run("frontend", "frontend", "npm", ["run", "dev"]);

process.on("SIGINT", () => process.exit(0));
