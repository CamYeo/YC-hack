import { dirname, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const executable = resolve(root, "node_modules/.bin/bun")
process.stdout.write("Terse recovery rehearsal: temporary state, automatically selected local ports, no provider calls.\nThe running Apprentice backend and user rooms are not stopped or modified.\n")
const child = Bun.spawn([executable, "--no-env-file", "test", "./tests/terseExpiry.test.ts", "./tests/terseAlarms.test.ts", "./tests/terseRestart.test.ts"], {
    cwd: root,
    env: { PATH: `${dirname(executable)}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: process.env.HOME ?? "", USER: process.env.USER ?? "", TMPDIR: process.env.TMPDIR ?? "/tmp", LANG: "en_US.UTF-8", NO_COLOR: "1", RUN_TERSE_INTEGRATION: "1" },
    stdin: "ignore", stdout: "inherit", stderr: "inherit",
})
let cancelled = false
const stop = () => { cancelled = true; child.kill("SIGTERM") }
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
const timeout = setTimeout(stop, 150_000)
try {
    const code = await child.exited
    process.exitCode = cancelled ? 1 : code
    if (!cancelled && code === 0) process.stdout.write("Verified: exclusive lease expiry, pushed public snapshots, rejected late audio acknowledgements, preserved heard prefixes, durable dedupe/outbox, and explicit paused restart recovery.\nCold-restart alarm auto-wakeup is not claimed; backend recovery and watchdog remain required.\n")
} finally {
    clearTimeout(timeout)
    process.off("SIGINT", stop)
    process.off("SIGTERM", stop)
}
