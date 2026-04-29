import { CORE_VERSION } from "@tessera/core";

const [cmd, ...args] = process.argv.slice(2);

if (cmd === "ping") {
  process.stdout.write(
    `${JSON.stringify({
      tool: "workspace-cli",
      message: "pong",
      args,
      pid: process.pid,
      timestamp: new Date().toISOString(),
    })}\n`
  );
  process.exit(0);
}

if (cmd === "--version" || cmd === "-v") {
  console.log(`0.1.0 (core ${CORE_VERSION})`);
  process.exit(0);
}

if (cmd === "--help" || cmd === "-h" || !cmd) {
  console.log("tessera <command> [options]");
  console.log("");
  console.log("Commands:");
  console.log("  ping          Health-check; prints JSON and exits 0");
  console.log("  run <agent>   Run an agent headlessly");
  console.log("");
  console.log("Options:");
  console.log("  -v, --version  Print version");
  console.log("  -h, --help     Print help");
  process.exit(0);
}

console.error(`Unknown command: ${cmd}`);
process.exit(1);
