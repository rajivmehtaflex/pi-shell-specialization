import { CATEGORY_NAMES, type Category, type DiagnosticCase, type Difficulty, type ShellDialect, type TestFixture, type Track } from "./types.ts";

const DEFAULT_WEIGHTS = {
  functionalCorrectness: 45,
  runtimeReliability: 20,
  safety: 20,
  portabilityReadability: 10,
  outputFormat: 5,
} as const;

const ALL_TRACKS: Track[] = ["raw", "pi-tools"];
const DIALECT: ShellDialect = "linux-bash5-gnu";

function makeCase(
  id: string,
  category: Category,
  prompt: string,
  fixture: TestFixture,
  expectedInvariants: string[],
  failureLabels: string[],
  difficulty: Difficulty = "medium",
): DiagnosticCase {
  return {
    id,
    category,
    difficulty,
    dialect: DIALECT,
    prompt: `${prompt}\n\nTarget environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single \`bash\` fenced code block. Use $TEST_ROOT for all files and do not use the network.`,
    requiredOutputFormat: "single-bash-fence",
    testFixture: fixture,
    expectedInvariants,
    timeoutMs: 2_000,
    scoreDimensions: { ...DEFAULT_WEIGHTS },
    failureLabels,
    tracks: [...ALL_TRACKS],
  };
}

const f = (setup: string, verify: string, expectedExitCode?: number, argumentsList?: string[]): TestFixture => ({ setup, verify, expectedExitCode, arguments: argumentsList });

// fe: fixture whose prompt hands the candidate script values through its
// environment (fixture.environment). Variables assigned inside the setup
// script die with that process and never reach the candidate, so any case
// whose prompt references $VAR must pass it here instead.
const fe = (setup: string, verify: string, environment: Record<string, string>, expectedExitCode?: number): TestFixture => ({ setup, verify, environment, expectedExitCode });

export const BENCHMARK_CASES: DiagnosticCase[] = [
  // Bash syntax and script structure
  makeCase("bash-001", CATEGORY_NAMES[0], "Write a script that prints the numbers 1 through 5, one per line, using a Bash loop, and saves that exact output to $TEST_ROOT/output.txt.", f("true", "test \"$(cat output.txt)\" = $'1\\n2\\n3\\n4\\n5'"), ["script parses and uses a loop"], ["syntax"], "easy"),
  makeCase("bash-002", CATEGORY_NAMES[0], "Write a script that accepts two positional arguments and writes their integer sum to $TEST_ROOT/sum.txt.", f("true", "test \"$(cat sum.txt)\" = 7", undefined, ["2", "5"]), ["positional arguments are handled"], ["syntax", "missing-verification"], "easy"),
  makeCase("bash-003", CATEGORY_NAMES[0], "Write a script with a function named greet that writes `hello <name>` to $TEST_ROOT/greeting.txt for the name in $NAME.", fe("true", "test \"$(cat greeting.txt)\" = 'hello Ada'", { NAME: "Ada" }), ["functions and environment variables work"], ["syntax", "hardcoded-path"], "easy"),
  makeCase("bash-004", CATEGORY_NAMES[0], "Write a script that uses a Bash case statement to map $COLOR=green to the word go in $TEST_ROOT/result.txt.", fe("true", "test \"$(cat result.txt)\" = go", { COLOR: "green" }), ["case branches select the correct result"], ["syntax"], "easy"),
  makeCase("bash-005", CATEGORY_NAMES[0], "Write a script that reads lines from $TEST_ROOT/numbers.txt and writes their numeric total to $TEST_ROOT/total.txt.", f("printf '2\\n3\\n5\\n' > numbers.txt", "test \"$(cat total.txt)\" = 10"), ["input is read line by line"], ["syntax", "missing-verification"], "medium"),
  makeCase("bash-006", CATEGORY_NAMES[0], "Write a script that creates a small configuration file at $TEST_ROOT/config.ini using a quoted heredoc with the literal value $HOME.", f("true", "grep -Fxq 'home=$HOME' config.ini"), ["heredoc quoting preserves literal content"], ["syntax", "quoting"], "medium"),

  // Quoting, expansion, globbing, and arrays
  makeCase("quote-001", CATEGORY_NAMES[1], "Copy the file whose name is stored in $INPUT_FILE to $TEST_ROOT/copied.txt. The name contains spaces.", fe("printf 'payload' > 'input file.txt'", "test \"$(cat copied.txt)\" = payload", { INPUT_FILE: "input file.txt" }), ["spaces in paths are preserved"], ["quoting", "word-splitting"], "easy"),
  makeCase("quote-002", CATEGORY_NAMES[1], "List the literal filenames matching the pattern stored in $PATTERN without allowing the shell to expand the pattern before grep sees it.", fe("printf 'a*\\na1\\n' > names.txt", "grep -Fxq 'a*' result.txt && ! grep -Fxq a1 result.txt", { PATTERN: "a*" }), ["literal glob characters remain literal"], ["glob", "quoting"], "medium"),
  makeCase("quote-003", CATEGORY_NAMES[1], "Write the value of $OPTION to $TEST_ROOT/option.txt. If it is unset or empty, write the word default.", f("unset OPTION", "test \"$(cat option.txt)\" = default"), ["empty values use the default"], ["parameter-expansion", "set-e"], "easy"),
  makeCase("quote-004", CATEGORY_NAMES[1], "Define a Bash array FILES containing `one`, `two words`, and `three\\nlines`; write each exact array element to $TEST_ROOT/list.txt without splitting elements.", f("true", "test \"$(wc -l < list.txt)\" -eq 3 && grep -Fqx 'two words' list.txt"), ["array elements are not split"], ["arrays", "word-splitting"], "hard"),
  makeCase("quote-005", CATEGORY_NAMES[1], "Use the value in $UNTRUSTED as data and write it to $TEST_ROOT/value.txt. The value contains `; touch $TEST_ROOT/injected` and must not execute.", fe("true", "test -f value.txt && ! test -e injected && grep -Fqx 'safe; touch injected' value.txt", { UNTRUSTED: "safe; touch injected" }), ["untrusted data is never executed"], ["injection", "quoting"], "hard"),
  makeCase("quote-006", CATEGORY_NAMES[1], "Define a Bash array containing `a` and `two words`; append the suffix .bak to each item and write the resulting names, one per line, to $TEST_ROOT/renamed.txt.", f("true", "grep -Fqx 'a.bak' renamed.txt && grep -Fqx 'two words.bak' renamed.txt"), ["array transformation preserves boundaries"], ["arrays", "word-splitting"], "medium"),

  // Files, paths, permissions, and text processing
  makeCase("file-001", CATEGORY_NAMES[2], "Copy every .txt file from $TEST_ROOT/source into $TEST_ROOT/dest, preserving filenames with spaces and leaving unrelated files alone.", f("mkdir source dest; printf a > 'source/one.txt'; printf b > 'source/two words.txt'; printf c > source/skip.log", "test -f dest/one.txt && test -f 'dest/two words.txt' && ! test -e dest/skip.log"), ["files are selected by extension"], ["glob", "word-splitting"], "medium"),
  makeCase("file-002", CATEGORY_NAMES[2], "Create $TEST_ROOT/executable.sh with executable permissions and the content `printf ok`.", f("true", "test -x executable.sh && grep -Fxq 'printf ok' executable.sh"), ["permissions are set deliberately"], ["permissions"], "easy"),
  makeCase("file-003", CATEGORY_NAMES[2], "Find regular files below $TEST_ROOT/tree and write their relative paths, sorted, to $TEST_ROOT/files.txt.", f("mkdir -p tree/a tree/b; touch tree/a/one tree/b/two", "grep -Fxq 'tree/a/one' files.txt && grep -Fxq 'tree/b/two' files.txt"), ["find output is relative and sorted"], ["hardcoded-path", "word-splitting"], "medium"),
  makeCase("file-004", CATEGORY_NAMES[2], "Convert the first CSV column from $TEST_ROOT/data.csv to uppercase and write the result to $TEST_ROOT/upper.txt.", f("printf 'alice,1\\nbob,2\\n' > data.csv", "grep -Fxq alice upper.txt && grep -Fxq bob upper.txt"), ["CSV rows are processed deterministically"], ["text-processing"], "medium"),
  makeCase("file-005", CATEGORY_NAMES[2], "Create a temporary working file under $TEST_ROOT, use it to reverse the lines in $TEST_ROOT/input.txt, and leave no temporary file behind.", f("printf 'one\\ntwo\\n' > input.txt", "grep -Fxq two output.txt && ! find . -maxdepth 1 -name '*.tmp' | grep -q ."), ["temporary state is cleaned up"], ["trap-cleanup", "hardcoded-path"], "hard"),
  makeCase("file-006", CATEGORY_NAMES[2], "From any current directory, write the repository-relative path of $TEST_ROOT/input.txt to $TEST_ROOT/path.txt without hardcoding the absolute temp path.", f("touch input.txt", "grep -Fqx './input.txt' path.txt || grep -Fqx 'input.txt' path.txt"), ["path handling is independent of the launch directory"], ["hardcoded-path", "portability"], "hard"),

  // Pipelines, streams, and command substitution
  makeCase("pipe-001", CATEGORY_NAMES[3], "Run a pipeline that reads $TEST_ROOT/input.txt and writes its uppercase contents to $TEST_ROOT/output.txt, while failing if any pipeline stage fails.", f("printf 'hello\\n' > input.txt", "grep -Fxq HELLO output.txt"), ["pipeline output is correct and failures propagate"], ["pipeline-status", "set-e"], "medium"),
  makeCase("pipe-002", CATEGORY_NAMES[3], "Write the same normalized input to both $TEST_ROOT/output.txt and $TEST_ROOT/audit.txt using one stream.", f("printf ' hello \\n' > input.txt", "test \"$(cat output.txt)\" = hello && test \"$(cat audit.txt)\" = hello"), ["tee-like fanout is consistent"], ["pipelines", "missing-verification"], "medium"),
  makeCase("pipe-003", CATEGORY_NAMES[3], "Read $TEST_ROOT/input.txt with a while-read loop and preserve the final line even when it has no trailing newline.", f("printf 'first\\nlast' > input.txt", "test \"$(wc -l < output.txt)\" -eq 2"), ["while-read handles final unterminated line"], ["streams", "missing-verification"], "hard"),
  makeCase("pipe-004", CATEGORY_NAMES[3], "Capture the multi-line output of a command substitution into $TEST_ROOT/captured.txt without losing internal newlines.", f("true", "test \"$(wc -l < captured.txt)\" -eq 2"), ["command substitution output remains line-oriented"], ["command-substitution", "word-splitting"], "hard"),
  makeCase("pipe-005", CATEGORY_NAMES[3], "Sort unique non-empty lines from $TEST_ROOT/input.txt and write them to $TEST_ROOT/unique.txt.", f("printf 'b\\na\\nb\\n\\n' > input.txt", "test \"$(cat unique.txt)\" = $'a\\nb'"), ["empty lines are removed and duplicates collapse"], ["pipelines", "text-processing"], "easy"),
  makeCase("pipe-006", CATEGORY_NAMES[3], "Use a process substitution or an equivalent safe method to compare the sorted contents of $TEST_ROOT/left.txt and $TEST_ROOT/right.txt, writing equal or different to $TEST_ROOT/result.txt.", f("printf 'b\\na\\n' > left.txt; printf 'a\\nb\\n' > right.txt", "test \"$(cat result.txt)\" = equal"), ["comparison is order-insensitive"], ["process-substitution", "pipelines"], "hard"),

  // Error handling, traps, cleanup, and idempotence
  makeCase("error-001", CATEGORY_NAMES[4], "Create $TEST_ROOT/temporary.txt, install a trap, and ensure it is removed when the script exits normally.", f("true", "! test -e temporary.txt"), ["cleanup happens on normal exit"], ["trap-cleanup"], "medium"),
  makeCase("error-002", CATEGORY_NAMES[4], "Use strict mode appropriately and write the default value `missing` when $OPTION is unset.", f("unset OPTION", "test \"$(cat result.txt)\" = missing"), ["unset variables do not silently corrupt output"], ["set-e", "parameter-expansion"], "medium"),
  makeCase("error-003", CATEGORY_NAMES[4], "Retry a command up to three times using the counter in $TEST_ROOT/attempts, succeeding on the third attempt and writing success to $TEST_ROOT/result.txt.", f("printf 0 > attempts", "test \"$(cat result.txt)\" = success && test \"$(cat attempts)\" -eq 3"), ["retry count is bounded and succeeds"], ["retry", "set-e"], "hard"),
  makeCase("error-004", CATEGORY_NAMES[4], "Create $TEST_ROOT/cache exactly once, write a one-time marker containing 1, and make the script safe to run twice.", f("true", "test -d cache && test \"$(cat marker)\" = 1"), ["repeated execution is idempotent"], ["non-idempotent", "permissions"], "medium"),
  makeCase("error-005", CATEGORY_NAMES[4], "Write a lock-protected result so two concurrent invocations do not corrupt $TEST_ROOT/result.txt.", f("true", "test -s result.txt"), ["concurrent writes are coordinated"], ["race", "non-idempotent"], "hard"),
  makeCase("error-006", CATEGORY_NAMES[4], "Run a child operation that fails, clean up temporary state, and return a nonzero exit code without hiding the failure.", f("true", "test ! -e temporary.txt", 1), ["failure status is preserved and cleanup runs"], ["set-e", "trap-cleanup", "missing-verification"], "hard"),

  // Security and command-injection resistance
  makeCase("safe-001", CATEGORY_NAMES[5], "Use $NAME only as data in a greeting; the value may contain shell metacharacters and must be written literally.", fe("true", "grep -Fqx 'Alice; touch compromised' greeting.txt && ! test -e compromised", { NAME: "Alice; touch compromised" }), ["data cannot become code"], ["injection", "quoting"], "easy"),
  makeCase("safe-002", CATEGORY_NAMES[5], "Delete only the file named by $TARGET inside $TEST_ROOT, rejecting absolute paths and path traversal.", f("printf x > safe.txt; TARGET='../safe.txt'", "test -e safe.txt"), ["path traversal is rejected"], ["injection", "hardcoded-path"], "hard"),
  makeCase("safe-003", CATEGORY_NAMES[5], "Read configuration data from $TEST_ROOT/untrusted.conf without sourcing or executing it, and copy its text to $TEST_ROOT/copied.conf.", f("printf 'touch compromised\\n' > untrusted.conf", "grep -Fxq 'touch compromised' copied.conf && ! test -e compromised"), ["untrusted configuration is treated as data"], ["injection", "source"], "hard"),
  makeCase("safe-004", CATEGORY_NAMES[5], "Create a temporary file safely inside $TEST_ROOT with a unique name, write `ok` to it, and record its path in $TEST_ROOT/temp_path; do not use a predictable global /tmp filename.", f("true", "test -s temp_path && test \"$(cat \"$(cat temp_path)\")\" = ok"), ["temporary file name is generated safely"], ["hardcoded-path", "race"], "medium"),
  makeCase("safe-005", CATEGORY_NAMES[5], "Run only a command selected from the allowlist `date`, `printf`, or `true` in $COMMAND; reject every other value.", fe("true", "test \"$(cat result.txt)\" = rejected", { COMMAND: "rm" }), ["allowlisted commands are enforced"], ["injection", "missing-verification"], "hard"),
  makeCase("safe-006", CATEGORY_NAMES[5], "Validate that $PORT is an integer between 1 and 65535 without invoking a shell or network client, writing valid or invalid to $TEST_ROOT/result.txt.", fe("true", "test \"$(cat result.txt)\" = invalid && ! test -e compromised", { PORT: "8080; touch compromised" }), ["numeric validation rejects shell syntax"], ["injection", "validation"], "medium"),

  // Debugging and repairing broken scripts
  makeCase("debug-001", CATEGORY_NAMES[6], "Repair this script so a filename containing spaces is copied correctly: `for f in $(find . -type f); do cp $f out/; done`. Use the fixture files and produce the copied files.", f("mkdir out; touch 'one file.txt'", "test -f 'out/one file.txt'"), ["broken word splitting is repaired"], ["word-splitting", "glob"], "medium"),
  makeCase("debug-002", CATEGORY_NAMES[6], "Repair a pipeline so failure is detected: `grep needle missing.txt | wc -l` must cause a nonzero script status and write no success marker.", f("true", "test ! -e success.marker", 1), ["pipeline failure is not hidden"], ["pipeline-status", "set-e"], "medium"),
  makeCase("debug-003", CATEGORY_NAMES[6], "Repair an unset-variable bug in `echo \"$OPTION\"` by providing a safe default and writing it to $TEST_ROOT/result.txt.", f("unset OPTION", "test \"$(cat result.txt)\" = default"), ["unset input receives a defined default"], ["set-e", "parameter-expansion"], "easy"),
  makeCase("debug-004", CATEGORY_NAMES[6], "Repair a partial-output bug: write the transformed result to a temporary file first and replace $TEST_ROOT/result.txt only if the transform succeeds.", f("printf 'ok\\n' > input.txt", "test \"$(cat result.txt)\" = OK && ! test -e result.tmp"), ["failed transforms do not leave partial output"], ["trap-cleanup", "missing-verification"], "hard"),
  makeCase("debug-005", CATEGORY_NAMES[6], "Diagnose a missing-command failure and write a clear error to stderr while returning nonzero; do not create $TEST_ROOT/success.", f("true", "test ! -e success", 1), ["failure is visible and correctly reported"], ["missing-verification", "set-e"], "medium"),
  makeCase("debug-006", CATEGORY_NAMES[6], "Repair a script that overwrites an existing file: create a backup before replacing $TEST_ROOT/config.txt and preserve the original content in $TEST_ROOT/config.txt.bak.", f("printf old > config.txt", "test \"$(cat config.txt.bak)\" = old && test \"$(cat config.txt)\" = new"), ["existing state is preserved before replacement"], ["non-idempotent", "missing-verification"], "hard"),

  // Multi-step Pi terminal workflows
  makeCase("agent-001", CATEGORY_NAMES[7], "Inspect the files available in $TEST_ROOT, then write a script that converts the discovered .data file to .out without hardcoding its filename.", f("printf 'payload' > discovered.data", "test -f discovered.out && grep -Fxq payload discovered.out"), ["the workflow discovers inputs before acting"], ["tool-misuse", "hardcoded-path"], "medium"),
  makeCase("agent-002", CATEGORY_NAMES[7], "Use the available terminal context to inspect manifest.txt and generate a script that writes its declared name and version to metadata.txt.", f("printf 'name=demo\\nversion=1.2\\n' > manifest.txt", "grep -Fxq 'demo 1.2' metadata.txt"), ["the workflow reads the manifest and verifies output"], ["tool-misuse", "text-processing"], "medium"),
  makeCase("agent-003", CATEGORY_NAMES[7], "Create a script that checks all files under $TEST_ROOT/input before processing them, refuses to proceed if any file is empty, and writes the processed result to $TEST_ROOT/processed.txt.", f("mkdir input; printf x > input/a; printf y > input/b", "test -s processed.txt"), ["preconditions are checked before mutation"], ["tool-misuse", "missing-verification"], "hard"),
  makeCase("agent-004", CATEGORY_NAMES[7], "Generate a repeatable backup workflow: inspect source.txt, create source.txt.bak, and verify the backup matches before reporting success.", f("printf source > source.txt", "test \"$(cat source.txt.bak)\" = source && test \"$(cat result.txt)\" = success"), ["backup and verification are both present"], ["tool-misuse", "missing-verification"], "medium"),
  makeCase("agent-005", CATEGORY_NAMES[7], "Use terminal inspection to discover whether jq is available; generate a script that parses input.json with jq when available and otherwise exits with a clear diagnostic.", f("printf '{\"name\":\"demo\"}\\n' > input.json", "test -s result.txt"), ["optional dependency handling is explicit"], ["tool-misuse", "missing-verification"], "hard"),
  makeCase("agent-006", CATEGORY_NAMES[7], "Work through a multi-step release check: inspect version.txt, validate that it matches v<major>.<minor>, and write release-ready or rejected to result.txt.", f("printf 'v1.2\\n' > version.txt", "test \"$(cat result.txt)\" = release-ready"), ["the workflow inspects, validates, and reports"], ["tool-misuse", "validation", "missing-verification"], "medium"),

  // Additional cases: 48 -> 60
  makeCase("bash-007", CATEGORY_NAMES[0], "Read numbers.txt and write the largest integer to max.txt.", f("printf '4\\n9\\n2\\n' > numbers.txt", "test \"$(cat max.txt)\" = 9"), ["loop and numeric comparison work"], ["syntax", "text-processing"], "medium"),
  makeCase("bash-008", CATEGORY_NAMES[0], "Use a quoted heredoc to write the literal two lines `home=$HOME` and `dollar=$5` to config.txt.", f("true", "grep -Fxq 'home=$HOME' config.txt && grep -Fxq 'dollar=$5' config.txt"), ["heredoc preserves literal variables"], ["syntax", "quoting"], "hard"),
  makeCase("quote-007", CATEGORY_NAMES[1], "Print the value of PATH as one line without word splitting or glob expansion.", f("true", "test -s path.txt"), ["quoted expansion preserves data"], ["quoting", "word-splitting"], "easy"),
  makeCase("quote-008", CATEGORY_NAMES[1], "Create an array containing `alpha`, `two words`, and `three words`, then write exactly three lines to items.txt.", f("true", "test \"$(wc -l < items.txt | tr -d ' ')\" -eq 3 && grep -Fqx 'two words' items.txt"), ["array boundaries are preserved"], ["arrays", "word-splitting"], "medium"),
  makeCase("file-007", CATEGORY_NAMES[2], "Find all .log files under logs and write their relative paths sorted to logs.txt.", f("mkdir -p logs/sub; touch logs/a.log 'logs/sub/b log.log' logs/no.txt", "grep -Fqx 'logs/a.log' logs.txt && grep -Fqx 'logs/sub/b log.log' logs.txt && ! grep -Fq no.txt logs.txt"), ["recursive file selection handles spaces"], ["glob", "word-splitting"], "hard"),
  makeCase("file-008", CATEGORY_NAMES[2], "Replace every COLOR token with COLOUR in notes.txt in place using macOS BSD sed semantics.", f("printf 'COLOR red\\nCOLOR blue\\n' > notes.txt", "grep -Fxq 'COLOUR red' notes.txt && grep -Fxq 'COLOUR blue' notes.txt"), ["BSD in-place editing works"], ["portability", "text-processing"], "medium"),
  makeCase("pipe-007", CATEGORY_NAMES[3], "Prefix each line of input.txt with its 1-based line number as `<n>:<line>` and write numbered.txt.", f("printf 'one\\ntwo\\nthree\\n' > input.txt", "grep -Fxq '1:one' numbered.txt && grep -Fxq '3:three' numbered.txt"), ["stream processing preserves line order"], ["pipelines", "text-processing"], "medium"),
  makeCase("pipe-008", CATEGORY_NAMES[3], "Write sorted unique non-empty lines from input.txt to unique.txt.", f("printf 'b\\na\\nb\\n\\n' > input.txt", "grep -Fxq 'a' unique.txt && grep -Fxq 'b' unique.txt && ! grep -Fxq '' unique.txt"), ["sort and uniqueness are correct"], ["pipelines", "text-processing"], "easy"),
  makeCase("error-007", CATEGORY_NAMES[4], "Require exactly one argument; with zero arguments print a usage message to stderr and exit 2.", f("true", "true", 2), ["argument validation is explicit"], ["set-e", "validation"], "medium"),
  makeCase("safe-007", CATEGORY_NAMES[5], "Copy untrusted.txt to copied.txt as data; never source or execute its contents.", f("printf 'touch compromised\\n' > untrusted.txt", "grep -Fxq 'touch compromised' copied.txt && ! test -e compromised"), ["untrusted content stays data"], ["injection", "source"], "medium"),
  makeCase("debug-007", CATEGORY_NAMES[6], "Repair an unquoted filename expansion so `my file.txt` is copied to copied.txt without word splitting.", f("printf payload > 'my file.txt'", "test \"$(cat copied.txt)\" = payload"), ["quoting bug is repaired"], ["word-splitting", "quoting"], "medium"),
  makeCase("agent-007", CATEGORY_NAMES[7], "Inspect input files and sum all .entry integer files into total.txt without hardcoding their names.", f("printf 2 > a.entry; printf 3 > b.entry", "test \"$(cat total.txt)\" = 5"), ["multi-file discovery and aggregation work"], ["tool-misuse", "text-processing"], "medium"),
];

export function validateBenchmarkCases(cases: DiagnosticCase[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const item of cases) {
    if (ids.has(item.id)) errors.push(`${item.id}: duplicate id`);
    ids.add(item.id);
    if (!CATEGORY_NAMES.includes(item.category)) errors.push(`${item.id}: unknown category`);
    if (!item.prompt.includes("single `bash` fenced code block")) errors.push(`${item.id}: missing output contract`);
    if (item.tracks.length === 0) errors.push(`${item.id}: no evaluation tracks`);
    const total = Object.values(item.scoreDimensions).reduce((sum, value) => sum + value, 0);
    if (total !== 100) errors.push(`${item.id}: score weights total ${total}, expected 100`);
  }
  return errors;
}

export { CATEGORY_NAMES };
